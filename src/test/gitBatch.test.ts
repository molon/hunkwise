import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HunkwiseGit } from '../hunkwiseGit';
import { readIndexBlobs } from '../gitBatch';

let tmpDir: string;
let hunkwiseDir: string;
let git: HunkwiseGit;

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: path.join(hunkwiseDir, 'git'),
    GIT_WORK_TREE: tmpDir,
    GIT_TERMINAL_PROMPT: '0',
  };
}

function batch(rels: string[], maxBytes?: number) {
  return readIndexBlobs(rels, { cwd: tmpDir, env: env(), ...(maxBytes ? { maxBytes } : {}) });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkwise-batch-'));
  hunkwiseDir = path.join(tmpDir, '.vscode', 'hunkwise');
  git = new HunkwiseGit(hunkwiseDir, tmpDir);
  await git.initGit();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readIndexBlobs', () => {
  it('returns an empty array for no paths', async () => {
    assert.deepEqual(await batch([]), []);
  });

  it('reads index entries in input order', async () => {
    await git.snapshot(path.join(tmpDir, 'order-a.txt'), 'a\n');
    await git.snapshot(path.join(tmpDir, 'order-b.txt'), 'b\n');

    assert.deepEqual(await batch(['order-b.txt', 'order-a.txt']), ['b\n', 'a\n']);
  });

  it('returns undefined for missing paths without shifting later entries', async () => {
    await git.snapshot(path.join(tmpDir, 'align.txt'), 'align\n');

    assert.deepEqual(await batch(['nope.txt', 'align.txt']), [undefined, 'align\n']);
  });

  it('handles empty and multi-byte content', async () => {
    await git.snapshot(path.join(tmpDir, 'batch-empty.txt'), '');
    await git.snapshot(path.join(tmpDir, 'batch-unicode.txt'), 'héllo — ✓\r\n');

    assert.deepEqual(
      await batch(['batch-empty.txt', 'batch-unicode.txt']),
      ['', 'héllo — ✓\r\n'],
    );
  });

  it('parses output that arrives in many chunks', async () => {
    // ~120 KB across 150 files: well past a single pipe read
    const files = Array.from({ length: 150 }, (_, i) => ({
      filePath: path.join(tmpDir, `chunk-${i}.txt`),
      content: `chunk ${i}\n`.repeat(60),
    }));
    await git.snapshotBatch(files);

    const results = await batch(files.map(f => path.basename(f.filePath)));
    assert.ok(results, 'batch read should succeed');
    assert.equal(results.length, files.length);
    for (let i = 0; i < files.length; i++) {
      assert.equal(results[i], files[i].content, `chunk-${i} should parse intact`);
    }
  });

  it('gives up instead of buffering past maxBytes', async () => {
    await git.snapshot(path.join(tmpDir, 'guard.txt'), 'x'.repeat(4096));

    assert.equal(await batch(['guard.txt'], 64), undefined);
  });

  it('gives up when git cannot run', async () => {
    const results = await readIndexBlobs(['whatever'], {
      cwd: path.join(tmpDir, 'does-not-exist'),
      env: env(),
    });

    assert.equal(results, undefined);
  });
});
