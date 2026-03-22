import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeHunks, hunkId } from '../diffEngine';

describe('computeHunks', () => {
  it('returns empty for identical content', () => {
    assert.deepEqual(computeHunks('a\nb\n', 'a\nb\n'), []);
  });

  it('returns empty for both empty', () => {
    assert.deepEqual(computeHunks('', ''), []);
  });

  it('detects a single line addition', () => {
    const hunks = computeHunks('a\nb\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.deepEqual(hunks[0].addedContent, ['c']);
    assert.deepEqual(hunks[0].removedContent, []);
  });

  it('detects a single line removal', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nb\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.equal(hunks[0].oldLines, 1);
    assert.deepEqual(hunks[0].removedContent, ['c']);
  });

  it('detects a line replacement', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nX\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 1);
    assert.deepEqual(hunks[0].addedContent, ['X']);
    assert.deepEqual(hunks[0].removedContent, ['b']);
  });

  it('detects multiple separate hunks', () => {
    const baseline = 'a\nb\nc\nd\ne\n';
    const current  = 'A\nb\nc\nd\nE\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 2);
    assert.deepEqual(hunks[0].addedContent, ['A']);
    assert.deepEqual(hunks[1].addedContent, ['E']);
  });

  it('treats entire new content as one hunk when baseline is empty', () => {
    const hunks = computeHunks('', 'hello\nworld\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.equal(hunks[0].newLines, 2);
    assert.equal(hunks[0].newStart, 1);
  });

  it('treats entire deletion as one hunk when current is empty', () => {
    const hunks = computeHunks('hello\nworld\n', '');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.equal(hunks[0].oldLines, 2);
  });

  it('computes correct newStart line numbers', () => {
    const baseline = 'a\nb\nc\n';
    const current  = 'a\nb\nX\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks[0].newStart, 3);
    assert.equal(hunks[0].oldStart, 3);
  });

  it('adjacent changes are merged into one hunk', () => {
    const hunks = computeHunks('a\nb\n', 'X\nY\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 2);
    assert.equal(hunks[0].newLines, 2);
  });

  it('content without trailing newline', () => {
    const hunks = computeHunks('a\nb', 'a\nX');
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].removedContent, ['b']);
    assert.deepEqual(hunks[0].addedContent, ['X']);
  });

  it('insertion at the beginning', () => {
    const hunks = computeHunks('b\nc\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].oldStart, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.deepEqual(hunks[0].addedContent, ['a']);
  });

  it('deletion at the beginning', () => {
    const hunks = computeHunks('a\nb\nc\n', 'b\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.deepEqual(hunks[0].removedContent, ['a']);
  });

  it('insertion at the end', () => {
    const hunks = computeHunks('a\nb\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.deepEqual(hunks[0].addedContent, ['c']);
  });

  it('deletion at the end', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nb\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.equal(hunks[0].oldLines, 1);
    assert.deepEqual(hunks[0].removedContent, ['c']);
  });

  it('multiple non-adjacent hunks preserve correct line numbers', () => {
    // Change line 1 and line 5; lines 2-4 are context
    const baseline = '1\n2\n3\n4\n5\n';
    const current  = 'X\n2\n3\n4\nY\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 2);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].oldStart, 1);
    assert.equal(hunks[1].newStart, 5);
    assert.equal(hunks[1].oldStart, 5);
  });

  it('pure insertion (no removed lines) in the middle', () => {
    const hunks = computeHunks('a\nc\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.equal(hunks[0].newLines, 1);
    assert.deepEqual(hunks[0].addedContent, ['b']);
  });

  it('pure deletion (no added lines) in the middle', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.deepEqual(hunks[0].removedContent, ['b']);
  });

  it('large block replacement', () => {
    const baseline = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const current  = 'NEW\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 10);
    assert.equal(hunks[0].newLines, 1);
  });
});  // end computeHunks

describe('hunkId', () => {
  it('produces stable id from hunk fields', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nX\nc\n');
    const id = hunkId(hunks[0]);
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
    // Same hunk always produces the same id
    assert.equal(hunkId(hunks[0]), id);
  });

  it('different hunks have different ids', () => {
    const baseline = 'a\nb\nc\nd\ne\n';
    const current  = 'A\nb\nc\nd\nE\n';
    const hunks = computeHunks(baseline, current);
    assert.notEqual(hunkId(hunks[0]), hunkId(hunks[1]));
  });

  it('id format is newStart:newLines:oldStart:oldLines', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nX\nc\n');
    const h = hunks[0];
    assert.equal(hunkId(h), `${h.newStart}:${h.newLines}:${h.oldStart}:${h.oldLines}`);
  });
});
