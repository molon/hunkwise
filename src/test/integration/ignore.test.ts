import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import { execSync } from 'child_process';
import {
  getWorkspaceRoot, hunkwiseGitEnv, gitListTracked,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, writeFileViaVSCode, cleanWorkspace,
} from './helpers';

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
    }, 15000, 200);

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
    }, 15000, 200);

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
    await sleep(300);
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
    }, 15000, 200);

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
    }, 15000, 200);

    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(relDeep), `"${relDeep}" should not be tracked after ignoring vendor/`);
    assert.ok(tracked.includes(relTop), `"${relTop}" should still be tracked`);
  });

  test('ignorePatterns changed externally in settings.json triggers sync on reload', async () => {
    const root = getWorkspaceRoot();
    const settingsPath = path.join(root, '.vscode', 'hunkwise', 'settings.json');

    // Create files
    const ignoredFile = path.join(root, 'logs', 'app.log');
    const normalFile = path.join(root, 'index.txt');
    writeFileExternally(ignoredFile, 'log data\n');
    writeFileExternally(normalFile, 'index data\n');

    await enableHunkwise();

    const relIgnored = path.relative(root, ignoredFile);
    const relNormal = path.relative(root, normalFile);

    // Wait for both files to be tracked
    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return tracked.includes(relIgnored) && tracked.includes(relNormal);
    }, 8000);

    // Externally modify settings.json to add 'logs' to ignorePatterns
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    settings.ignorePatterns = ['.git', 'logs'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    // Wait for fs.watch on hunkwise dir to detect settings.json change and trigger syncIgnore
    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return !tracked.includes(relIgnored);
    }, 15000, 200);

    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(relIgnored), `"${relIgnored}" should not be tracked after adding 'logs' to ignorePatterns`);
    assert.ok(tracked.includes(relNormal), `"${relNormal}" should still be tracked`);
  });

  test('stale baselines from a previous session are cleaned on sync', async () => {
    const root = getWorkspaceRoot();

    // Create .gitignore first so it's loaded before enable
    writeFileExternally(path.join(root, '.gitignore'), 'stale-dir/\n');
    await sleep(300);

    // Create a normal file
    writeFileExternally(path.join(root, 'normal.txt'), 'normal\n');
    // Also create files in the ignored dir (on disk but should not be tracked)
    writeFileExternally(path.join(root, 'stale-dir', 'old.txt'), 'stale data\n');

    await enableHunkwise();

    // normal.txt should be tracked, stale-dir/old.txt should not
    await waitForCondition(() => gitListTracked(root).includes('normal.txt'), 8000);
    let tracked = gitListTracked(root);
    assert.ok(!tracked.includes('stale-dir/old.txt'), 'ignored file should not be tracked on enable');

    // Simulate a "previous session" leaving stale data in the hunkwise git repo:
    // Inject stale-dir/old.txt directly into the git index, bypassing StateManager.
    const env = hunkwiseGitEnv(root);
    const hash = execSync('git hash-object -w --stdin', {
      cwd: root, env, encoding: 'utf-8', input: 'stale data\n',
    }).trim();
    execSync(`git update-index --add --cacheinfo 100644,${hash},stale-dir/old.txt`, {
      cwd: root, env,
    });
    execSync('git commit --amend --no-edit --allow-empty', { cwd: root, env });

    // Verify the stale file is now in git (simulating leftover from previous session)
    tracked = gitListTracked(root);
    assert.ok(tracked.includes('stale-dir/old.txt'), 'stale file should be in git after injection');

    // Trigger syncIgnoreState (as activation would do on restart)
    await vscode.commands.executeCommand('hunkwise.setRespectGitignore', true);

    await waitForCondition(() => {
      return !gitListTracked(root).includes('stale-dir/old.txt');
    }, 15000, 200);

    // The stale file should be cleaned up
    tracked = gitListTracked(root);
    assert.ok(!tracked.includes('stale-dir/old.txt'),
      `stale-dir/old.txt should be removed after sync (tracked: ${tracked.join(', ')})`);
    assert.ok(tracked.includes('normal.txt'), 'normal.txt should still be tracked');
  });

  test('directory-only gitignore patterns (trailing slash) prevent tracking on enable', async () => {
    const root = getWorkspaceRoot();

    // .gitignore with directory-only pattern (trailing slash)
    writeFileExternally(path.join(root, '.gitignore'), 'build-output/\n');
    await sleep(300);

    // Create files inside the ignored directory and a normal file
    writeFileExternally(path.join(root, 'build-output', 'bundle.js'), 'compiled code\n');
    writeFileExternally(path.join(root, 'build-output', 'sub', 'chunk.js'), 'chunk code\n');
    // A file with similar name but NOT a directory should NOT be ignored
    writeFileExternally(path.join(root, 'build-output.log'), 'log data\n');
    writeFileExternally(path.join(root, 'src', 'index.ts'), 'source\n');

    await enableHunkwise();

    await waitForCondition(() => {
      const t = gitListTracked(root);
      return t.includes('src/index.ts') && t.includes('build-output.log');
    }, 8000);

    const tracked = gitListTracked(root);
    assert.ok(tracked.includes('src/index.ts'), 'src/index.ts should be tracked');
    assert.ok(tracked.includes('build-output.log'), 'build-output.log should be tracked (not a directory)');
    assert.ok(!tracked.includes('build-output/bundle.js'),
      `build-output/bundle.js should NOT be tracked (tracked: ${tracked.join(', ')})`);
    assert.ok(!tracked.includes('build-output/sub/chunk.js'),
      'build-output/sub/chunk.js should NOT be tracked');
  });

  test('syncIgnoreState removes in-memory reviewing state for newly-ignored files without git baseline', async () => {
    const root = getWorkspaceRoot();

    // Create a file and enable hunkwise so it gets a baseline
    writeFileExternally(path.join(root, 'keep.txt'), 'keep\n');
    writeFileExternally(path.join(root, 'tmpdir', 'tracked.txt'), 'original\n');
    await enableHunkwise();
    await waitForCondition(() => {
      const t = gitListTracked(root);
      return t.includes('keep.txt') && t.includes('tmpdir/tracked.txt');
    }, 8000);

    // Externally modify tmpdir/tracked.txt so it enters reviewing state (has diff vs baseline)
    writeFileExternally(path.join(root, 'tmpdir', 'tracked.txt'), 'modified by tool\n');
    await sleep(500);

    // Now add tmpdir/ to .gitignore — syncIgnoreState should:
    // 1. Remove git baseline for tmpdir/tracked.txt
    // 2. Remove in-memory reviewing state for tmpdir/tracked.txt
    await writeFileViaVSCode(path.join(root, '.gitignore'), 'tmpdir/\n');

    // Wait for git to remove the baseline
    await waitForCondition(() => !gitListTracked(root).includes('tmpdir/tracked.txt'), 15000, 200);

    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes('tmpdir/tracked.txt'),
      'tmpdir/tracked.txt should be removed from git after syncIgnoreState');
    assert.ok(tracked.includes('keep.txt'), 'keep.txt should still be tracked');

    // Now externally write a NEW file in the ignored dir.
    writeFileExternally(path.join(root, 'tmpdir', 'new.txt'), 'new content\n');
    await sleep(500);

    const tracked2 = gitListTracked(root);
    assert.ok(!tracked2.includes('tmpdir/new.txt'),
      'new file in ignored dir should not be tracked after syncIgnoreState cleared the dir');
    assert.ok(!tracked2.includes('tmpdir/tracked.txt'),
      'previously reviewing file should remain removed from git');
  });

  test('externally created files in gitignored directory are not tracked or stored in git', async () => {
    const root = getWorkspaceRoot();

    // Set up .gitignore with a directory pattern BEFORE enabling hunkwise
    writeFileExternally(path.join(root, '.gitignore'), '.vscode-test/\n');
    await sleep(300);

    // Create a normal file that should be tracked
    writeFileExternally(path.join(root, 'normal.txt'), 'normal content\n');

    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('normal.txt'), 8000);

    // Now externally create files under the ignored directory
    await writeFileViaVSCode(
      path.join(root, '.vscode-test', 'user-data', 'Session Storage', 'LOG'),
      'some log data\nline 2\nline 3\n'
    );
    await writeFileViaVSCode(
      path.join(root, '.vscode-test', 'user-data', 'Session Storage', 'LOG.old'),
      'old log data\nline 2\nline 3\n'
    );
    await writeFileViaVSCode(
      path.join(root, '.vscode-test', 'user-data', 'TransportSecurity'),
      'transport data\n'
    );
    await sleep(500);

    // Verify: none of these files should appear in hunkwise git
    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes('.vscode-test/user-data/Session Storage/LOG'),
      `Session Storage/LOG should NOT be tracked (tracked: ${tracked.join(', ')})`);
    assert.ok(!tracked.includes('.vscode-test/user-data/Session Storage/LOG.old'),
      `Session Storage/LOG.old should NOT be tracked`);
    assert.ok(!tracked.includes('.vscode-test/user-data/TransportSecurity'),
      `TransportSecurity should NOT be tracked`);

    // Verify: normal.txt should still be tracked
    assert.ok(tracked.includes('normal.txt'), 'normal.txt should still be tracked');
  });

  test('directory-only gitignore patterns are cleaned by syncIgnoreState', async () => {
    const root = getWorkspaceRoot();

    // Enable without .gitignore first
    writeFileExternally(path.join(root, 'dist', 'app.js'), 'app code\n');
    writeFileExternally(path.join(root, 'keep.txt'), 'keep\n');

    await enableHunkwise();
    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return tracked.includes('dist/app.js') && tracked.includes('keep.txt');
    }, 8000);

    // Now add dist/ to .gitignore — syncIgnoreState should remove dist/app.js
    await writeFileViaVSCode(path.join(root, '.gitignore'), 'dist/\n');

    await waitForCondition(() => {
      return !gitListTracked(root).includes('dist/app.js');
    }, 15000, 200);

    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes('dist/app.js'),
      `dist/app.js should be removed after adding dist/ to .gitignore (tracked: ${tracked.join(', ')})`);
    assert.ok(tracked.includes('keep.txt'), 'keep.txt should still be tracked');
  });

  test('nested .gitignore rules are respected', async () => {
    const root = getWorkspaceRoot();

    // Root .gitignore: ignore node_modules/
    writeFileExternally(path.join(root, '.gitignore'), 'node_modules/\n');
    // Sub-directory .gitignore in src/: ignore *.tmp and build/
    writeFileExternally(path.join(root, 'src', '.gitignore'), '*.tmp\nbuild/\n');

    // Create files: some should be tracked, some ignored
    writeFileExternally(path.join(root, 'keep.txt'), 'keep\n');
    writeFileExternally(path.join(root, 'src', 'app.ts'), 'code\n');
    writeFileExternally(path.join(root, 'src', 'debug.tmp'), 'temp\n');
    writeFileExternally(path.join(root, 'src', 'build', 'out.js'), 'built\n');
    writeFileExternally(path.join(root, 'src', 'sub', 'deep.tmp'), 'deep temp\n');
    writeFileExternally(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module\n');
    // A .tmp file NOT in src/ should be tracked (rule scoped to src/)
    writeFileExternally(path.join(root, 'root.tmp'), 'root temp\n');

    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('keep.txt'), 8000);

    const tracked = gitListTracked(root);
    assert.ok(tracked.includes('keep.txt'), 'keep.txt should be tracked');
    assert.ok(tracked.includes('src/app.ts'), 'src/app.ts should be tracked');
    assert.ok(tracked.includes('root.tmp'), 'root.tmp should be tracked (not in src/)');
    assert.ok(!tracked.includes('src/debug.tmp'), 'src/debug.tmp should be ignored by src/.gitignore');
    assert.ok(!tracked.includes('src/sub/deep.tmp'), 'src/sub/deep.tmp should be ignored by src/.gitignore');
    assert.ok(!tracked.includes('src/build/out.js'), 'src/build/out.js should be ignored by src/.gitignore');
    assert.ok(!tracked.some(f => f.startsWith('node_modules/')), 'node_modules/ should be ignored');
  });

  test('non-ASCII file and directory names are tracked correctly', async () => {
    const root = getWorkspaceRoot();

    // Create files with non-ASCII names — verifies shouldIgnore does not
    // crash or mishandle paths containing multibyte characters (the
    // regression this PR targets with asRelativePath).
    writeFileExternally(path.join(root, '中文目录', '文件.txt'), 'content\n');
    writeFileExternally(path.join(root, 'données', 'résumé.txt'), 'french\n');
    writeFileExternally(path.join(root, 'normal.txt'), 'normal\n');

    await enableHunkwise();

    // All files should be tracked (shouldIgnore must not reject non-ASCII paths)
    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return tracked.includes('normal.txt') && tracked.some(f => f.includes('文件.txt'));
    }, 8000);

    const tracked = gitListTracked(root);
    assert.ok(tracked.some(f => f.includes('文件.txt')), 'Non-ASCII (Chinese) file should be tracked');
    assert.ok(tracked.some(f => f.includes('résumé.txt')), 'Non-ASCII (accented) file should be tracked');
    assert.ok(tracked.includes('normal.txt'), 'normal.txt should be tracked');
  });

  test('adding nested .gitignore removes already-tracked files via syncIgnoreState', async () => {
    const root = getWorkspaceRoot();

    // Start with no nested .gitignore — all files tracked
    writeFileExternally(path.join(root, 'src', 'app.ts'), 'code\n');
    writeFileExternally(path.join(root, 'src', 'debug.tmp'), 'temp\n');

    await enableHunkwise();
    await waitForCondition(() => gitListTracked(root).includes('src/debug.tmp'), 8000);

    // Now add a nested .gitignore that ignores *.tmp
    await writeFileViaVSCode(path.join(root, 'src', '.gitignore'), '*.tmp\n');

    // syncIgnoreState should remove src/debug.tmp
    await waitForCondition(() => !gitListTracked(root).includes('src/debug.tmp'), 15000, 200);

    const tracked = gitListTracked(root);
    assert.ok(tracked.includes('src/app.ts'), 'src/app.ts should still be tracked');
    assert.ok(!tracked.includes('src/debug.tmp'), 'src/debug.tmp should be removed after nested .gitignore added');
  });
});
