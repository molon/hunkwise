import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import { execSync } from 'child_process';

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) throw new Error('No workspace folder');
  return folders[0].uri.fsPath;
}

function hunkwiseGitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: path.join(root, '.vscode', 'hunkwise', 'git'),
    GIT_WORK_TREE: root,
    GIT_TERMINAL_PROMPT: '0',
  };
}

function gitListTracked(root: string): string[] {
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

function gitGetBaseline(root: string, relPath: string): string | undefined {
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

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCondition(fn: () => boolean, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error('Condition not met within timeout');
}

async function enableHunkwise(): Promise<void> {
  await vscode.commands.executeCommand('hunkwise.enable');
  const root = getWorkspaceRoot();
  const gitDir = path.join(root, '.vscode', 'hunkwise', 'git');
  await waitForCondition(() => fs.existsSync(gitDir));
  await sleep(500);
}

async function disableHunkwise(): Promise<void> {
  await vscode.commands.executeCommand('hunkwise.disable');
  await sleep(300);
}

/**
 * Write a file externally (simulating an AI tool) so FileWatcher treats it
 * as an external change that triggers review mode.
 */
function writeFileExternally(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Rename a file using VSCode workspace edit — this triggers
 * onWillRenameFiles / onDidRenameFiles just like the explorer does.
 */
async function renameFileViaVSCode(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(oldUri, newUri);
  const success = await vscode.workspace.applyEdit(edit);
  if (!success) throw new Error(`Failed to rename ${oldUri.fsPath} → ${newUri.fsPath}`);
}

/**
 * Delete a file using VSCode workspace edit — this triggers
 * onWillDeleteFiles / onDidDeleteFiles just like the explorer does.
 */
async function deleteFileViaVSCode(uri: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.deleteFile(uri);
  const success = await vscode.workspace.applyEdit(edit);
  if (!success) throw new Error(`Failed to delete ${uri.fsPath}`);
}

function cleanWorkspace(): void {
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

// ── Test suite ────────────────────────────────────────────────────────────────

suite('hunkwise rename integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('rename a new file preserves tracking under new path', async () => {
    const root = getWorkspaceRoot();
    await enableHunkwise();

    // Externally create a new file → triggers review with baseline=''
    const oldPath = path.join(root, 'new-file.txt');
    writeFileExternally(oldPath, 'new file content\n');
    await sleep(1500);

    const oldRel = path.relative(root, oldPath);
    await waitForCondition(() => gitListTracked(root).includes(oldRel), 5000);

    // Rename via VSCode API
    const newPath = path.join(root, 'new-file-renamed.txt');
    const newRel = path.relative(root, newPath);
    await renameFileViaVSCode(vscode.Uri.file(oldPath), vscode.Uri.file(newPath));
    await sleep(1500);

    // Verify: new path is tracked, old path is not
    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(oldRel), `Old path "${oldRel}" should not be tracked`);
    assert.ok(tracked.includes(newRel), `New path "${newRel}" should be tracked`);

    // Verify: baseline content is preserved (empty for new file)
    const baseline = gitGetBaseline(root, newRel);
    assert.strictEqual(baseline, '', 'Baseline should be empty for new file');

    // Verify: file exists on disk at new path
    assert.ok(fs.existsSync(newPath), 'File should exist at new path');
    assert.ok(!fs.existsSync(oldPath), 'File should not exist at old path');
  });

  test('rename a reviewing file preserves baseline under new path', async () => {
    const root = getWorkspaceRoot();
    await enableHunkwise();

    // Create a file that will be snapshotted as baseline
    const filePath = path.join(root, 'reviewing-file.txt');
    writeFileExternally(filePath, 'original content\n');
    await sleep(1500);

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);
    const baselineBefore = gitGetBaseline(root, rel)!;

    // Externally modify the file → triggers review mode
    writeFileExternally(filePath, 'original content\nmodified line\n');
    await sleep(1500);

    // Rename via VSCode API while in reviewing state
    const newPath = path.join(root, 'reviewing-file-renamed.txt');
    const newRel = path.relative(root, newPath);
    await renameFileViaVSCode(vscode.Uri.file(filePath), vscode.Uri.file(newPath));
    await sleep(1500);

    // Verify: new path is tracked, old path is not
    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(rel), `Old path "${rel}" should not be tracked`);
    assert.ok(tracked.includes(newRel), `New path "${newRel}" should be tracked`);

    // Verify: baseline content is preserved (the original, not the modified)
    const baselineAfter = gitGetBaseline(root, newRel);
    assert.strictEqual(baselineAfter, baselineBefore, 'Baseline should be preserved after rename');

    // Verify: file on disk has the modified content
    const diskContent = fs.readFileSync(newPath, 'utf-8');
    assert.strictEqual(diskContent, 'original content\nmodified line\n');
  });

  test('manual delete via VSCode does not produce a deletion hunk', async () => {
    const root = getWorkspaceRoot();
    await enableHunkwise();

    // Create a file and let it be snapshotted
    const filePath = path.join(root, 'to-delete.txt');
    writeFileExternally(filePath, 'delete me\n');
    await sleep(1500);

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    // Delete via VSCode API (user-initiated)
    await deleteFileViaVSCode(vscode.Uri.file(filePath));
    await sleep(1500);

    // Verify: file is no longer tracked in hunkwise git
    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(rel), `Deleted file "${rel}" should not be tracked`);

    // Verify: file does not exist on disk
    assert.ok(!fs.existsSync(filePath), 'File should not exist on disk');
  });
});
