import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { computeHunks, hunkId } from './diffEngine';
import { log } from './log';

import {
  acceptAllFiles,
  discardAllFiles,
  acceptFileByPath,
  discardFileByPath,
  acceptHunk,
  discardHunk,
} from './commands';

interface PanelState {
  enabled: boolean;
  ignorePatterns: string[];
  respectGitignore: boolean;
  clearOnBranchSwitch: boolean;
  quoteRotationInterval: number;
  useDiffEditor: boolean;
  showInlineDecorations: boolean;
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
  files: PanelFile[];
}

interface PanelFile {
  filePath: string;
  fileName: string;
  dirName: string;
  addedLines: number;
  removedLines: number;
  pendingCount: number;
  isNew: boolean;
  isDeleted: boolean;
  hunks: PanelHunk[];
}

interface PanelHunk {
  id: string;
  filePath: string;
  newStart: number;
  newLines: number;
  oldLines: number;
}

export class ReviewPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private _loading: boolean = false;

  get loading(): boolean { return this._loading; }

  constructor(
    private context: vscode.ExtensionContext,
    private stateManager: StateManager,
    private fileWatcher: FileWatcher,
    private onStateChanged: () => void,
    private onBaselineChanged?: (filePath: string) => void,
    private onAfterHunkAction?: () => Promise<void>
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'ready') {
        if (this._loading) {
          this.view?.webview.postMessage({ type: 'loading', loading: true });
        } else {
          this.refresh();
        }
        return;
      }
      this.handleMessage(msg);
    });
  }

  refresh(): void {
    if (!this.view || this._loading) return;
    const state = this.buildPanelState();
    this.view.webview.postMessage({ type: 'update', state });
  }

  setLoading(loading: boolean): void {
    this._loading = loading;
    if (!this.view) return;
    if (loading) {
      this.view.webview.postMessage({ type: 'loading', loading: true });
    } else {
      // Send the real state immediately so there's no flash of the disabled screen
      const state = this.buildPanelState();
      this.view.webview.postMessage({ type: 'update', state });
    }
  }

  openSettings(): void {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'openSettings' });
  }

  private buildPanelState(): PanelState {
    const files: PanelFile[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const [filePath, fileState] of this.stateManager.getAllFiles()) {
      if (fileState.status !== 'reviewing') continue;

      const fileExists = fs.existsSync(filePath);
      let currentContent: string;
      if (!fileExists) {
        currentContent = '';
      } else {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        currentContent = doc ? doc.getText() : '';
        if (!doc) {
          try { currentContent = fs.readFileSync(filePath, 'utf-8'); } catch { currentContent = ''; }
        }
      }

      const pendingHunks = computeHunks(fileState.baseline, currentContent);
      const isNew = fileState.baseline === null;
      const isDeleted = !fileExists && fileState.baseline !== null;
      // Show 0-hunk entries for new files (null baseline, e.g. new empty file)
      // and deleted files (file missing from disk) so accept/discard remain available.
      if (pendingHunks.length === 0 && !isNew && !isDeleted) continue;

      const addedLines = pendingHunks.reduce((s, h) => s + h.newLines, 0);
      const removedLines = pendingHunks.reduce((s, h) => s + h.oldLines, 0);
      totalAdded += addedLines;
      totalRemoved += removedLines;

      const workspaceFolders = vscode.workspace.workspaceFolders;
      const rootPath = workspaceFolders?.[0]?.uri.fsPath ?? '';
      const relPath = path.relative(rootPath, filePath);
      const fileName = path.basename(filePath);
      const dirName = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);

      files.push({
        filePath,
        fileName,
        dirName,
        addedLines,
        removedLines,
        pendingCount: pendingHunks.length,
        isNew,
        isDeleted,
        hunks: pendingHunks.map(h => ({
          id: hunkId(h),
          filePath,
          newStart: h.newStart,
          newLines: h.newLines,
          oldLines: h.oldLines,
        })),
      });
    }

    files.sort((a, b) => a.filePath.localeCompare(b.filePath));

    return {
      enabled: this.stateManager.enabled,
      ignorePatterns: this.stateManager.ignorePatterns,
      respectGitignore: this.stateManager.respectGitignore,
      clearOnBranchSwitch: this.stateManager.clearOnBranchSwitch,
      quoteRotationInterval: this.stateManager.quoteRotationInterval,
      useDiffEditor: this.stateManager.useDiffEditor,
      showInlineDecorations: this.stateManager.showInlineDecorations,
      totalFiles: files.length,
      totalAdded,
      totalRemoved,
      files,
    };
  }

  private async handleMessage(msg: {
    command: string;
    filePath?: string;
    hunkId?: string;
    folders?: string[];
    value?: boolean;
  }): Promise<void> {
    switch (msg.command) {
      case 'enable':
        await vscode.commands.executeCommand('hunkwise.enable');
        break;
      case 'disable':
        await vscode.commands.executeCommand('hunkwise.disable');
        break;
      case 'setIgnorePatterns':
        if (msg.folders !== undefined) {
          await vscode.commands.executeCommand('hunkwise.setIgnorePatterns', msg.folders);
        }
        break;
      case 'setRespectGitignore':
        if (msg.value !== undefined) {
          await vscode.commands.executeCommand('hunkwise.setRespectGitignore', msg.value);
        }
        break;
      case 'setClearOnBranchSwitch':
        if (msg.value !== undefined) {
          this.stateManager.setClearOnBranchSwitch(msg.value);
        }
        break;
      case 'setQuoteRotationInterval': {
        const interval = Number(msg.value);
        if (Number.isFinite(interval) && interval >= 0) {
          this.stateManager.setQuoteRotationInterval(interval);
          this.refresh();
        }
        break;
      }
      case 'acceptAll':
        await acceptAllFiles(this.stateManager, this.onStateChanged);
        break;
      case 'discardAll':
        await discardAllFiles(this.stateManager, this.fileWatcher, this.onStateChanged);
        break;
      case 'acceptFile':
        if (msg.filePath) {
          acceptFileByPath(this.stateManager, msg.filePath, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          });
        }
        break;
      case 'discardFile':
        if (msg.filePath) {
          await discardFileByPath(this.stateManager, this.fileWatcher, msg.filePath, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          });
        }
        break;
      case 'acceptHunk':
        if (msg.filePath && msg.hunkId) {
          acceptHunk(this.stateManager, msg.filePath, msg.hunkId, () => {
            this.onStateChanged();
            this.onBaselineChanged?.(msg.filePath!);
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          }, 'panel');
        }
        break;
      case 'discardHunk':
        if (msg.filePath && msg.hunkId) {
          await discardHunk(this.stateManager, this.fileWatcher, msg.filePath, msg.hunkId, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          }, 'panel');
        }
        break;
      case 'setUseDiffEditor':
        if (msg.value !== undefined) {
          this.stateManager.setUseDiffEditor(msg.value as boolean);
        }
        break;
      case 'setShowInlineDecorations':
        if (msg.value !== undefined) {
          this.stateManager.setShowInlineDecorations(msg.value as boolean);
          this.onStateChanged();
        }
        break;
      case 'openFile':
        if (msg.filePath) {
          log(`openFile(${path.basename(msg.filePath)}): opening in ${this.stateManager.useDiffEditor ? 'diffEditor' : 'normalEditor'}`);
          if (this.stateManager.useDiffEditor) {
            await this.openDiffEditor(msg.filePath);
          } else {
            const fileState = this.stateManager.getFile(msg.filePath);
            const doc = await vscode.window.showTextDocument(vscode.Uri.file(msg.filePath));
            if (fileState) {
              const hunks = computeHunks(fileState.baseline, doc.document.getText());
              if (hunks.length > 0) {
                const pos = new vscode.Position(Math.max(0, hunks[0].newStart - 1), 0);
                doc.selection = new vscode.Selection(pos, pos);
                doc.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
              }
            }
          }
        }
        break;
      case 'openDeletedDiff':
        if (msg.filePath) {
          const fileName = path.basename(msg.filePath);
          const baselineUri = vscode.Uri.from({ scheme: 'hunkwise-baseline', path: msg.filePath });
          const emptyUri = vscode.Uri.from({ scheme: 'untitled', path: msg.filePath + '.deleted' });
          await vscode.commands.executeCommand('vscode.diff', baselineUri, emptyUri, `${fileName} (deleted)`);
        }
        break;
      case 'jumpToHunk':
        if (msg.filePath && msg.hunkId) {
          log(`jumpToHunk(${path.basename(msg.filePath)}): hunkId=${msg.hunkId}, opening in ${this.stateManager.useDiffEditor ? 'diffEditor' : 'normalEditor'}`);
          if (this.stateManager.useDiffEditor) {
            await this.openDiffEditor(msg.filePath, msg.hunkId);
          } else {
            const fileState = this.stateManager.getFile(msg.filePath);
            if (fileState) {
              const doc = await vscode.window.showTextDocument(vscode.Uri.file(msg.filePath));
              const hunk = computeHunks(fileState.baseline, doc.document.getText())
                .find(h => hunkId(h) === msg.hunkId);
              if (hunk) {
                const pos = new vscode.Position(Math.max(0, hunk.newStart - 1), 0);
                doc.selection = new vscode.Selection(pos, pos);
                doc.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
              }
            }
          }
        }
        break;
    }
  }

  private async openDiffEditor(filePath: string, targetHunkId?: string): Promise<void> {
    const fileName = path.basename(filePath);
    const baselineUri = vscode.Uri.from({ scheme: 'hunkwise-baseline', path: filePath });
    const currentUri = vscode.Uri.file(filePath);

    await vscode.commands.executeCommand('vscode.diff', baselineUri, currentUri, `${fileName} (hunkwise)`);

    // Jump to the target hunk position in the diff editor's modified side.
    // Prefer the embedded editor (viewColumn undefined) over a normal editor for the same file.
    const fileState = this.stateManager.getFile(filePath);
    const candidates = vscode.window.visibleTextEditors.filter(
      e => e.document.uri.scheme === 'file' && e.document.uri.fsPath === filePath
    );
    const editor = candidates.find(e => e.viewColumn === undefined) ?? candidates[0];
    if (fileState && editor) {
      const hunks = computeHunks(fileState.baseline, editor.document.getText());
      const target = targetHunkId
        ? hunks.find(h => hunkId(h) === targetHunkId)
        : hunks[0];
      if (target) {
        const pos = new vscode.Position(Math.max(0, target.newStart - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaPath = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'panel.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'panel.js'));
    let html = fs.readFileSync(
      path.join(this.context.extensionUri.fsPath, 'media', 'panel.html'),
      'utf-8'
    );
    html = html.replace(/\{\{cssUri\}\}/g, cssUri.toString());
    html = html.replace(/\{\{jsUri\}\}/g, jsUri.toString());
    html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
    return html;
  }
}
