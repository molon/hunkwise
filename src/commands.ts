import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { ReviewPanel } from './reviewPanel';
import { computeHunks, hunkId } from './diffEngine';
import { upsertGitignore } from './gitignoreManager';

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
      await stateManager.syncIgnoreState(fp => fileWatcher.shouldIgnore(fp));
      onStateChanged();
    }),
    vscode.commands.registerCommand('hunkwise.setRespectGitignore', async (value: boolean) => {
      stateManager.setRespectGitignore(value);
      onStateChanged();
      await stateManager.syncIgnoreState(fp => fileWatcher.shouldIgnore(fp));
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
  reviewPanel.setLoading(true);
  try {
    await Promise.all([
      new Promise(resolve => setTimeout(resolve, 750)),
      (async () => {
        await stateManager.setEnabled(true);
        try { upsertGitignore(); } catch { /* non-fatal */ }
        await stateManager.snapshotWorkspace(fp => fileWatcher.shouldIgnore(fp));
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
  stateManager.setEnabled(false);
  onStateChanged();
}

export async function acceptAllFiles(
  stateManager: StateManager,
  onStateChanged: () => void
): Promise<void> {
  for (const filePath of Array.from(stateManager.getAllFiles().keys())) {
    stateManager.removeFile(filePath);
  }
  onStateChanged();
}

export async function discardAllFiles(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  onStateChanged: () => void
): Promise<void> {
  for (const [filePath, fileState] of Array.from(stateManager.getAllFiles().entries())) {
    const uri = vscode.Uri.file(filePath);
    fileWatcher.markSelfEdit(filePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      );
      edit.replace(uri, fullRange, fileState.baseline);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
      stateManager.removeFile(filePath);
    } catch { /* skip files that can't be opened */ } finally {
      fileWatcher.clearSelfEdit(filePath);
    }
  }
  onStateChanged();
}

export function acceptFileByPath(
  stateManager: StateManager,
  filePath: string,
  onStateChanged: () => void
): void {
  if (!stateManager.getFile(filePath)) return;
  stateManager.removeFile(filePath);
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
  stateManager.removeFile(filePath);
  onStateChanged();
}


export function acceptHunk(
  stateManager: StateManager,
  filePath: string,
  id: string,
  onStateChanged: () => void
): void {
  const fileState = stateManager.getFile(filePath);
  if (!fileState) return;

  const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
  if (!doc) return;

  const hunk = computeHunks(fileState.baseline, doc.getText()).find(h => hunkId(h) === id);
  if (!hunk) return;

  const currentLines = doc.getText().split('\n');
  const baselineLines = fileState.baseline.split('\n');
  const newBaseline = [
    ...baselineLines.slice(0, hunk.oldStart - 1),
    ...currentLines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newLines),
    ...baselineLines.slice(hunk.oldStart - 1 + hunk.oldLines),
  ].join('\n');

  fileState.baseline = newBaseline;
  stateManager.setFile(filePath, fileState);
  if (computeHunks(newBaseline, doc.getText()).length === 0) {
    stateManager.removeFile(filePath);
  }
  onStateChanged();
}

export async function discardHunk(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  filePath: string,
  id: string,
  onStateChanged: () => void
): Promise<void> {
  const fileState = stateManager.getFile(filePath);
  if (!fileState) return;

  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);

  const hunk = computeHunks(fileState.baseline, doc.getText()).find(h => hunkId(h) === id);
  if (!hunk) return;

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

  fileWatcher.markSelfEdit(filePath);
  try {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(startPos, endPos), replacement);
    await vscode.workspace.applyEdit(edit);
    const saved = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
    if (saved) await saved.save();
    if (computeHunks(fileState.baseline, saved?.getText() ?? doc.getText()).length === 0) {
      stateManager.removeFile(filePath);
    }
    onStateChanged();
  } finally {
    fileWatcher.clearSelfEdit(filePath);
  }
}

