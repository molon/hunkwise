import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HunkwiseGit } from '../hunkwiseGit';

let tmpDir: string;
let hunkwiseDir: string;
let git: HunkwiseGit;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkwise-test-'));
  hunkwiseDir = path.join(tmpDir, '.vscode', 'hunkwise');
  git = new HunkwiseGit(hunkwiseDir, tmpDir);
  await git.initGit();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('HunkwiseGit', () => {
  describe('initGit', () => {
    it('creates the git directory', () => {
      assert.ok(fs.existsSync(path.join(hunkwiseDir, 'git')));
    });

    it('is idempotent — calling twice does not throw', async () => {
      await git.initGit();
      assert.ok(fs.existsSync(path.join(hunkwiseDir, 'git')));
    });
  });

  describe('snapshot / getBaseline', () => {
    it('returns undefined for untracked file', async () => {
      const result = await git.getBaseline(path.join(tmpDir, 'nonexistent.txt'));
      assert.equal(result, undefined);
    });

    it('stores and retrieves content', async () => {
      const filePath = path.join(tmpDir, 'hello.txt');
      await git.snapshot(filePath, 'hello world\n');
      const baseline = await git.getBaseline(filePath);
      assert.equal(baseline, 'hello world\n');
    });

    it('overwrites previous snapshot', async () => {
      const filePath = path.join(tmpDir, 'update.txt');
      await git.snapshot(filePath, 'v1\n');
      await git.snapshot(filePath, 'v2\n');
      const baseline = await git.getBaseline(filePath);
      assert.equal(baseline, 'v2\n');
    });

    it('handles empty content', async () => {
      const filePath = path.join(tmpDir, 'empty.txt');
      await git.snapshot(filePath, '');
      const baseline = await git.getBaseline(filePath);
      assert.equal(baseline, '');
    });

    it('handles multi-line content', async () => {
      const filePath = path.join(tmpDir, 'multi.txt');
      const content = 'line1\nline2\nline3\n';
      await git.snapshot(filePath, content);
      assert.equal(await git.getBaseline(filePath), content);
    });

    it('handles content with special characters', async () => {
      const filePath = path.join(tmpDir, 'special.txt');
      const content = 'hello "world" & <foo>\n';
      await git.snapshot(filePath, content);
      assert.equal(await git.getBaseline(filePath), content);
    });
  });

  describe('snapshotBatch', () => {
    it('snapshots multiple files atomically', async () => {
      const files = [
        { filePath: path.join(tmpDir, 'batch1.txt'), content: 'batch1\n' },
        { filePath: path.join(tmpDir, 'batch2.txt'), content: 'batch2\n' },
        { filePath: path.join(tmpDir, 'batch3.txt'), content: 'batch3\n' },
      ];
      await git.snapshotBatch(files);
      for (const { filePath, content } of files) {
        assert.equal(await git.getBaseline(filePath), content);
      }
    });

    it('is a no-op for empty array', async () => {
      await git.snapshotBatch([]);
    });

    it('getBaseline is immediately available after snapshotBatch', async () => {
      const filePath = path.join(tmpDir, 'immediate.txt');
      await git.snapshotBatch([{ filePath, content: 'immediate\n' }]);
      // Must be readable right away without any extra commit
      assert.equal(await git.getBaseline(filePath), 'immediate\n');
    });
  });

  describe('removeFile', () => {
    it('removes a tracked file', async () => {
      const filePath = path.join(tmpDir, 'toremove.txt');
      await git.snapshot(filePath, 'remove me\n');
      assert.notEqual(await git.getBaseline(filePath), undefined);
      await git.removeFile(filePath);
      assert.equal(await git.getBaseline(filePath), undefined);
    });

    it('is a no-op for untracked file', async () => {
      const filePath = path.join(tmpDir, 'never-tracked.txt');
      await git.removeFile(filePath); // should not throw
    });
  });

  describe('listTrackedFiles', () => {
    it('returns empty when nothing tracked', async () => {
      // fresh instance to avoid interference
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkwise-list-'));
      const g2 = new HunkwiseGit(path.join(dir2, '.vscode', 'hunkwise'), dir2);
      await g2.initGit();
      const files = await g2.listTrackedFiles();
      assert.deepEqual(files, []);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('returns tracked file paths', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkwise-list2-'));
      const root = dir2;
      const g2 = new HunkwiseGit(path.join(dir2, '.vscode', 'hunkwise'), root);
      await g2.initGit();
      const f1 = path.join(root, 'a.txt');
      const f2 = path.join(root, 'b.txt');
      await g2.snapshotBatch([
        { filePath: f1, content: 'a\n' },
        { filePath: f2, content: 'b\n' },
      ]);
      const tracked = await g2.listTrackedFiles();
      assert.ok(tracked.includes(f1));
      assert.ok(tracked.includes(f2));
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });

  describe('settings', () => {
    it('returns defaults when no settings file exists', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkwise-settings-'));
      const g2 = new HunkwiseGit(path.join(dir2, '.vscode', 'hunkwise'), dir2);
      const s = g2.loadSettings();
      assert.deepEqual(s.ignorePatterns, ['.git']);
      assert.equal(s.respectGitignore, true);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('round-trips settings', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkwise-settings2-'));
      const g2 = new HunkwiseGit(path.join(dir2, '.vscode', 'hunkwise'), dir2);
      g2.saveSettings({ ignorePatterns: ['node_modules', 'dist'], respectGitignore: false });
      const s = g2.loadSettings();
      assert.deepEqual(s.ignorePatterns, ['node_modules', 'dist']);
      assert.equal(s.respectGitignore, false);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('mergeDefaultSettings fills missing fields', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkwise-merge-'));
      const g2 = new HunkwiseGit(path.join(dir2, '.vscode', 'hunkwise'), dir2);
      // Write partial settings (no respectGitignore)
      fs.mkdirSync(path.join(dir2, '.vscode', 'hunkwise'), { recursive: true });
      fs.writeFileSync(
        path.join(dir2, '.vscode', 'hunkwise', 'settings.json'),
        JSON.stringify({ ignorePatterns: ['dist'] }),
        'utf-8'
      );
      const merged = g2.mergeDefaultSettings({ ignorePatterns: ['.git'], respectGitignore: true });
      // Existing value preserved
      assert.deepEqual(merged.ignorePatterns, ['dist']);
      // Missing field filled from defaults
      assert.equal(merged.respectGitignore, true);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('mergeDefaultSettings preserves all existing fields', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkwise-merge2-'));
      const g2 = new HunkwiseGit(path.join(dir2, '.vscode', 'hunkwise'), dir2);
      g2.saveSettings({ ignorePatterns: ['custom'], respectGitignore: false });
      const merged = g2.mergeDefaultSettings({ ignorePatterns: ['.git'], respectGitignore: true });
      assert.deepEqual(merged.ignorePatterns, ['custom']);
      assert.equal(merged.respectGitignore, false);
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });

  describe('destroyGit', () => {
    it('removes the git directory', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkwise-destroy-'));
      const hDir = path.join(dir2, '.vscode', 'hunkwise');
      const g2 = new HunkwiseGit(hDir, dir2);
      await g2.initGit();
      assert.ok(fs.existsSync(path.join(hDir, 'git')));
      g2.destroyGit();
      assert.ok(!fs.existsSync(path.join(hDir, 'git')));
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('preserves settings.json after destroy', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkwise-destroy2-'));
      const hDir = path.join(dir2, '.vscode', 'hunkwise');
      const g2 = new HunkwiseGit(hDir, dir2);
      await g2.initGit();
      g2.saveSettings({ ignorePatterns: ['dist'], respectGitignore: false });
      g2.destroyGit();
      assert.ok(fs.existsSync(path.join(hDir, 'settings.json')));
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });
});
