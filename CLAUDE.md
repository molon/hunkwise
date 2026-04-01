# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile          # compile TypeScript to out/
npm run watch            # watch mode compilation
npm test                 # compile test config + run unit tests
npm run test:integration # compile + run VSCode integration tests
```

To run a single unit test file:
```bash
tsc -p ./tsconfig.test.json && node --test out-test/test/diffEngine.test.js
```

Unit tests use Node's built-in `node:test` runner. Integration tests use `@vscode/test-cli` with Mocha in a real VSCode extension host (config: `.vscode-test.mjs`, workspace: `src/test/integration/workspace/`).

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
- **Baseline as the single source of truth**: Whether a file is "new" or "existing" is determined solely by whether it has a baseline in hunkwise git — not by file content, encoding, or binary detection. `baseline === null` means new file (not tracked in git); `baseline === ''` means existing empty file; `baseline === <string>` means existing file with content. This distinction must be consistent across all code paths (`onDiskCreate`, `load`, `rebuildState`, `collectUntrackedFiles`).
- **Deleted file support**: If a file is externally deleted, its baseline is preserved and shown in a diff view via the `hunkwise-baseline:` content provider.
- **Persistence across restarts**: On `activate()`, `StateManager.load()` checks if `.vscode/hunkwise/git/` exists (enabled state), then reads all baselines from `git ls-tree HEAD` + `git show :path`. Files on disk that are not tracked in hunkwise git are detected as new files (`baseline: null`) via `collectUntrackedFiles()`.
- **Rename/delete handling**: `onWillRenameFiles` migrates state+git before the actual rename; `onDidRenameFiles` triggers UI refresh after. Manual deletes (via VSCode) silently remove the baseline; external deletes produce a deletion hunk.
- **Git queue serialization**: All git write operations (`snapshot`, `removeFile`, `renameFile`, `snapshotBatch`) go through `StateManager.gitQueue` to prevent concurrent index/commit operations. Use `stateManager.snapshotFile()` from FileWatcher, never call `git.snapshot()` directly.
- **syncIgnoreState**: When `.gitignore` or `ignorePatterns` change, `syncIgnoreState()` both adds newly-allowed files and removes newly-ignored files from the git repo. It awaits the full `gitQueue` before returning.
- **`--force-remove` for git index**: `git update-index --remove` only removes files missing from disk — use `--force-remove` to unconditionally remove from the index even if the file exists on disk.

### Files that can be tested without VSCode

`tsconfig.test.json` compiles only `diffEngine.ts`, `hunkwiseGit.ts`, `gitignoreManager.ts`, and the test files — these have no `vscode` dependency and run in plain Node.

### Integration tests

`tsconfig.integration.json` compiles to `out-integration/`. Tests run in a real VSCode instance via `.vscode-test.mjs` config with `--enable-proposed-api=molon.hunkwise`. Test workspace is at `src/test/integration/workspace/`. Each test `setup()` cleans the workspace and `teardown()` disables hunkwise.
