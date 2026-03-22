# hunkwise — Design Document

Date: 2026-03-21

## Overview

A VSCode extension that tracks file changes (from any source), computes diffs against a saved baseline, and provides per-hunk Accept/Discard controls inline in the editor. Does not depend on git.

---

## Core Concepts

### File State Machine

Each file tracked by hunkwise has one of three states:

- **idle**: not tracked, hunkwise does nothing
- **reviewing**: has pending hunks, shows CodeLens and decorations
- **done**: all hunks processed (accepted or discarded) → automatically transitions to idle

### Baseline Snapshot

hunkwise maintains its own "original content" snapshot per file — no git dependency:

- **External write** (`FileSystemWatcher` fires) → if file is idle, save pre-write content as baseline, enter reviewing
- **"Start Tracking" command** → save current disk content as baseline, enter reviewing (for dev/testing)
- Baseline stored as full file content in `.vscode/hunkwise-state.json`

---

## Change Detection

### External Modification (FileSystemWatcher)

- `vscode.workspace.createFileSystemWatcher` watches disk file changes
- On trigger: read disk content, hash-compare with in-editor document content
- **Hash match** → editor-initiated save, skip
- **Hash mismatch** → confirmed external write:
  - File is idle → save pre-write content as baseline, enter reviewing, compute hunks
  - File is reviewing → re-diff current content against original baseline, update hunk list

### Manual Modification (onDidChangeTextDocument)

- Listens to in-editor keystrokes
- File is **idle** → ignore
- File is **reviewing** → re-diff current editor content against baseline, update hunk list (manual changes merge into overall diff)
- Re-diff is debounced (300ms) to avoid triggering on every keystroke

### Protection for Completed Files

Once a file is idle/done:

- `FileSystemWatcher` fires → normal external modification flow, file re-enters reviewing
- `onDidChangeTextDocument` fires → **ignored**, manual edits not tracked

---

## Diff Engine

- Library: [`diff`](https://www.npmjs.com/package/diff) (Myers diff algorithm, line-level)
- Compute diff entirely in-memory against baseline, no git invocation
- Same algorithm level as VSCode inline diffs
- v1: line-level highlighting only (no intra-line character-level highlighting)

Each hunk record:

```ts
interface Hunk {
  id: string;          // uuid
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  status: 'pending' | 'accepted' | 'discarded';
}
```

---

## Persistence

### Storage File

`.vscode/hunkwise-state.json` — add to `.gitignore`

### Structure

```json
{
  "version": 1,
  "files": {
    "/absolute/path/to/file.ts": {
      "status": "reviewing",
      "baseline": "...full original file content...",
      "hunks": [
        {
          "id": "uuid",
          "oldStart": 10,
          "oldLines": 5,
          "newStart": 10,
          "newLines": 7,
          "status": "pending"
        }
      ]
    }
  }
}
```

### Read/Write Timing

- **On activation**: read state file, restore all reviewing files' baselines and hunk states, re-register CodeLens and decorations
- **On any state change**: async write to state file (debounced 500ms)
- **File enters idle**: remove entry from state file
- **On extension deactivate**: flush once to ensure final state is persisted

> Note: baseline stores full file content; large files will produce a large state file. v1 does not compress. Future: store diff instead of full content.

---

## CodeLens & Decorations

### CodeLens

Each pending hunk shows one CodeLens row above its first line:

```
✓ Accept  |  ✕ Discard
```

- accepted/discarded hunks: no CodeLens shown

### Line Decorations

- **Added lines**: green background highlight
- **Deleted lines**: red background + strikethrough (virtual lines via `before` decoration)
- accepted/discarded hunks: decorations cleared

---

## Accept / Discard Logic

### Accept

1. Mark hunk status → `accepted`
2. Clear hunk's CodeLens and decorations
3. File content unchanged (already contains the desired content)
4. If all hunks processed → file enters idle, remove from state

### Discard

1. Use `WorkspaceEdit` to replace the hunk's line range with baseline original content
2. Set "self-initiated edit" flag before applying edit
3. `onDidChangeTextDocument` fires but flag is set → skip re-diff
4. Mark hunk status → `discarded`, clear decorations
5. If all hunks processed → file enters idle, remove from state

### Undo Behaviour

User undoes a Discard: file content reverts to external-tool version → `onDidChangeTextDocument` fires → file is reviewing → re-diff → hunk reappears naturally. No special handling needed.

---

## Bottom Panel Toolbar (WebviewView)

Registered as a VSCode **Panel WebviewView** (appears in the bottom panel area alongside Terminal).

### Layout

```
◀ Prev File   ↑ Prev Hunk   ↓ Next Hunk   ▶ Next File  |  ✓ Accept All   ✕ Discard All
```

- **◀ / ▶**: manually switch between reviewing files
- **↑ / ↓**: navigate between pending hunks within current file (scrolls editor to hunk)
- **Accept All / Discard All**: batch operation on current file
- Style reference: VSCode Chat Edits bottom bar aesthetic

---

## Side Panel — Review Tree (TreeView)

Registered as a VSCode **TreeView** in the Activity Bar sidebar.

### Tree Structure

```
hunkwise
├── src/extension.ts        +12 -3  [3 pending]
│   ├── @line 10  +2 -1
│   ├── @line 34  +8 -0
│   └── @line 67  +2 -2
├── src/diffWatcher.ts      +5 -0   [1 pending]
│   └── @line 22  +5 -0
└── README.md               +1 -1   [2 pending / 1 accepted]
    ├── @line 5   +1 -0
    └── @line 18  +0 -1  ✓
```

### File-level Entry

- Filename (relative path)
- `+N -M` total line stats
- `[N pending]` or `[N pending / M accepted / M discarded]`
- Click → open file and jump to first pending hunk

### Hunk-level Entry

- `@line N` position
- `+N -M` line change count for this hunk
- Accepted: `✓`, Discarded: `✕`, Pending: no marker
- Click → jump to corresponding line in editor

### Panel Toolbar Buttons

- `Accept All Files` / `Discard All Files` — global batch operations
- `Refresh` — manual refresh (usually auto-updates)

---

## File Structure

```
hunkwise/
  src/
    extension.ts          # activate / deactivate, register all components
    fileWatcher.ts        # FileSystemWatcher + onDidChangeTextDocument
    diffEngine.ts         # baseline vs current content diff, parse hunks
    stateManager.ts       # in-memory state + persistence (hunkwise-state.json)
    codeLensProvider.ts   # Accept/Discard CodeLens per pending hunk
    decorationManager.ts  # green/red line highlights
    commands.ts           # accept, discard, acceptAll, discardAll, startTracking
    reviewPanel.ts        # bottom Panel WebviewView (toolbar)
    reviewTreeProvider.ts # sidebar TreeView (review panel)
  media/
    panel.html            # bottom toolbar webview HTML
    panel.css
    panel.js
  package.json
  tsconfig.json
```

## Dependencies

```json
{
  "dependencies": {
    "diff": "^5.x"
  }
}
```

---

## Non-Goals (v1)

- Intra-line character-level highlighting
- Git integration of any kind
- Partial line-level accept/discard
- Diff view in a separate panel
- Any AI integration — hunkwise is purely a review layer
- Compression of baseline content in state file
