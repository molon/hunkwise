import * as Diff from 'diff';

export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  removedContent: string[];  // lines from baseline that were removed
  addedContent: string[];    // lines in current content that were added
}

// Stable id derived from hunk position — same hunk always gets the same id
// within a single review session (no random component needed).
export function hunkId(hunk: ParsedHunk): string {
  return `${hunk.newStart}:${hunk.newLines}:${hunk.oldStart}:${hunk.oldLines}`;
}

export function computeHunks(baseline: string, current: string): ParsedHunk[] {
  const changes = Diff.diffLines(baseline, current);

  const hunks: ParsedHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];

    if (!change.added && !change.removed) {
      // Context lines — advance line counters using count field
      const lineCount = change.count ?? 0;
      oldLine += lineCount;
      newLine += lineCount;
      i++;
      continue;
    }

    // Start of a changed region — collect consecutive added/removed blocks
    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    const removed: string[] = [];
    const added: string[] = [];

    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      const c = changes[i];
      // Split into lines; the value ends with \n for most lines
      const lines = c.value.endsWith('\n')
        ? c.value.slice(0, -1).split('\n')
        : c.value.split('\n');

      if (c.removed) {
        removed.push(...lines);
        oldLine += lines.length;
      } else if (c.added) {
        added.push(...lines);
        newLine += lines.length;
      }
      i++;
    }

    if (removed.length > 0 || added.length > 0) {
      hunks.push({
        oldStart: hunkOldStart,
        oldLines: removed.length,
        newStart: hunkNewStart,
        newLines: added.length,
        removedContent: removed,
        addedContent: added,
      });
    }
  }

  return hunks;
}

