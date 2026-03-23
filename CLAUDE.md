# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile       # compile TypeScript to out/
npm run watch         # watch mode compilation
npm test              # compile test config + run unit tests
```

To run a single test file:
```bash
tsc -p ./tsconfig.test.json && node --test out-test/test/diffEngine.test.js
```

Tests use Node's built-in `node:test` runner — no extra test framework.

## Architecture

hunkwise is a VSCode extension that provides per-hunk Accept/Discard controls for any external file change (AI tools, scripts, etc.). It requires the proposed `editorInsets` API and cannot be installed from the marketplace.

### Core data flow

1. **`FileWatcher`** monitors all workspace file changes via VSCode's `FileSystemWatcher` and `onDidChangeTextDocument`. It distinguishes user edits (ignored) from external tool writes (triggers review) by checking if the open document buffer matches the disk content.

2. **`StateManager`** holds in-memory `Map<filePath, FileState>` where `FileState = { status: 'reviewing' | 'idle', baseline: string }`. All mutations are synchronously reflected in memory and asynchronously queued to git via a serial `gitQueue` promise chain.

3. **`HunkwiseGit`** persists baselines in a private git repo at `.vscode/hunkwise/git/` using `GIT_DIR=<hunkwiseDir>/git GIT_WORK_TREE=<workspaceRoot>`. The repo always has at most one commit (each mutation does `--amend`). Settings live in `.vscode/hunkwise/settings.json`.

4. **`DiffEngine`** (`diffEngine.ts`) computes hunks by calling `Diff.diffLines(baseline, current)` from the `diff` npm package. Hunk IDs are stable strings derived from position (`newStart:newLines:oldStart:oldLines`).

5. **`DecorationManager`** renders the diff UI using the proposed `editorInsets` API (`vscode.window.createWebviewTextEditorInset`). For each hunk it creates:
   - A red "deleted lines" inset (HTML webview) above the green block
   - A green line decoration on added lines
   - An "Accept / Discard" action bar inset below the green block

   Insets are reused across refreshes by cache key (`afterLine:height`) to avoid flicker.

6. **`ReviewPanel`** (`reviewPanel.ts`) is the sidebar webview panel showing all pending files with batch actions. It communicates with the extension via `vscode.postMessage`.

### Key behaviors

- **Self-edit suppression**: Before programmatically writing a file (discard/accept), `fileWatcher.markSelfEdit(filePath)` is called so the watcher ignores the resulting disk event.
- **Baseline update on accept hunk**: Accepting a single hunk splices the accepted lines into `fileState.baseline` so subsequent diffs remain correct.
- **Deleted file support**: Baseline `''` means the file is new; if a file is externally deleted, its baseline is preserved and shown in a diff view via the `hunkwise-baseline:` content provider.
- **Persistence across restarts**: On `activate()`, `StateManager.load()` checks if `.vscode/hunkwise/git/` exists (enabled state), then reads all baselines from `git ls-tree HEAD` + `git show :path`.

### Files that can be tested without VSCode

`tsconfig.test.json` compiles only `diffEngine.ts`, `hunkwiseGit.ts`, `gitignoreManager.ts`, and the test files — these have no `vscode` dependency and run in plain Node.
