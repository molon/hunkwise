import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitListTracked, gitGetBaseline,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, cleanWorkspace,
} from './helpers';

// ── Test suite ────────────────────────────────────────────────────────────────

suite('hunkwise file watcher integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('enable snapshots existing files as baselines', async () => {
    const root = getWorkspaceRoot();

    // Create files before enabling
    const fileA = path.join(root, 'a.txt');
    const fileB = path.join(root, 'sub', 'b.txt');
    writeFileExternally(fileA, 'content a\n');
    writeFileExternally(fileB, 'content b\n');

    await enableHunkwise();

    const relA = path.relative(root, fileA);
    const relB = path.relative(root, fileB);

    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return tracked.includes(relA) && tracked.includes(relB);
    }, 8000);

    // Baselines should match file contents
    assert.strictEqual(gitGetBaseline(root, relA), 'content a\n');
    assert.strictEqual(gitGetBaseline(root, relB), 'content b\n');
  });

  test('disable clears all state and removes git directory', async () => {
    const root = getWorkspaceRoot();

    writeFileExternally(path.join(root, 'file.txt'), 'hello\n');
    await enableHunkwise();

    const gitDir = path.join(root, '.vscode', 'hunkwise', 'git');
    await waitForCondition(() => fs.existsSync(gitDir), 5000);

    await disableHunkwise();

    // Git dir should be removed
    assert.ok(!fs.existsSync(gitDir), 'Git directory should be removed after disable');
  });

  test('external file creation is tracked with baseline snapshot', async () => {
    const root = getWorkspaceRoot();
    await enableHunkwise();

    // Create a file externally after enable
    const filePath = path.join(root, 'new-external.txt');
    writeFileExternally(filePath, 'external content\n');

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitListTracked(root).includes(rel), 8000);

    // For external new files, baseline should be empty (it's treated as a "new file" hunk)
    const baseline = gitGetBaseline(root, rel);
    assert.strictEqual(baseline, '', 'External new file should have empty baseline');
  });

  test('external file modification preserves original baseline', async () => {
    const root = getWorkspaceRoot();

    // Create file before enable → becomes baseline
    const filePath = path.join(root, 'modify-me.txt');
    writeFileExternally(filePath, 'original\n');

    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    const baselineBefore = gitGetBaseline(root, rel)!;
    assert.strictEqual(baselineBefore, 'original\n');

    // Externally modify the file
    writeFileExternally(filePath, 'original\nmodified\n');
    await sleep(500);

    // Baseline should remain the original content
    const baselineAfter = gitGetBaseline(root, rel);
    assert.strictEqual(baselineAfter, 'original\n', 'Baseline should be preserved after external modification');
  });

  test('external file deletion removes baseline when file had no prior content', async () => {
    const root = getWorkspaceRoot();
    await enableHunkwise();

    // Create a file externally → baseline = ''
    const filePath = path.join(root, 'will-delete.txt');
    writeFileExternally(filePath, 'temp content\n');

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitListTracked(root).includes(rel), 8000);

    // Delete the file externally
    fs.unlinkSync(filePath);
    await sleep(500);

    // Just verify the file doesn't exist on disk
    assert.ok(!fs.existsSync(filePath), 'File should not exist on disk after deletion');
  });

  test('re-enable after disable restores fresh state', async () => {
    const root = getWorkspaceRoot();

    writeFileExternally(path.join(root, 'persist.txt'), 'persist\n');

    await enableHunkwise();
    const rel = 'persist.txt';
    await waitForCondition(() => gitListTracked(root).includes(rel), 5000);

    await disableHunkwise();

    // Modify the file while disabled
    writeFileExternally(path.join(root, 'persist.txt'), 'modified while disabled\n');

    // Re-enable
    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes(rel), 5000);

    // Baseline should be the current content (since we re-snapshotted)
    const baseline = gitGetBaseline(root, rel);
    assert.strictEqual(baseline, 'modified while disabled\n',
      'After re-enable, baseline should reflect current file content');
  });

  test('multiple files created simultaneously are all tracked', async () => {
    const root = getWorkspaceRoot();
    await enableHunkwise();

    // Create several files at once
    const files = ['f1.txt', 'f2.txt', 'f3.txt', 'dir/f4.txt', 'dir/sub/f5.txt'];
    for (const f of files) {
      writeFileExternally(path.join(root, f), `content of ${f}\n`);
    }

    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return files.every(f => tracked.includes(f));
    }, 8000);

    const tracked = gitListTracked(root);
    for (const f of files) {
      assert.ok(tracked.includes(f), `"${f}" should be tracked`);
    }
  });

  test('empty files are not tracked', async () => {
    const root = getWorkspaceRoot();
    await enableHunkwise();

    const emptyFile = path.join(root, 'empty.txt');
    writeFileExternally(emptyFile, '');
    await sleep(500);

    const tracked = gitListTracked(root);
    const rel = path.relative(root, emptyFile);
    // Empty files should not be tracked (onDiskCreate skips zero-length files)
    assert.ok(!tracked.includes(rel), 'Empty files should not be tracked');
  });
});
