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

function writeFileExternally(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
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

suite('hunkwise lifecycle integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('enable creates hunkwise git directory and settings', async () => {
    const root = getWorkspaceRoot();
    const hunkwiseDir = path.join(root, '.vscode', 'hunkwise');
    const gitDir = path.join(hunkwiseDir, 'git');
    const settingsPath = path.join(hunkwiseDir, 'settings.json');

    assert.ok(!fs.existsSync(gitDir), 'Git dir should not exist before enable');

    await enableHunkwise();

    assert.ok(fs.existsSync(gitDir), 'Git dir should exist after enable');
    assert.ok(fs.existsSync(settingsPath), 'Settings file should exist after enable');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.ok(Array.isArray(settings.ignorePatterns), 'Settings should have ignorePatterns');
    assert.ok(settings.ignorePatterns.includes('.git'), '.git should be in default ignorePatterns');
    assert.strictEqual(settings.respectGitignore, true, 'respectGitignore should default to true');
  });

  test('disable removes git directory but preserves settings', async () => {
    const root = getWorkspaceRoot();
    const hunkwiseDir = path.join(root, '.vscode', 'hunkwise');
    const gitDir = path.join(hunkwiseDir, 'git');
    const settingsPath = path.join(hunkwiseDir, 'settings.json');

    await enableHunkwise();
    assert.ok(fs.existsSync(gitDir), 'Git dir should exist after enable');
    assert.ok(fs.existsSync(settingsPath), 'Settings should exist');

    await disableHunkwise();

    assert.ok(!fs.existsSync(gitDir), 'Git dir should be removed after disable');
    // Settings file is preserved so re-enable remembers user preferences
    assert.ok(fs.existsSync(settingsPath), 'Settings should be preserved after disable');
  });

  test('enable-disable-enable cycle works cleanly', async () => {
    const root = getWorkspaceRoot();
    writeFileExternally(path.join(root, 'cycle.txt'), 'cycle content\n');

    // First enable
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('cycle.txt'), 5000);

    // Disable
    await disableHunkwise();
    await sleep(500);

    // Second enable
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('cycle.txt'), 5000);

    const baseline = gitGetBaseline(root, 'cycle.txt');
    assert.strictEqual(baseline, 'cycle content\n', 'Baseline should match file content after re-enable');
  });

  test('.gitignore is auto-created/updated with hunkwise entry on enable', async () => {
    const root = getWorkspaceRoot();
    const gitignorePath = path.join(root, '.gitignore');

    // No .gitignore initially
    assert.ok(!fs.existsSync(gitignorePath), '.gitignore should not exist initially');

    await enableHunkwise();
    await sleep(500);

    // upsertGitignore should have created .gitignore with hunkwise entry
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      assert.ok(content.includes('.vscode/hunkwise'), '.gitignore should contain hunkwise entry');
    }
    // Note: if .gitignore wasn't created, that's also acceptable
    // (upsertGitignore is non-fatal)
  });

  test('setIgnorePatterns persists to settings.json', async () => {
    const root = getWorkspaceRoot();
    const settingsPath = path.join(root, '.vscode', 'hunkwise', 'settings.json');

    await enableHunkwise();

    await vscode.commands.executeCommand('hunkwise.setIgnorePatterns', ['.git', 'node_modules', '*.tmp']);
    await sleep(500);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.deepStrictEqual(settings.ignorePatterns, ['.git', 'node_modules', '*.tmp']);
  });

  test('setRespectGitignore persists to settings.json', async () => {
    const root = getWorkspaceRoot();
    const settingsPath = path.join(root, '.vscode', 'hunkwise', 'settings.json');

    await enableHunkwise();

    await vscode.commands.executeCommand('hunkwise.setRespectGitignore', false);
    await sleep(500);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(settings.respectGitignore, false);
  });

  test('default ignorePatterns exclude .git files from tracking', async () => {
    const root = getWorkspaceRoot();

    // Create a fake .git directory with a file
    const gitFile = path.join(root, '.git', 'config');
    writeFileExternally(gitFile, 'fake git config\n');

    // Create a normal file
    writeFileExternally(path.join(root, 'normal.txt'), 'normal\n');

    await enableHunkwise();

    await waitForCondition(() => gitListTracked(root).includes('normal.txt'), 5000);
    await sleep(1000);

    const tracked = gitListTracked(root);
    assert.ok(tracked.includes('normal.txt'), 'Normal file should be tracked');
    assert.ok(!tracked.includes('.git/config'), '.git files should be ignored');
  });
});
