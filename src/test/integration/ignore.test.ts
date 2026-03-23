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

/**
 * Write a file via VSCode API to ensure FileSystemWatcher events fire reliably.
 */
async function writeFileViaVSCode(filePath: string, content: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const uri = vscode.Uri.file(filePath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
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
    }, 15000, 500);

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
    }, 15000, 500);

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
    await sleep(1500);
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
    }, 15000, 500);

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
    }, 15000, 500);

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
    // (simulates settings changed while VSCode was closed, or edited via another tool)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    settings.ignorePatterns = ['.git', 'logs'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    // Wait for fs.watch on hunkwise dir to detect settings.json change and trigger syncIgnore
    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return !tracked.includes(relIgnored);
    }, 15000, 500);

    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes(relIgnored), `"${relIgnored}" should not be tracked after adding 'logs' to ignorePatterns`);
    assert.ok(tracked.includes(relNormal), `"${relNormal}" should still be tracked`);
  });

  test('stale baselines from a previous session are cleaned on sync', async () => {
    const root = getWorkspaceRoot();

    // Create .gitignore first so it's loaded before enable
    writeFileExternally(path.join(root, '.gitignore'), 'stale-dir/\n');
    await sleep(1000); // let watcher pick up .gitignore

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
    // This is what would happen if the file was tracked before .gitignore was updated,
    // and VSCode was closed before syncIgnore could clean it up.
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
    await sleep(2000);

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
    await sleep(1000);

    // Create files inside the ignored directory and a normal file
    writeFileExternally(path.join(root, 'build-output', 'bundle.js'), 'compiled code\n');
    writeFileExternally(path.join(root, 'build-output', 'sub', 'chunk.js'), 'chunk code\n');
    // A file with similar name but NOT a directory should NOT be ignored
    writeFileExternally(path.join(root, 'build-output.log'), 'log data\n');
    writeFileExternally(path.join(root, 'src', 'index.ts'), 'source\n');

    await enableHunkwise();

    await waitForCondition(() => gitListTracked(root).includes('src/index.ts'), 8000);
    await sleep(1000);

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
    await sleep(1000);

    // Now add tmpdir/ to .gitignore — syncIgnoreState should:
    // 1. Remove git baseline for tmpdir/tracked.txt
    // 2. Remove in-memory reviewing state for tmpdir/tracked.txt
    await writeFileViaVSCode(path.join(root, '.gitignore'), 'tmpdir/\n');

    // Wait for git to remove the baseline
    await waitForCondition(() => !gitListTracked(root).includes('tmpdir/tracked.txt'), 15000, 500);

    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes('tmpdir/tracked.txt'),
      'tmpdir/tracked.txt should be removed from git after syncIgnoreState');
    assert.ok(tracked.includes('keep.txt'), 'keep.txt should still be tracked');

    // Now externally write a NEW file in the ignored dir.
    // If in-memory state was properly cleared for tmpdir/tracked.txt AND
    // shouldIgnore works for new files under tmpdir/, neither file should appear in git.
    writeFileExternally(path.join(root, 'tmpdir', 'new.txt'), 'new content\n');
    await sleep(1500);

    const tracked2 = gitListTracked(root);
    assert.ok(!tracked2.includes('tmpdir/new.txt'),
      'new file in ignored dir should not be tracked after syncIgnoreState cleared the dir');
    assert.ok(!tracked2.includes('tmpdir/tracked.txt'),
      'previously reviewing file should remain removed from git');
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
    }, 15000, 500);

    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes('dist/app.js'),
      `dist/app.js should be removed after adding dist/ to .gitignore (tracked: ${tracked.join(', ')})`);
    assert.ok(tracked.includes('keep.txt'), 'keep.txt should still be tracked');
  });
});
