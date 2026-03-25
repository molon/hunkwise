import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import { execSync } from 'child_process';
import {
  getWorkspaceRoot, hunkwiseGitEnv, gitListTracked, gitGetBaseline,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, cleanWorkspace, getReviewPanel, getStateManager,
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

  test('load only marks files as reviewing when baseline differs from disk', async () => {
    const root = getWorkspaceRoot();

    // Create files and enable — baselines match disk content
    writeFileExternally(path.join(root, 'unchanged.txt'), 'same\n');
    writeFileExternally(path.join(root, 'will-change.txt'), 'original\n');
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('unchanged.txt'), 5000);
    await waitForCondition(() => gitListTracked(root).includes('will-change.txt'), 5000);

    // Modify one file externally (simulates change while VSCode was closed)
    writeFileExternally(path.join(root, 'will-change.txt'), 'modified\n');

    // Disable and re-enable to trigger load() from scratch
    await disableHunkwise();

    // Re-inject baselines into git before re-enable (simulate persistent state)
    // We need to manually set up the git repo since disable destroyed it
    writeFileExternally(path.join(root, 'unchanged.txt'), 'same\n');
    writeFileExternally(path.join(root, 'will-change.txt'), 'modified\n');
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('unchanged.txt'), 5000);

    // Now modify will-change.txt again to create a real diff
    writeFileExternally(path.join(root, 'will-change.txt'), 'modified-again\n');
    await sleep(1000);

    // Check state: only will-change.txt should be reviewing
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    const allFiles = sm.getAllFiles() as Map<string, any>;

    const unchangedState = allFiles.get(path.join(root, 'unchanged.txt'));
    assert.ok(!unchangedState || unchangedState.status !== 'reviewing',
      'unchanged.txt should NOT be in reviewing state');

    const changedState = allFiles.get(path.join(root, 'will-change.txt'));
    assert.ok(changedState && changedState.status === 'reviewing',
      'will-change.txt should be in reviewing state');
  });

  test('corrupted git dir (HEAD missing) is re-initialized on enable', async () => {
    const root = getWorkspaceRoot();
    const hunkwiseDir = path.join(root, '.vscode', 'hunkwise');
    const gitDir = path.join(hunkwiseDir, 'git');

    // Create a file and enable hunkwise normally
    writeFileExternally(path.join(root, 'recover.txt'), 'hello\n');
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('recover.txt'), 5000);

    // Verify baseline was stored
    const baseline = gitGetBaseline(root, 'recover.txt');
    assert.strictEqual(baseline, 'hello\n', 'baseline should be stored');

    // Disable hunkwise (cleans git dir)
    await disableHunkwise();
    assert.ok(!fs.existsSync(gitDir), 'git dir should be removed after disable');

    // Simulate a corrupted git dir: directory exists but HEAD is missing
    fs.mkdirSync(gitDir, { recursive: true });
    // Write some garbage files to simulate partial init
    fs.writeFileSync(path.join(gitDir, 'config'), 'garbage', 'utf-8');
    assert.ok(fs.existsSync(gitDir), 'corrupted git dir should exist');
    assert.ok(!fs.existsSync(path.join(gitDir, 'HEAD')), 'HEAD should NOT exist (corrupted)');

    // Re-enable — initGit should detect corruption and re-initialize
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('recover.txt'), 5000);

    // Verify the git repo is valid now
    assert.ok(fs.existsSync(path.join(gitDir, 'HEAD')), 'HEAD should exist after recovery');

    // Verify baseline was re-created
    const newBaseline = gitGetBaseline(root, 'recover.txt');
    assert.strictEqual(newBaseline, 'hello\n', 'baseline should be restored after recovery');
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
