import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) throw new Error('No workspace folder');
  return folders[0].uri.fsPath;
}

export function hunkwiseGitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: path.join(root, '.vscode', 'hunkwise', 'git'),
    GIT_WORK_TREE: root,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function gitListTracked(root: string): string[] {
  try {
    const out = execSync('git ls-tree HEAD --name-only -r', {
      cwd: root,
      env: hunkwiseGitEnv(root),
      encoding: 'utf-8',
    });
    return out.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function gitGetBaseline(root: string, relPath: string): string | undefined {
  try {
    return execSync(`git show ":${relPath}"`, {
      cwd: root,
      env: hunkwiseGitEnv(root),
      encoding: 'utf-8',
    });
  } catch {
    return undefined;
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForCondition(fn: () => boolean, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error('Condition not met within timeout');
}

export async function enableHunkwise(): Promise<void> {
  await vscode.commands.executeCommand('hunkwise.enable');
  const root = getWorkspaceRoot();
  const gitDir = path.join(root, '.vscode', 'hunkwise', 'git');
  await waitForCondition(() => fs.existsSync(gitDir));
  await sleep(200);
}

export async function disableHunkwise(): Promise<void> {
  await vscode.commands.executeCommand('hunkwise.disable');
  await sleep(100);
}

export function writeFileExternally(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export async function writeFileViaVSCode(filePath: string, content: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const uri = vscode.Uri.file(filePath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

export async function renameFileViaVSCode(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(oldUri, newUri);
  const success = await vscode.workspace.applyEdit(edit);
  if (!success) throw new Error(`Failed to rename ${oldUri.fsPath} → ${newUri.fsPath}`);
}

export async function deleteFileViaVSCode(uri: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.deleteFile(uri);
  const success = await vscode.workspace.applyEdit(edit);
  if (!success) throw new Error(`Failed to delete ${uri.fsPath}`);
}

export function cleanWorkspace(): void {
  const root = getWorkspaceRoot();
  for (const entry of fs.readdirSync(root)) {
    if (entry === '.vscode' || entry === '.gitkeep') continue;
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  const hunkwiseDir = path.join(root, '.vscode', 'hunkwise');
  if (fs.existsSync(hunkwiseDir)) {
    fs.rmSync(hunkwiseDir, { recursive: true, force: true });
  }
}

export function getReviewPanel(): any {
  const ext = vscode.extensions.getExtension('molon.hunkwise');
  if (!ext || !ext.isActive) return undefined;
  const api = ext.exports;
  if (api && typeof api.getReviewPanel === 'function') {
    return api.getReviewPanel();
  }
  return undefined;
}

export function getStateManager(): any {
  const ext = vscode.extensions.getExtension('molon.hunkwise');
  if (!ext || !ext.isActive) return undefined;
  const api = ext.exports;
  if (api && typeof api.getStateManager === 'function') {
    return api.getStateManager();
  }
  return undefined;
}
