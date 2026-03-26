import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { ReviewPanel } from './reviewPanel';
import { computeHunks, hunkId } from './diffEngine';
import { upsertGitignore } from './gitignoreManager';
import { log } from './log';

export function registerCommands(
  context: vscode.ExtensionContext,
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  reviewPanel: ReviewPanel,
  onStateChanged: () => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('hunkwise.enable', () =>
      enableHunkwise(stateManager, fileWatcher, reviewPanel, onStateChanged)
    ),
    vscode.commands.registerCommand('hunkwise.disable', () =>
      disableHunkwise(stateManager, onStateChanged)
    ),
    vscode.commands.registerCommand('hunkwise.setIgnorePatterns', async (patterns: string[]) => {
      stateManager.setIgnorePatterns(patterns);
      onStateChanged();
      await stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      onStateChanged();
    }),
    vscode.commands.registerCommand('hunkwise.setRespectGitignore', async (value: boolean) => {
      stateManager.setRespectGitignore(value);
      onStateChanged();
      await stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      onStateChanged();
    }),
    vscode.commands.registerCommand('hunkwise.setClearOnBranchSwitch', (value: boolean) => {
      stateManager.setClearOnBranchSwitch(value);
    }),
    vscode.commands.registerCommand('hunkwise.clearHunks', async () => {
      await stateManager.clearHunksOnBranchSwitch(
        (fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)
      );
      onStateChanged();
    }),
  );
}

async function enableHunkwise(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  reviewPanel: ReviewPanel,
  onStateChanged: () => void
): Promise<void> {
  log('enable');
  reviewPanel.setLoading(true);
  try {
    await Promise.all([
      new Promise(resolve => setTimeout(resolve, 750)),
      (async () => {
        await stateManager.setEnabled(true);
        try { upsertGitignore(); } catch (err) { log(`upsertGitignore failed: ${err}`); }
        await stateManager.snapshotWorkspace((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      })(),
    ]);
  } finally {
    reviewPanel.setLoading(false);
  }
  onStateChanged();
}

async function disableHunkwise(
  stateManager: StateManager,
  onStateChanged: () => void
): Promise<void> {
  log('disable');
  stateManager.setEnabled(false);
  onStateChanged();
}

export async function acceptAllFiles(
  stateManager: StateManager,
  onStateChanged: () => void
): Promise<void> {
  for (const filePath of Array.from(stateManager.getAllFiles().keys())) {
    acceptFileByPath(stateManager, filePath, () => {});
  }
  onStateChanged();
}

export async function discardAllFiles(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  onStateChanged: () => void
): Promise<void> {
  for (const [filePath] of Array.from(stateManager.getAllFiles().entries())) {
    try {
      await discardFileByPath(stateManager, fileWatcher, filePath, () => {});
    } catch (err) { log(`discardAllFiles: failed to restore ${filePath}: ${err}`); }
  }
  onStateChanged();
}

export function acceptFileByPath(
  stateManager: StateManager,
  filePath: string,
  onStateChanged: () => void
): void {
  if (!stateManager.getFile(filePath)) return;
  const basename = path.basename(filePath);
  if (!fs.existsSync(filePath)) {
    // File was deleted — remove from tracking entirely
    log(`acceptFileByPath(${basename}): file not on disk, removeFile`);
    stateManager.removeFile(filePath);
  } else {
    // File exists (possibly empty) — accept current content as new baseline
    const content = fs.readFileSync(filePath, 'utf-8');
    log(`acceptFileByPath(${basename}): file exists, exitReviewing with content.len=${content.length}`);
    stateManager.exitReviewing(filePath, content);
  }
  onStateChanged();
}

export async function discardFileByPath(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  filePath: string,
  onStateChanged: () => void
): Promise<void> {
  const fileState = stateManager.getFile(filePath);
  if (!fileState) return;

  fileWatcher.markSelfEdit(filePath);
  try {
    if (fileState.baseline === '') {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } else if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, fileState.baseline, 'utf-8');
      await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    } else {
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      );
      edit.replace(uri, fullRange, fileState.baseline);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    }
  } finally {
    fileWatcher.clearSelfEdit(filePath);
  }
  if (fileState.baseline === '') {
    // Discarding a new file means it was deleted — remove from tracking
    stateManager.removeFile(filePath);
  } else {
    stateManager.exitReviewing(filePath);
  }
  onStateChanged();
}


export function acceptHunk(
  stateManager: StateManager,
  filePath: string,
  id: string,
  onStateChanged: () => void,
  source: string = 'unknown'
): void {
  const basename = path.basename(filePath);
  log(`acceptHunk(${basename}): hunkId=${id}, source=${source}`);

  const fileState = stateManager.getFile(filePath);
  if (!fileState) { log(`acceptHunk(${basename}): no fileState, skip`); return; }

  const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === filePath);
  if (!doc) { log(`acceptHunk(${basename}): no doc found, skip`); return; }
  log(`acceptHunk(${basename}): doc.scheme=${doc.uri.scheme}, doc.len=${doc.getText().length}, baseline.len=${fileState.baseline.length}`);

  const hunks = computeHunks(fileState.baseline, doc.getText());
  log(`acceptHunk(${basename}): total hunks=${hunks.length}`);
  const hunk = hunks.find(h => hunkId(h) === id);
  if (!hunk) { log(`acceptHunk(${basename}): hunk not found, skip`); return; }

  const originalNewStart = hunk.newStart;

  const currentLines = doc.getText().split('\n');
  const baselineLines = fileState.baseline.split('\n');
  const newBaseline = [
    ...baselineLines.slice(0, hunk.oldStart - 1),
    ...currentLines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newLines),
    ...baselineLines.slice(hunk.oldStart - 1 + hunk.oldLines),
  ].join('\n');

  fileState.baseline = newBaseline;
  const remainingHunks = computeHunks(newBaseline, doc.getText());
  log(`acceptHunk(${basename}): remainingHunks=${remainingHunks.length}`);
  if (remainingHunks.length === 0) {
    log(`acceptHunk(${basename}): last hunk, exitReviewing`);
    stateManager.exitReviewing(filePath, doc.getText());
  } else {
    stateManager.setFile(filePath, fileState);
    revealNextHunk(filePath, remainingHunks, originalNewStart);
  }
  onStateChanged();
  log(`acceptHunk(${basename}): done`);
}

/** Reveal the next hunk in the editor after an accept/discard operation. */
function revealNextHunk(filePath: string, remainingHunks: ReturnType<typeof computeHunks>, originalNewStart: number): void {
  const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === filePath);
  if (!editor) return;

  // Find the first remaining hunk at or after the original position
  const next = remainingHunks.find(h => h.newStart >= originalNewStart) ?? remainingHunks[0];
  if (!next) return;

  const pos = new vscode.Position(Math.max(0, next.newStart - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

export async function discardHunk(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  filePath: string,
  id: string,
  onStateChanged: () => void,
  source: string = 'unknown'
): Promise<void> {
  const basename = path.basename(filePath);
  log(`discardHunk(${basename}): hunkId=${id}, source=${source}`);

  const fileState = stateManager.getFile(filePath);
  if (!fileState) { log(`discardHunk(${basename}): no fileState, skip`); return; }

  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);

  const allHunks = computeHunks(fileState.baseline, doc.getText());
  log(`discardHunk(${basename}): total hunks=${allHunks.length}`);
  const hunk = allHunks.find(h => hunkId(h) === id);
  if (!hunk) { log(`discardHunk(${basename}): hunk not found, skip`); return; }

  const originalNewStart = hunk.newStart;

  const baselineLines = fileState.baseline.split('\n');
  const originalLines = baselineLines.slice(hunk.oldStart - 1, hunk.oldStart - 1 + hunk.oldLines);

  const startPos = new vscode.Position(hunk.newStart - 1, 0);
  let endPos: vscode.Position;
  if (hunk.newLines === 0) {
    endPos = startPos;
  } else {
    const lastNewLine = hunk.newStart - 1 + hunk.newLines - 1;
    endPos = lastNewLine < doc.lineCount - 1
      ? new vscode.Position(lastNewLine + 1, 0)
      : new vscode.Position(lastNewLine, doc.lineAt(lastNewLine).text.length);
  }

  const replacement = originalLines.length > 0 ? originalLines.join('\n') + '\n' : '';
  log(`discardHunk(${basename}): replacing lines ${startPos.line}-${endPos.line} with ${originalLines.length} original lines`);

  fileWatcher.markSelfEdit(filePath);
  try {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(startPos, endPos), replacement);
    const applied = await vscode.workspace.applyEdit(edit);
    log(`discardHunk(${basename}): applyEdit=${applied}`);
    if (!applied) {
      log(`discardHunk(${basename}): applyEdit failed, aborting`);
      return;
    }
    const saved = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === filePath);
    if (saved) await saved.save();
    log(`discardHunk(${basename}): saved, doc.scheme=${saved?.uri.scheme ?? 'N/A'}, doc.len=${saved?.getText().length ?? 'N/A'}`);
    const remainingHunks = computeHunks(fileState.baseline, saved?.getText() ?? doc.getText());
    log(`discardHunk(${basename}): remainingHunks=${remainingHunks.length}`);
    if (remainingHunks.length === 0) {
      log(`discardHunk(${basename}): no hunks left, exitReviewing`);
      stateManager.exitReviewing(filePath);
    } else {
      revealNextHunk(filePath, remainingHunks, originalNewStart);
    }
    onStateChanged();
    log(`discardHunk(${basename}): done`);
  } finally {
    fileWatcher.clearSelfEdit(filePath);
  }
}

