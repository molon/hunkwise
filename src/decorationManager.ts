import * as vscode from 'vscode';
import * as path from 'path';
import { StateManager } from './stateManager';
import { computeHunks, hunkId } from './diffEngine';
import { log } from './log';

// ── Added lines ──────────────────────────────────────────────────────────────
const addedLineDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  isWholeLine: true,
});

// ── HTML helpers ─────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Deleted-lines inset ───────────────────────────────────────────────────────
function buildDeletedHtml(lines: string[], tabSize: number): string {
  const rows = lines.map(l => `<div class="line">${escapeHtml(l)}</div>`).join('');
  return `<!DOCTYPE html><html style="background:var(--vscode-diffEditor-removedLineBackground,rgba(255,0,0,0.1))"><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.1));
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: var(--vscode-editor-line-height, 1.5);
}
.line { white-space: pre; overflow: hidden; text-overflow: ellipsis; tab-size: ${tabSize}; }
</style>
</head><body>${rows}</body></html>`;
}

// ── Action-bar inset ──────────────────────────────────────────────────────────
// Static html — no per-hunk data. The target hunk is resolved from the inset
// entry at message time, so reused insets never reload their iframe.
function buildActionsHtml(): string {
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: visible; }
body { background: transparent; position: relative; }
.bar {
  position: absolute;
  top: 3px; left: 4px;
  display: flex; align-items: center; gap: 4px;
}
.nav {
  display: flex; align-items: center; gap: 6px;
  margin-left: 24px;
}
.btn-nav {
  min-width: 22px;
  justify-content: center;
  font-size: var(--vscode-editor-font-size, 13px);
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #cccccc);
}
.btn-nav:hover {
  background: var(--vscode-button-secondaryHoverBackground, #45494e);
  color: var(--vscode-button-foreground, #ffffff);
}
button {
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #cccccc);
  border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.4));
  border-radius: 2px;
  padding: 1px 6px;
  font-size: var(--vscode-editor-font-size, 13px);
  font-family: var(--vscode-font-family, sans-serif);
  line-height: normal;
  cursor: pointer;
  display: inline-flex; align-items: center; white-space: nowrap;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.btn-accept {
  background: #2a7d3a;
  color: #d4f0da;
  border-color: rgba(63,185,80,0.3);
}
.btn-accept:hover { background: #256b31; }
.btn-discard {
  background: rgba(248,81,73,0.08);
  color: #c97d7a;
  border-color: rgba(248,81,73,0.25);
}
.btn-discard:hover { background: rgba(248,81,73,0.15); }
</style>
</head><body>
<div class="bar">
<button class="btn-accept" onclick="accept()">✓ Accept</button>
<button class="btn-discard" onclick="discard()">↺ Discard</button>
<div class="nav">
<button class="btn-nav" title="Previous change" onclick="prev()">▲</button>
<button class="btn-nav" title="Next change" onclick="next()">▼</button>
</div>
</div>
<script>
const vscode = acquireVsCodeApi();
vscode.postMessage({ command: 'ready' });
function accept() { vscode.postMessage({ command: 'accept' }); }
function discard() { vscode.postMessage({ command: 'discard' }); }
function prev() { vscode.postMessage({ command: 'prev' }); }
function next() { vscode.postMessage({ command: 'next' }); }
</script>
</body></html>`;
}

interface HunkInset {
  inset: vscode.WebviewEditorInset;
  disposable: vscode.Disposable;
  disposeListener: vscode.Disposable;
  // Cache key: used to detect whether this inset can be reused
  cacheKey: string;
  // Last html assigned — reassigning webview.html reloads the iframe, so
  // assignment is skipped when unchanged.
  html: string;
  // Current target hunk; updated each refresh, read on webview messages.
  // Undefined for deleted-lines insets.
  hunkId?: string;
  disposed: boolean;
}

function insetCacheKey(afterLine: number, height: number): string {
  return `${afterLine}:${height}`;
}

export class DecorationManager {
  // editorKey → ordered list of insets for that editor
  private insets: Map<string, HunkInset[]> = new Map();
  private onAction: ((command: 'accept' | 'discard' | 'prev' | 'next', filePath: string, hunkId: string) => void) | undefined;

  constructor(
    private stateManager: StateManager,
    onAction?: (command: 'accept' | 'discard' | 'prev' | 'next', filePath: string, hunkId: string) => void,
  ) {
    this.onAction = onAction;
  }

  refresh(editors?: readonly vscode.TextEditor[]): void {
    const targets = editors ?? vscode.window.visibleTextEditors;
    const diffPaths = this.diffEditorFilePaths();
    for (const editor of targets) {
      this.applyToEditor(editor, diffPaths);
    }
  }

  refreshActionBar(_editor: vscode.TextEditor): void { /* buttons live in insets */ }

  private disposeInsetList(list: HunkInset[]): void {
    for (const h of list) {
      h.disposeListener.dispose();
      h.disposable.dispose();
      if (!h.disposed) h.inset.dispose();
    }
  }

  /**
   * Collect file paths that are open in any diff tab (git, hunkwise, etc.).
   */
  private diffEditorFilePaths(): Set<string> {
    const paths = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          paths.add(tab.input.modified.fsPath);
        }
      }
    }
    return paths;
  }

  private applyToEditor(editor: vscode.TextEditor, diffPaths: Set<string>): void {
    const filePath = editor.document.uri.fsPath;
    const editorKey = editor.document.uri.toString();
    const fileState = this.stateManager.getFile(filePath);

    // Skip insets: in diff editors (viewColumn undefined), or when user disabled inline decorations
    const isInDiff = editor.viewColumn === undefined && diffPaths.has(filePath);
    const skipInsets = isInDiff || !this.stateManager.showInlineDecorations;

    if (!fileState || fileState.status !== 'reviewing' || skipInsets) {
      this.disposeInsetList(this.insets.get(editorKey) ?? []);
      this.insets.delete(editorKey);
      editor.setDecorations(addedLineDecoration, []);
      return;
    }

    const addedRanges: vscode.Range[] = [];
    const tabSize = editor.options.tabSize as number || 4;
    const parsed = computeHunks(fileState.baseline, editor.document.getText());

    // Build the desired inset specs first
    interface InsetSpec {
      afterLine: number;
      height: number;
      html: string;
      hunkId?: string;
    }
    const specs: InsetSpec[] = [];

    for (const hunk of parsed) {
      const id = hunkId(hunk);


      for (let i = 0; i < hunk.newLines; i++) {
        const lineIdx = hunk.newStart - 1 + i;
        if (lineIdx < editor.document.lineCount) {
          addedRanges.push(editor.document.lineAt(lineIdx).range);
        }
      }

      // ── Inset placement strategy ──
      //
      // Layout order (top → bottom):
      //   [deleted inset]   red lines showing removed content
      //   [green lines]     added lines in the actual document
      //   [action bar]      Accept / Discard buttons
      //
      // ── afterLine semantics ──
      // createWebviewTextEditorInset takes a 0-based line number.
      // Internally VSCode does +1 before storing as afterLineNumber (1-based).
      // afterLineNumber=0 means "above line 1" (file top).
      // So to place an inset above line 1 we must pass afterLine = -1.
      //
      // Normal case (newLines > 0):
      //   deleted → afterLine = newStart - 2  (just above the green block)
      //   action  → afterLine = newStart + newLines - 2  (just below the green block)
      //   Different afterLines, so push order doesn't matter.
      //
      // Pure deletion (newLines == 0):
      //   Both deleted and action use afterLine = newStart - 2 (same value).
      //   VSCode stacks insets at the same afterLine with the FIRST-pushed on TOP.
      //   So we push deleted first, then action, to render deleted above action.

      const hasDeletion = hunk.removedContent.length > 0;
      const hasAddition = hunk.newLines > 0;

      // afterLine for deleted inset: just above the green block (or above its insertion point)
      const deletedAfterLine = hunk.newStart - 2; // may be -1 when newStart==1, that's correct

      let actionAfterLine: number;
      if (hasAddition) {
        actionAfterLine = hunk.newStart + hunk.newLines - 2;
      } else {
        // Pure deletion: no green block. Action bar shares the same afterLine as the
        // deleted inset. VSCode stacks insets at the same afterLine with the first-pushed
        // on top, so we rely on push order below to place deleted above action.
        actionAfterLine = deletedAfterLine;
      }

      // When multiple insets share the same afterLine, VSCode stacks them so that
      // the FIRST pushed inset appears TOPMOST.  For the normal case (deletion above
      // green lines, action below), they have different afterLines so push order
      // doesn't matter.  For pure deletion (same afterLine), we push deleted first,
      // then action, so deleted renders above action.

      if (hasDeletion) {
        specs.push({
          afterLine: Math.max(-1, deletedAfterLine),
          height: hunk.removedContent.length,
          html: buildDeletedHtml(hunk.removedContent, tabSize),
        });
      }
      specs.push({
        afterLine: actionAfterLine,
        height: 2,
        html: buildActionsHtml(),
        hunkId: id,
      });
    }

    // Reuse existing insets when cache keys match to avoid flicker.
    // Matched by position key, not array index, so removing one hunk doesn't
    // invalidate every inset after it.
    const existing = this.insets.get(editorKey) ?? [];
    const nextInsets: HunkInset[] = [];
    const perfStart = Date.now();
    let reusedCount = 0;
    let reloadedCount = 0;
    let createdCount = 0;
    let disposedCount = 0;

    // Pool existing insets by cache key. Order within a key is preserved:
    // insets sharing an afterLine stack first-created-on-top.
    const pool = new Map<string, HunkInset[]>();
    for (const prev of existing) {
      if (prev.disposed) {
        prev.disposeListener.dispose();
        prev.disposable.dispose();
        continue;
      }
      const list = pool.get(prev.cacheKey);
      if (list) { list.push(prev); } else { pool.set(prev.cacheKey, [prev]); }
    }

    // Create viewport-visible insets first so their webviews render before
    // offscreen ones. Stable order within equal visibility preserves the
    // same-afterLine stacking order.
    const VISIBLE_MARGIN = 30;
    const visibleRanges = editor.visibleRanges;
    const isVisible = (line: number) => visibleRanges.some(
      r => line >= r.start.line - VISIBLE_MARGIN && line <= r.end.line + VISIBLE_MARGIN
    );
    const order = specs.map((_, i) => i).sort((a, b) =>
      Number(isVisible(specs[b].afterLine)) - Number(isVisible(specs[a].afterLine)) || a - b
    );

    for (const idx of order) {
      const spec = specs[idx];
      const key = insetCacheKey(spec.afterLine, spec.height);
      const prev = pool.get(key)?.shift();
      if (prev) {
        // Reuse; reassign html only when changed (assignment reloads the iframe)
        if (prev.html !== spec.html) {
          prev.inset.webview.html = spec.html;
          prev.html = spec.html;
          reloadedCount++;
        }
        prev.hunkId = spec.hunkId;
        nextInsets.push(prev);
        reusedCount++;
      } else {
        // Position changed or inset was disposed by VSCode — recreate
        const created = this.makeInset(editorKey, editor, spec.afterLine, spec.height, spec.html, key, spec.hunkId);
        if (created) nextInsets.push(created);
        createdCount++;
      }
    }

    // Dispose leftover insets not reused
    for (const list of pool.values()) {
      for (const leftover of list) {
        leftover.disposeListener.dispose();
        leftover.disposable.dispose();
        if (!leftover.disposed) leftover.inset.dispose();
        disposedCount++;
      }
    }

    if (specs.length > 0 || disposedCount > 0) {
      log(`PERF_MEASURE refresh(${path.basename(filePath)}): hunks=${parsed.length} insets reused=${reusedCount} reloaded=${reloadedCount} created=${createdCount} disposed=${disposedCount} sync=${Date.now() - perfStart}ms`);
    }

    editor.setDecorations(addedLineDecoration, addedRanges);
    if (nextInsets.length > 0) {
      this.insets.set(editorKey, nextInsets);
    } else {
      this.insets.delete(editorKey);
    }
  }

  private makeInset(
    editorKey: string,
    editor: vscode.TextEditor,
    afterLine: number,
    height: number,
    html: string,
    cacheKey: string,
    hunkId?: string,
  ): HunkInset | undefined {
    try {
      const inset = (vscode.window as any).createWebviewTextEditorInset(
        editor, afterLine, height, { enableScripts: true }
      ) as vscode.WebviewEditorInset;
      inset.webview.html = html;
      const filePath = editor.document.uri.fsPath;
      const disposable = inset.webview.onDidReceiveMessage((msg: any) => {
        if (msg.command === 'ready') {
          // Sent on every webview load/reload
          log(`PERF_MEASURE ready(${entry.hunkId}): action bar rendered`);
          return;
        }
        if (msg.command === 'accept' || msg.command === 'discard' || msg.command === 'prev' || msg.command === 'next') {
          if (entry.hunkId !== undefined) {
            this.onAction?.(msg.command, filePath, entry.hunkId);
          }
        }
      });
      const entry: HunkInset = {
        inset, disposable, cacheKey, html, hunkId, disposed: false,
        disposeListener: inset.onDidDispose(() => {
          entry.disposed = true;
          // Re-apply if editor is still visible so insets are immediately rebuilt
          const targetEditor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === editorKey
          );
          if (targetEditor) this.applyToEditor(targetEditor, this.diffEditorFilePaths());
        }),
      };
      return entry;
    } catch (err) {
      log(`createWebviewTextEditorInset failed: ${err}`);
      return undefined;
    }
  }

  dispose(): void {
    addedLineDecoration.dispose();
    for (const list of this.insets.values()) {
      this.disposeInsetList(list);
    }
    this.insets.clear();
  }
}
