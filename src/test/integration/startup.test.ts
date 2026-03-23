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

function getReviewPanel(): any {
  const ext = vscode.extensions.getExtension('molon.hunkwise');
  if (!ext || !ext.isActive) return undefined;
  // Access exported getReviewPanel function
  const api = ext.exports;
  if (api && typeof api.getReviewPanel === 'function') {
    return api.getReviewPanel();
  }
  return undefined;
}

// ── Test suite ────────────────────────────────────────────────────────────────

suite('hunkwise startup & loading integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('startup sync completes and clears loading state', async () => {
    const root = getWorkspaceRoot();

    // Create some files
    writeFileExternally(path.join(root, 'a.txt'), 'content a\n');
    writeFileExternally(path.join(root, 'b.txt'), 'content b\n');

    // Enable hunkwise (creates git repo with baselines)
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('a.txt'), 5000);

    // At this point the extension is active and startup sync has already run.
    // The loading state should be false (sync completed).
    const panel = getReviewPanel();
    if (panel) {
      assert.strictEqual(panel.loading, false,
        'ReviewPanel loading should be false after startup sync completes');
    }

    // Verify files are tracked correctly
    const tracked = gitListTracked(root);
    assert.ok(tracked.includes('a.txt'), 'a.txt should be tracked');
    assert.ok(tracked.includes('b.txt'), 'b.txt should be tracked');
  });

  test('startup sync with stale ignored files completes without hanging', async () => {
    const root = getWorkspaceRoot();

    // Create .gitignore first
    writeFileExternally(path.join(root, '.gitignore'), 'ignored-dir/\n');
    await sleep(1000);

    // Create files
    writeFileExternally(path.join(root, 'keep.txt'), 'keep\n');
    writeFileExternally(path.join(root, 'ignored-dir', 'stale.txt'), 'stale\n');

    // Enable hunkwise
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('keep.txt'), 5000);

    // Verify ignored file is not tracked
    let tracked = gitListTracked(root);
    assert.ok(!tracked.includes('ignored-dir/stale.txt'), 'ignored file should not be tracked');

    // Inject stale file directly into git index (simulating leftover from previous session)
    const env = hunkwiseGitEnv(root);
    const hash = execSync('git hash-object -w --stdin', {
      cwd: root, env, encoding: 'utf-8', input: 'stale\n',
    }).trim();
    execSync(`git update-index --add --cacheinfo 100644,${hash},ignored-dir/stale.txt`, {
      cwd: root, env,
    });
    execSync('git commit --amend --no-edit --allow-empty', { cwd: root, env });

    // Confirm stale file is in git
    tracked = gitListTracked(root);
    assert.ok(tracked.includes('ignored-dir/stale.txt'), 'stale file should be in git after injection');

    // Trigger syncIgnoreState (simulating what startup sync does)
    await vscode.commands.executeCommand('hunkwise.setRespectGitignore', true);

    // Wait for sync to complete and stale file to be removed
    await waitForCondition(() => {
      return !gitListTracked(root).includes('ignored-dir/stale.txt');
    }, 15000, 500);

    // Verify final state
    tracked = gitListTracked(root);
    assert.ok(!tracked.includes('ignored-dir/stale.txt'),
      'stale file should be removed after sync');
    assert.ok(tracked.includes('keep.txt'), 'keep.txt should still be tracked');

    // Loading should be cleared
    const panel = getReviewPanel();
    if (panel) {
      assert.strictEqual(panel.loading, false,
        'ReviewPanel loading should be false after sync');
    }
  });

  test('startup sync with error does not leave panel stuck in loading', async () => {
    const root = getWorkspaceRoot();

    // Create a file and enable
    writeFileExternally(path.join(root, 'test.txt'), 'test\n');
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('test.txt'), 5000);

    // Corrupt the hunkwise git index to force syncIgnoreState to potentially fail
    const gitIndexPath = path.join(root, '.vscode', 'hunkwise', 'git', 'index');
    if (fs.existsSync(gitIndexPath)) {
      // Write garbage to the index file
      fs.writeFileSync(gitIndexPath, 'corrupted-data');
    }

    // Trigger syncIgnoreState — this should not hang even if git operations fail
    // The .catch() in extension.ts should ensure setLoading(false) is called
    try {
      await vscode.commands.executeCommand('hunkwise.setRespectGitignore', true);
    } catch {
      // Command itself might throw, that's fine
    }
    await sleep(3000);

    // The critical assertion: loading should NOT be stuck on true
    const panel = getReviewPanel();
    if (panel) {
      assert.strictEqual(panel.loading, false,
        'ReviewPanel loading must not be stuck on true after sync error');
    }
  });
});
