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

function writeFileExternally(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Write a file via VSCode API to ensure FileSystemWatcher events fire reliably.
 */
async function writeFileViaVSCode(filePath: string, content: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const uri = vscode.Uri.file(filePath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
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

suite('hunkwise ignore/gitignore integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('files in a directory added to .gitignore are removed from tracking', async () => {
    const root = getWorkspaceRoot();

    // Create files before enabling hunkwise (they become baselines)
    const dirPath = path.join(root, 'mydir');
    const fileA = path.join(dirPath, 'a.txt');
    const fileB = path.join(dirPath, 'b.txt');
    const fileOutside = path.join(root, 'keep.txt');
    writeFileExternally(fileA, 'content a\n');
    writeFileExternally(fileB, 'content b\n');
    writeFileExternally(fileOutside, 'keep me\n');

    await enableHunkwise();

    // Wait for all files to be tracked
    const relA = path.relative(root, fileA);
    const relB = path.relative(root, fileB);
    const relOutside = path.relative(root, fileOutside);
    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return tracked.includes(relA) && tracked.includes(relB) && tracked.includes(relOutside);
    }, 8000);

    // Add the directory to .gitignore via VSCode API to ensure watcher fires
    const gitignorePath = path.join(root, '.gitignore');
    await writeFileViaVSCode(gitignorePath, 'mydir/\n');

    // Wait for gitignore watcher → loadGitignore → syncIgnoreState → gitQueue
    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return !tracked.includes(relA) && !tracked.includes(relB);
    }, 15000, 500);

    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(relA), `"${relA}" should not be tracked after adding to .gitignore`);
    assert.ok(!tracked.includes(relB), `"${relB}" should not be tracked after adding to .gitignore`);
    assert.ok(tracked.includes(relOutside), `"${relOutside}" should still be tracked`);
  });

  test('files matching a pattern added to .gitignore are removed from tracking', async () => {
    const root = getWorkspaceRoot();

    // Create files
    const logFile = path.join(root, 'debug.log');
    const txtFile = path.join(root, 'readme.txt');
    writeFileExternally(logFile, 'log content\n');
    writeFileExternally(txtFile, 'readme content\n');

    await enableHunkwise();

    const relLog = path.relative(root, logFile);
    const relTxt = path.relative(root, txtFile);
    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return tracked.includes(relLog) && tracked.includes(relTxt);
    }, 8000);

    // Add *.log to .gitignore via VSCode API
    await writeFileViaVSCode(path.join(root, '.gitignore'), '*.log\n');

    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return !tracked.includes(relLog);
    }, 15000, 500);

    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(relLog), `"${relLog}" should not be tracked after ignoring *.log`);
    assert.ok(tracked.includes(relTxt), `"${relTxt}" should still be tracked`);
  });

  test('removing a pattern from .gitignore re-adds files to tracking', async () => {
    const root = getWorkspaceRoot();

    // Start with .gitignore that ignores mydir/
    writeFileExternally(path.join(root, '.gitignore'), 'mydir/\n');

    // Create files (mydir/ files should be ignored on enable)
    const ignoredFile = path.join(root, 'mydir', 'ignored.txt');
    const normalFile = path.join(root, 'normal.txt');
    writeFileExternally(ignoredFile, 'ignored content\n');
    writeFileExternally(normalFile, 'normal content\n');

    // Wait for .gitignore to be picked up by the file watcher
    await sleep(1500);
    await enableHunkwise();

    const relIgnored = path.relative(root, ignoredFile);
    const relNormal = path.relative(root, normalFile);

    // Wait for normal file to be tracked
    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return tracked.includes(relNormal);
    }, 8000);

    // Verify ignored file is NOT tracked
    let tracked = gitListTracked(root);
    assert.ok(!tracked.includes(relIgnored), `"${relIgnored}" should not be tracked initially`);

    // Remove the ignore rule via VSCode API
    await writeFileViaVSCode(path.join(root, '.gitignore'), '');

    // Wait for previously ignored file to be added
    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return tracked.includes(relIgnored);
    }, 15000, 500);

    tracked = gitListTracked(root);
    assert.ok(tracked.includes(relIgnored), `"${relIgnored}" should be tracked after removing ignore rule`);
    assert.ok(tracked.includes(relNormal), `"${relNormal}" should still be tracked`);
  });

  test('nested directories are fully removed when parent is added to .gitignore', async () => {
    const root = getWorkspaceRoot();

    // Create nested structure
    const deepFile = path.join(root, 'vendor', 'pkg', 'lib', 'deep.txt');
    const topFile = path.join(root, 'src', 'main.txt');
    writeFileExternally(deepFile, 'deep content\n');
    writeFileExternally(topFile, 'main content\n');

    await enableHunkwise();

    const relDeep = path.relative(root, deepFile);
    const relTop = path.relative(root, topFile);
    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return tracked.includes(relDeep) && tracked.includes(relTop);
    }, 8000);

    // Ignore vendor/ via VSCode API
    await writeFileViaVSCode(path.join(root, '.gitignore'), 'vendor/\n');

    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return !tracked.includes(relDeep);
    }, 15000, 500);

    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(relDeep), `"${relDeep}" should not be tracked after ignoring vendor/`);
    assert.ok(tracked.includes(relTop), `"${relTop}" should still be tracked`);
  });
});
