import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import { execSync } from 'child_process';
import {
  getWorkspaceRoot, hunkwiseGitEnv, gitListTracked,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, cleanWorkspace, getReviewPanel,
} from './helpers';

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
    await sleep(300);

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
    }, 15000, 200);

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

  test('startup sync removes many stale ignored files efficiently via batch', async () => {
    const root = getWorkspaceRoot();

    // Create .gitignore that ignores a directory
    writeFileExternally(path.join(root, '.gitignore'), 'bulk-dir/\n');
    await sleep(300);

    // Create a normal file and enable
    writeFileExternally(path.join(root, 'keep.txt'), 'keep\n');
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('keep.txt'), 5000);

    // Inject 500 stale files directly into hunkwise git index,
    // simulating files tracked before a directory was added to .gitignore.
    const env = hunkwiseGitEnv(root);
    const hash = execSync('git hash-object -w --stdin', {
      cwd: root, env, encoding: 'utf-8', input: 'stale content\n',
    }).trim();

    // Build a single update-index call with all 500 files for fast injection
    const cacheArgs: string[] = [];
    for (let i = 0; i < 500; i++) {
      cacheArgs.push('--add', '--cacheinfo', `100644,${hash},bulk-dir/file-${i}.txt`);
    }
    execSync(`git update-index ${cacheArgs.join(' ')}`, { cwd: root, env });
    execSync('git commit --amend --no-edit --allow-empty', { cwd: root, env });

    // Confirm stale files are in git
    let tracked = gitListTracked(root);
    assert.ok(tracked.includes('bulk-dir/file-0.txt'), 'stale files should be in git after injection');
    assert.ok(tracked.includes('bulk-dir/file-499.txt'), 'last stale file should be in git');
    assert.ok(tracked.length >= 501, `should have 501+ tracked files, got ${tracked.length}`);

    // Trigger syncIgnoreState — this must complete within the test timeout (30s).
    const start = Date.now();
    await vscode.commands.executeCommand('hunkwise.setRespectGitignore', true);

    await waitForCondition(() => {
      const t = gitListTracked(root);
      return !t.includes('bulk-dir/file-0.txt') && !t.includes('bulk-dir/file-499.txt');
    }, 20000, 200);

    const elapsed = Date.now() - start;

    // Verify final state
    tracked = gitListTracked(root);
    assert.ok(!tracked.includes('bulk-dir/file-0.txt'), 'stale file 0 should be removed');
    assert.ok(!tracked.includes('bulk-dir/file-499.txt'), 'stale file 499 should be removed');
    assert.ok(tracked.includes('keep.txt'), 'keep.txt should still be tracked');

    // The batch operation should complete in well under 30 seconds.
    assert.ok(elapsed < 15000,
      `batch removal of 500 files took ${elapsed}ms, expected < 15000ms`);
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
    try {
      await vscode.commands.executeCommand('hunkwise.setRespectGitignore', true);
    } catch {
      // Command itself might throw, that's fine
    }
    await sleep(2000);

    // The critical assertion: loading should NOT be stuck on true
    const panel = getReviewPanel();
    if (panel) {
      assert.strictEqual(panel.loading, false,
        'ReviewPanel loading must not be stuck on true after sync error');
    }
  });
});
