import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitListTracked, gitGetBaseline,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, cleanWorkspace, getStateManager,
} from './helpers';

// ── Test suite ────────────────────────────────────────────────────────────────

suite('hunkwise clearOnBranchSwitch integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('clearHunks clears multiple reviewing files and updates all baselines', async () => {
    const root = getWorkspaceRoot();

    // Create multiple files
    writeFileExternally(path.join(root, 'a.txt'), 'original-a\n');
    writeFileExternally(path.join(root, 'b.txt'), 'original-b\n');
    writeFileExternally(path.join(root, 'c.txt'), 'original-c\n');

    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('a.txt'));
    await waitForCondition(() => gitListTracked(root).includes('b.txt'));
    await waitForCondition(() => gitListTracked(root).includes('c.txt'));

    // Modify all files externally to enter reviewing state
    writeFileExternally(path.join(root, 'a.txt'), 'modified-a\n');
    writeFileExternally(path.join(root, 'b.txt'), 'modified-b\n');
    writeFileExternally(path.join(root, 'c.txt'), 'modified-c\n');
    await sleep(1500);

    // Verify baselines are still original
    assert.strictEqual(gitGetBaseline(root, 'a.txt'), 'original-a\n');
    assert.strictEqual(gitGetBaseline(root, 'b.txt'), 'original-b\n');
    assert.strictEqual(gitGetBaseline(root, 'c.txt'), 'original-c\n');

    // Verify files are in reviewing state
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    const allFiles = sm.getAllFiles() as Map<string, any>;
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const state = allFiles.get(path.join(root, name));
      assert.ok(state && state.status === 'reviewing',
        `${name} should be in reviewing state`);
    }

    // Clear hunks (simulates branch switch)
    await vscode.commands.executeCommand('hunkwise.clearHunks');
    await sleep(500);

    // All baselines should be updated to current disk content
    assert.strictEqual(gitGetBaseline(root, 'a.txt'), 'modified-a\n');
    assert.strictEqual(gitGetBaseline(root, 'b.txt'), 'modified-b\n');
    assert.strictEqual(gitGetBaseline(root, 'c.txt'), 'modified-c\n');

    // No files should be in reviewing state
    const allFilesAfter = sm.getAllFiles() as Map<string, any>;
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const state = allFilesAfter.get(path.join(root, name));
      assert.ok(!state || state.status !== 'reviewing',
        `${name} should NOT be in reviewing state after clearHunks`);
    }
  });

  test('clearHunks removes deleted files from tracking', async () => {
    const root = getWorkspaceRoot();

    // Create a file, enable, snapshot baseline
    writeFileExternally(path.join(root, 'doomed.txt'), 'will be deleted\n');
    writeFileExternally(path.join(root, 'survives.txt'), 'original\n');

    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('doomed.txt'));
    await waitForCondition(() => gitListTracked(root).includes('survives.txt'));

    // Modify survives.txt to enter reviewing
    writeFileExternally(path.join(root, 'survives.txt'), 'modified\n');
    await sleep(1500);

    // Delete doomed.txt externally — FileWatcher should detect deletion and enter reviewing
    fs.unlinkSync(path.join(root, 'doomed.txt'));
    await sleep(1500);

    // Now clear hunks
    await vscode.commands.executeCommand('hunkwise.clearHunks');
    await sleep(500);

    // doomed.txt should be removed from git tracking (file doesn't exist)
    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes('doomed.txt'),
      'deleted file should be removed from tracking after clearHunks');

    // survives.txt baseline should be updated
    assert.strictEqual(gitGetBaseline(root, 'survives.txt'), 'modified\n');
  });

  test('clearHunks with no reviewing files is a no-op', async () => {
    const root = getWorkspaceRoot();

    // Create a file but don't modify it (stays idle, not reviewing)
    writeFileExternally(path.join(root, 'idle.txt'), 'idle content\n');

    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('idle.txt'));

    const baselineBefore = gitGetBaseline(root, 'idle.txt');

    // Clear hunks — nothing should change
    await vscode.commands.executeCommand('hunkwise.clearHunks');
    await sleep(300);

    const baselineAfter = gitGetBaseline(root, 'idle.txt');
    assert.strictEqual(baselineAfter, baselineBefore,
      'baseline should not change when no files are reviewing');
  });

  test('clearHunks only affects reviewing files, not idle files', async () => {
    const root = getWorkspaceRoot();

    writeFileExternally(path.join(root, 'idle.txt'), 'idle\n');
    writeFileExternally(path.join(root, 'active.txt'), 'original\n');

    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('idle.txt'));
    await waitForCondition(() => gitListTracked(root).includes('active.txt'));

    // Only modify active.txt to enter reviewing
    writeFileExternally(path.join(root, 'active.txt'), 'changed\n');
    await sleep(1500);

    // Verify only active.txt is reviewing
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    const files = sm.getAllFiles() as Map<string, any>;
    const idleState = files.get(path.join(root, 'idle.txt'));
    const activeState = files.get(path.join(root, 'active.txt'));
    assert.ok(!idleState || idleState.status !== 'reviewing', 'idle.txt should not be reviewing');
    assert.ok(activeState && activeState.status === 'reviewing', 'active.txt should be reviewing');

    // Clear hunks
    await vscode.commands.executeCommand('hunkwise.clearHunks');
    await sleep(500);

    // idle.txt baseline should be unchanged
    assert.strictEqual(gitGetBaseline(root, 'idle.txt'), 'idle\n');
    // active.txt baseline should be updated
    assert.strictEqual(gitGetBaseline(root, 'active.txt'), 'changed\n');
  });

  test('setClearOnBranchSwitch persists and can be toggled', async () => {
    const root = getWorkspaceRoot();
    const settingsPath = path.join(root, '.vscode', 'hunkwise', 'settings.json');

    await enableHunkwise();

    // Default should be false
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    assert.strictEqual(sm.clearOnBranchSwitch, false,
      'clearOnBranchSwitch should default to false');

    // Set to true
    await vscode.commands.executeCommand('hunkwise.setClearOnBranchSwitch', true);
    await sleep(200);

    let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(settings.clearOnBranchSwitch, true);
    assert.strictEqual(sm.clearOnBranchSwitch, true);

    // Toggle back to false
    await vscode.commands.executeCommand('hunkwise.setClearOnBranchSwitch', false);
    await sleep(200);

    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(settings.clearOnBranchSwitch, false);
    assert.strictEqual(sm.clearOnBranchSwitch, false);
  });

  test('clearOnBranchSwitch setting survives disable-enable cycle', async () => {
    const root = getWorkspaceRoot();
    const settingsPath = path.join(root, '.vscode', 'hunkwise', 'settings.json');

    await enableHunkwise();

    // Set clearOnBranchSwitch to true
    await vscode.commands.executeCommand('hunkwise.setClearOnBranchSwitch', true);
    await sleep(200);

    // Disable and re-enable
    await disableHunkwise();
    await enableHunkwise();

    // Setting should be preserved
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(settings.clearOnBranchSwitch, true,
      'clearOnBranchSwitch should persist across disable-enable cycle');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    assert.strictEqual(sm.clearOnBranchSwitch, true,
      'in-memory clearOnBranchSwitch should be restored after re-enable');
  });

  test('.git/HEAD watcher triggers clearHunks on branch switch', async function () {
    const root = getWorkspaceRoot();
    const gitDir = path.join(root, '.git');
    const gitHeadPath = path.join(gitDir, 'HEAD');

    // Skip if .git/HEAD doesn't exist in workspace (watcher won't be active)
    // The watcher is initialized during activate() — if workspace has no .git,
    // we can't test the watcher. This test verifies behavior when it IS present.
    if (!fs.existsSync(gitHeadPath)) {
      // Create .git/HEAD so future test runs (after extension re-activate) can use it.
      // For now, skip this test since the watcher wasn't set up at activate time.
      this.skip();
      return;
    }

    // If we get here, the workspace has .git/HEAD and the watcher should be active
    writeFileExternally(path.join(root, 'branch-test.txt'), 'before-switch\n');
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('branch-test.txt'));

    // Enable clearOnBranchSwitch
    await vscode.commands.executeCommand('hunkwise.setClearOnBranchSwitch', true);
    await sleep(200);

    // Modify file to enter reviewing
    writeFileExternally(path.join(root, 'branch-test.txt'), 'after-switch\n');
    await sleep(1500);

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    const state = (sm.getAllFiles() as Map<string, any>).get(path.join(root, 'branch-test.txt'));
    assert.ok(state && state.status === 'reviewing', 'file should be reviewing before branch switch');

    // Simulate branch switch by modifying .git/HEAD
    const currentHead = fs.readFileSync(gitHeadPath, 'utf-8').trim();
    const fakeHead = currentHead.includes('fake-branch')
      ? 'ref: refs/heads/main'
      : 'ref: refs/heads/fake-branch';
    fs.writeFileSync(gitHeadPath, fakeHead + '\n');

    // Wait for watcher to trigger and clear hunks
    await waitForCondition(() => {
      const files = sm.getAllFiles() as Map<string, any>;
      const s = files.get(path.join(root, 'branch-test.txt'));
      return !s || s.status !== 'reviewing';
    }, 5000);

    // Baseline should be updated
    assert.strictEqual(gitGetBaseline(root, 'branch-test.txt'), 'after-switch\n',
      'baseline should be updated after branch switch');

    // Restore original HEAD
    fs.writeFileSync(gitHeadPath, currentHead + '\n');
  });
});
