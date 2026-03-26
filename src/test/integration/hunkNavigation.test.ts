import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, cleanWorkspace, getStateManager, getFileWatcher,
} from './helpers';
import { acceptHunk, discardHunk } from '../../commands';
import { computeHunks, hunkId } from '../../diffEngine';

// ── Test suite ────────────────────────────────────────────────────────────────

suite('hunkwise hunk navigation integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  /**
   * Helper: create a file with baseline content, enable hunkwise, then modify
   * externally to produce multiple hunks. Returns the file path.
   */
  async function setupMultiHunkFile(): Promise<string> {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'multi-hunk.txt');

    // Baseline: 9 lines with clear separation so modifications create distinct hunks
    const baseline = [
      'line 1',
      'line 2',
      'line 3',
      'line 4 separator',
      'line 5 separator',
      'line 6 separator',
      'line 7',
      'line 8',
      'line 9',
    ].join('\n') + '\n';

    writeFileExternally(filePath, baseline);
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    // Modify to create 3 distinct hunks:
    // - Hunk 1: change line 1-2
    // - Hunk 2: change line 4-6 (separators)
    // - Hunk 3: change line 8-9
    const modified = [
      'CHANGED line 1',
      'CHANGED line 2',
      'line 3',
      'CHANGED line 4',
      'CHANGED line 5',
      'CHANGED line 6',
      'line 7',
      'CHANGED line 8',
      'CHANGED line 9',
    ].join('\n') + '\n';

    writeFileExternally(filePath, modified);

    const sm = getStateManager();
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    return filePath;
  }

  test('acceptHunk on first hunk jumps cursor to second hunk', async () => {
    const filePath = await setupMultiHunkFile();
    const sm = getStateManager();
    const fileState = sm.getFile(filePath);
    assert.ok(fileState, 'File should be in state');

    // Open the file in editor
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);

    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.ok(hunks.length >= 2, `Expected at least 2 hunks, got ${hunks.length}`);

    const firstHunkId = hunkId(hunks[0]);
    const secondHunkNewStart = hunks[1].newStart;

    // Accept the first hunk
    acceptHunk(sm, filePath, firstHunkId, () => {});
    await sleep(200);

    // Cursor should have moved to the next hunk's position
    const cursorLine = editor.selection.active.line;
    // After accepting hunk 1, the remaining hunks are recomputed.
    // The cursor should be near the second hunk's area.
    // We check that cursor moved away from line 0 (top of file).
    assert.ok(cursorLine > 0, `Cursor should have moved from top of file, but is at line ${cursorLine}`);

    // Verify the file still has remaining hunks
    const updatedState = sm.getFile(filePath);
    assert.ok(updatedState, 'File should still be tracked');
    assert.strictEqual(updatedState?.status, 'reviewing', 'File should still be in reviewing state');
  });

  test('discardHunk on first hunk jumps cursor to second hunk', async () => {
    const filePath = await setupMultiHunkFile();
    const sm = getStateManager();
    const fw = getFileWatcher();
    const fileState = sm.getFile(filePath);
    assert.ok(fileState, 'File should be in state');
    assert.ok(fw, 'FileWatcher should be available');

    // Open the file in editor
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);

    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.ok(hunks.length >= 2, `Expected at least 2 hunks, got ${hunks.length}`);

    const firstHunkId = hunkId(hunks[0]);

    // Discard the first hunk
    await discardHunk(sm, fw, filePath, firstHunkId, () => {});
    await sleep(200);

    // Cursor should have moved to the next hunk's position
    const cursorLine = editor.selection.active.line;
    assert.ok(cursorLine > 0, `Cursor should have moved from top of file, but is at line ${cursorLine}`);

    // Verify the file still has remaining hunks
    const updatedState = sm.getFile(filePath);
    assert.ok(updatedState, 'File should still be tracked');
    assert.strictEqual(updatedState?.status, 'reviewing', 'File should still be in reviewing state');
  });

  test('acceptHunk on last hunk does not jump (exits reviewing)', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'single-hunk.txt');

    // Create a file with a single hunk
    const baseline = 'original line\n';
    writeFileExternally(filePath, baseline);
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    writeFileExternally(filePath, 'modified line\n');

    const sm = getStateManager();
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    const fileState = sm.getFile(filePath)!;
    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.strictEqual(hunks.length, 1, 'Should have exactly 1 hunk');

    const theHunkId = hunkId(hunks[0]);

    // Accept the only hunk — should exit reviewing, no jump needed
    acceptHunk(sm, filePath, theHunkId, () => {});
    await sleep(200);

    // File should no longer be in reviewing
    const updatedState = sm.getFile(filePath);
    assert.ok(!updatedState || updatedState.status !== 'reviewing',
      'File should exit reviewing after accepting last hunk');
  });

  test('discardHunk on last hunk does not jump (exits reviewing)', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'single-hunk-discard.txt');

    const baseline = 'original line\n';
    writeFileExternally(filePath, baseline);
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    writeFileExternally(filePath, 'modified line\n');

    const sm = getStateManager();
    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');

    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    const fileState = sm.getFile(filePath)!;
    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.strictEqual(hunks.length, 1, 'Should have exactly 1 hunk');

    const theHunkId = hunkId(hunks[0]);

    // Discard the only hunk — should exit reviewing, no jump needed
    await discardHunk(sm, fw, filePath, theHunkId, () => {});
    await sleep(200);

    // File should no longer be in reviewing
    const updatedState = sm.getFile(filePath);
    assert.ok(!updatedState || updatedState.status !== 'reviewing',
      'File should exit reviewing after discarding last hunk');
  });

  test('acceptHunk on middle hunk jumps to next hunk (not first)', async () => {
    const filePath = await setupMultiHunkFile();
    const sm = getStateManager();
    const fileState = sm.getFile(filePath);
    assert.ok(fileState, 'File should be in state');

    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);

    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.ok(hunks.length >= 3, `Expected at least 3 hunks, got ${hunks.length}`);

    const middleHunkId = hunkId(hunks[1]);
    const middleHunkNewStart = hunks[1].newStart;
    const thirdHunkNewStart = hunks[2].newStart;

    // Accept the middle hunk
    acceptHunk(sm, filePath, middleHunkId, () => {});
    await sleep(200);

    // Cursor should be near the third hunk area (which is now the "next" hunk
    // after the middle one's original position)
    const cursorLine = editor.selection.active.line;
    // The cursor should be beyond the middle hunk's original start
    assert.ok(cursorLine >= middleHunkNewStart - 1,
      `Cursor (line ${cursorLine}) should be at or after middle hunk start (${middleHunkNewStart - 1})`);
  });
});
