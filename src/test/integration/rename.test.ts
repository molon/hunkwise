import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitListTracked, gitGetBaseline,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, renameFileViaVSCode, deleteFileViaVSCode, cleanWorkspace,
  getStateManager,
} from './helpers';

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

    // Externally create a new file → triggers review with null baseline
    const oldPath = path.join(root, 'new-file.txt');
    writeFileExternally(oldPath, 'new file content\n');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(oldPath);
      return f?.status === 'reviewing';
    }, 8000);

    // Rename via VSCode API
    const newPath = path.join(root, 'new-file-renamed.txt');
    await renameFileViaVSCode(vscode.Uri.file(oldPath), vscode.Uri.file(newPath));

    await waitForCondition(() => {
      const f = sm.getFile(newPath);
      return f?.status === 'reviewing';
    }, 5000);

    // Verify: new path is tracked in memory, old path is not
    assert.ok(!sm.getFile(oldPath), `Old path should not be in state`);
    assert.ok(sm.getFile(newPath), `New path should be in state`);

    // Verify: baseline is null (new file) — null-baseline files are not in git
    assert.strictEqual(sm.getFile(newPath)?.baseline, null, 'Baseline should be null for new file');

    // Verify: file exists on disk at new path
    assert.ok(fs.existsSync(newPath), 'File should exist at new path');
    assert.ok(!fs.existsSync(oldPath), 'File should not exist at old path');
  });

  test('rename a reviewing file preserves baseline under new path', async () => {
    const root = getWorkspaceRoot();

    // Create a file BEFORE enable so it gets snapshotted as baseline
    const filePath = path.join(root, 'reviewing-file.txt');
    writeFileExternally(filePath, 'original content\n');

    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 8000);
    const baselineBefore = gitGetBaseline(root, rel)!;

    // Externally modify the file → triggers review mode
    writeFileExternally(filePath, 'original content\nmodified line\n');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    // Rename via VSCode API while in reviewing state
    const newPath = path.join(root, 'reviewing-file-renamed.txt');
    const newRel = path.relative(root, newPath);
    await renameFileViaVSCode(vscode.Uri.file(filePath), vscode.Uri.file(newPath));

    await waitForCondition(() => gitListTracked(root).includes(newRel), 5000);

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

    // Create a file BEFORE enable so it gets snapshotted as baseline
    const filePath = path.join(root, 'to-delete.txt');
    writeFileExternally(filePath, 'delete me\n');

    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 8000);

    // Delete via VSCode API (user-initiated)
    await deleteFileViaVSCode(vscode.Uri.file(filePath));

    await waitForCondition(() => !gitListTracked(root).includes(rel), 5000);

    // Verify: file is no longer tracked in hunkwise git
    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(rel), `Deleted file "${rel}" should not be tracked`);

    // Verify: file does not exist on disk
    assert.ok(!fs.existsSync(filePath), 'File should not exist on disk');
  });
});
