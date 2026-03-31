import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, cleanWorkspace, getStateManager, getFileWatcher,
} from './helpers';
import { discardAllFiles, discardFileByPath } from '../../commands';

// ── Test suite ────────────────────────────────────────────────────────────────

suite('hunkwise delete & restore integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('discardAllFiles restores an externally deleted file', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'to-delete.txt');

    // Create file before enable → becomes baseline
    writeFileExternally(filePath, 'original content\n');
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);
    assert.strictEqual(gitGetBaseline(root, rel), 'original content\n');

    // Delete file externally (simulating Finder delete)
    fs.unlinkSync(filePath);

    // Wait for FileWatcher to detect deletion and enter reviewing
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    // Verify: file state is reviewing with original baseline
    const fileState = sm.getFile(filePath);
    assert.strictEqual(fileState?.status, 'reviewing');
    assert.strictEqual(fileState?.baseline, 'original content\n');

    // Now discard all files — should restore the deleted file
    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');
    await discardAllFiles(sm, fw, () => {});

    // File should be restored on disk
    assert.ok(fs.existsSync(filePath), 'File should be restored on disk after discardAll');
    const restored = fs.readFileSync(filePath, 'utf-8');
    assert.strictEqual(restored, 'original content\n', 'Restored content should match baseline');

    // File should no longer be in reviewing state
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return !f || f.status !== 'reviewing';
    }, 5000);
  });

  test('discardFileByPath restores an externally deleted file', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'single-delete.txt');

    writeFileExternally(filePath, 'single file content\n');
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    // Delete file externally
    fs.unlinkSync(filePath);

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    // Discard single file
    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');
    await discardFileByPath(sm, fw, filePath, () => {});

    // File should be restored on disk
    assert.ok(fs.existsSync(filePath), 'File should be restored on disk after discardFile');
    const restored = fs.readFileSync(filePath, 'utf-8');
    assert.strictEqual(restored, 'single file content\n', 'Restored content should match baseline');
  });

  test('externally restored file exits reviewing state', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'restore-me.txt');

    // Create file before enable → becomes baseline
    writeFileExternally(filePath, 'baseline content\n');
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    // Delete file externally → enters reviewing (deleted hunk)
    fs.unlinkSync(filePath);

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    // Restore file externally (simulating git checkout)
    writeFileExternally(filePath, 'baseline content\n');

    // FileWatcher.onDiskCreate should detect the restore and exit reviewing
    // because baseline matches restored content (no diff)
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return !f || f.status !== 'reviewing';
    }, 5000);

    // File should exist on disk with original content
    assert.ok(fs.existsSync(filePath), 'File should exist on disk');
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'baseline content\n');
  });

  test('accept empty file preserves baseline as empty string instead of removing', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'empty-accept.txt');

    // Create file with content before enable → becomes baseline
    writeFileExternally(filePath, 'has content\n');
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    // External tool truncates file to empty → enters reviewing
    writeFileExternally(filePath, '');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    // Accept the empty file — should exitReviewing with '' baseline, not removeFile
    const { acceptFileByPath } = await import('../../commands');
    acceptFileByPath(sm, filePath, () => {});

    // File should no longer be in reviewing
    assert.ok(!sm.getFile(filePath), 'File should not be in reviewing state after accept');

    // Baseline in git should be '' (empty), NOT removed entirely
    await waitForCondition(() => gitGetBaseline(root, rel) === '', 5000);
    assert.strictEqual(gitGetBaseline(root, rel), '', 'Baseline should be empty string for accepted empty file');

    // Now external tool writes content → should show as change from empty baseline
    writeFileExternally(filePath, 'new content\n');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    const fileState = sm.getFile(filePath);
    assert.strictEqual(fileState?.baseline, '', 'Baseline should still be empty');
  });

  test('externally restored file with different content stays in reviewing', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'partial-restore.txt');

    writeFileExternally(filePath, 'original\n');
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    // Delete file externally
    fs.unlinkSync(filePath);

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    // Restore file with DIFFERENT content
    writeFileExternally(filePath, 'different content\n');

    // Should still be in reviewing because content differs from baseline
    await sleep(1000);
    const fileState = sm.getFile(filePath);
    assert.ok(fileState, 'File should still be tracked');
    assert.strictEqual(fileState?.status, 'reviewing', 'File should remain in reviewing with different content');
    assert.strictEqual(fileState?.baseline, 'original\n', 'Baseline should be preserved');
  });

  // ── null baseline vs empty baseline tests ──────────────────────────────────

  test('discard new file (null baseline) deletes the file', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'new-discard.txt');

    await enableHunkwise();

    // Create file externally → null baseline (new file)
    writeFileExternally(filePath, 'new file content\n');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    assert.strictEqual(sm.getFile(filePath)?.baseline, null, 'New file should have null baseline');

    // Discard → should delete the file
    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');
    await discardFileByPath(sm, fw, filePath, () => {});

    assert.ok(!fs.existsSync(filePath), 'New file should be deleted after discard');
    assert.ok(!sm.getFile(filePath), 'File should be removed from state after discard');
  });

  test('discard existing empty file (empty baseline) restores to empty', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'was-empty.txt');

    // Create empty file before enable → snapshotted as '' baseline
    writeFileExternally(filePath, '');
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);
    // The snapshot stores '' for empty files
    assert.strictEqual(gitGetBaseline(root, rel), '', 'Empty file baseline should be empty string');

    // External tool writes content → enters reviewing with '' baseline
    writeFileExternally(filePath, 'now has content\n');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    assert.strictEqual(sm.getFile(filePath)?.baseline, '', 'Existing empty file should have empty string baseline');

    // Discard → should restore to empty (not delete!)
    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');
    await discardFileByPath(sm, fw, filePath, () => {});

    assert.ok(fs.existsSync(filePath), 'File should still exist after discard (was empty, not new)');
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), '', 'File should be restored to empty');
  });

  test('accept new file converts null baseline to actual content in git', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'new-accept.txt');

    await enableHunkwise();

    // Create file externally → null baseline
    writeFileExternally(filePath, 'accepted content\n');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    assert.strictEqual(sm.getFile(filePath)?.baseline, null, 'Should have null baseline before accept');

    // Accept → should snapshot current content as baseline
    const { acceptFileByPath } = await import('../../commands');
    acceptFileByPath(sm, filePath, () => {});

    assert.ok(!sm.getFile(filePath), 'File should not be in reviewing after accept');

    // Baseline in git should now be the actual content
    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) === 'accepted content\n', 5000);
    assert.strictEqual(gitGetBaseline(root, rel), 'accepted content\n');
  });

  test('state and git baseline are consistent after operations', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'consistency.txt');

    // Create file before enable → becomes baseline
    writeFileExternally(filePath, 'initial\n');
    await enableHunkwise();

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    // Verify initial consistency: file is idle, baseline matches
    assert.strictEqual(gitGetBaseline(root, rel), 'initial\n');
    assert.ok(!sm.getFile(filePath), 'Idle file should not be in state map');

    // External modification → enters reviewing
    writeFileExternally(filePath, 'modified\n');
    await waitForCondition(() => sm.getFile(filePath)?.status === 'reviewing', 5000);

    // Memory baseline should match git baseline
    assert.strictEqual(sm.getFile(filePath)?.baseline, 'initial\n');
    assert.strictEqual(gitGetBaseline(root, rel), 'initial\n', 'Git baseline should still be initial');

    // Accept → baseline should update to current content
    const { acceptFileByPath } = await import('../../commands');
    acceptFileByPath(sm, filePath, () => {});

    assert.ok(!sm.getFile(filePath), 'Should exit reviewing after accept');
    await waitForCondition(() => gitGetBaseline(root, rel) === 'modified\n', 5000);
    assert.strictEqual(gitGetBaseline(root, rel), 'modified\n', 'Git baseline should update after accept');
  });

  // ── load/rebuild restores deleted files to reviewing ─────────────────────

  test('deleted file enters reviewing after load (simulates restart)', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'load-deleted.txt');

    // Create file before enable → becomes baseline in git
    writeFileExternally(filePath, 'will be deleted\n');
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);
    assert.strictEqual(gitGetBaseline(root, rel), 'will be deleted\n');

    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');

    // Suppress FileWatcher before deleting — prevents async onDiskDelete from
    // racing with our manual state manipulation below.
    fw.suppressAll();
    try {
      // Delete the file while FileWatcher is suppressed
      fs.unlinkSync(filePath);
      assert.ok(!fs.existsSync(filePath), 'File should be gone from disk');

      // Drain any pending git ops queued before suppress
      await sm.flush();

      // Clear in-memory state to simulate fresh start — baselines remain in git.
      // Uses internal state map directly because there is no public clear-without-git API;
      // rebuildState() does the same via this.state.clear().
      (sm as any).state.clear();
      assert.ok(!sm.getFile(filePath), 'File should be cleared from memory');

      // Call load() with shouldIgnore matching production activation
      await sm.load((fp: string, isDir?: boolean) => fw.shouldIgnore(fp, isDir));
    } finally {
      fw.resumeAll();
    }

    const fileState = sm.getFile(filePath);
    assert.ok(fileState, 'Deleted file should be in state map after load');
    assert.strictEqual(fileState?.status, 'reviewing', 'Deleted file should be in reviewing state');
    assert.strictEqual(fileState?.baseline, 'will be deleted\n', 'Baseline should be preserved');

    // Verify the file can be restored via discard
    await discardFileByPath(sm, fw, filePath, () => {});

    assert.ok(fs.existsSync(filePath), 'File should be restored on disk after discard');
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'will be deleted\n');
  });
});
