import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileState } from './types';
import { HunkwiseGit } from './hunkwiseGit';
import { log } from './log';

const DEFAULT_IGNORE_PATTERNS = process.platform === 'darwin' ? ['.git', '.DS_Store'] : ['.git'];

/** Format a list of absolute paths for logging: show relative paths, max 20. */
function logFileList(files: string[], rootPath: string | undefined): string {
  const rel = files.map(fp => rootPath ? path.relative(rootPath, fp) : fp);
  const shown = rel.slice(0, 20);
  const suffix = rel.length > 20 ? ` … and ${rel.length - 20} more` : '';
  return shown.join(', ') + suffix;
}

export class StateManager {
  // In-memory cache — rebuilt from git on load(), updated synchronously on mutations
  private state: Map<string, FileState> = new Map();
  private hunkwiseDir: string | undefined;
  private workspaceRoot: string | undefined;
  private _enabled: boolean = false;
  private _ignorePatterns: string[] = [...DEFAULT_IGNORE_PATTERNS];
  private _respectGitignore: boolean = true;
  private _clearOnBranchSwitch: boolean = false;
  private _quoteRotationInterval: number = 30;
  private _useDiffEditor: boolean = false;
  private _showInlineDecorations: boolean = true;
  private _git: HunkwiseGit | undefined;

  // Serial queue: git ops run one at a time; flush() awaits the tail
  private gitQueue: Promise<void> = Promise.resolve();

  // Optional callback invoked when a git failure causes an in-memory rollback
  // (e.g. exitReviewing snapshot fails and reviewing state is restored).
  // Set by the extension to trigger UI refresh after unexpected state restoration.
  onRollback: (() => void) | undefined;

  constructor() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      this.workspaceRoot = workspaceFolders[0].uri.fsPath;
      this.hunkwiseDir = path.join(this.workspaceRoot, '.vscode', 'hunkwise');
    }
  }

  // ── accessors ─────────────────────────────────────────────────────────────

  get enabled(): boolean { return this._enabled; }
  get ignorePatterns(): string[] { return this._ignorePatterns; }
  get respectGitignore(): boolean { return this._respectGitignore; }
  get clearOnBranchSwitch(): boolean { return this._clearOnBranchSwitch; }
  get quoteRotationInterval(): number { return this._quoteRotationInterval; }
  get useDiffEditor(): boolean { return this._useDiffEditor; }
  get showInlineDecorations(): boolean { return this._showInlineDecorations; }
  get dir(): string | undefined { return this.hunkwiseDir; }
  get git(): HunkwiseGit | undefined { return this._git; }

  // ── init / load ───────────────────────────────────────────────────────────

  private ensureGit(): HunkwiseGit | undefined {
    if (!this.hunkwiseDir || !this.workspaceRoot) return undefined;
    if (!this._git) {
      this._git = new HunkwiseGit(this.hunkwiseDir, this.workspaceRoot, log);
    }
    return this._git;
  }

  /**
   * Load persistent state from settings.json + git repo.
   * Must be called once at activation. Async because reading baselines
   * from git requires exec calls.
   */
  async load(shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean): Promise<void> {
    const g = this.ensureGit();
    if (!g) return;

    // enabled state is determined by whether the hunkwise git dir exists on disk
    const gitDir = path.join(this.hunkwiseDir!, 'git');
    if (!fs.existsSync(gitDir)) return;

    this._enabled = true;
    const settings = g.loadSettings();
    this._ignorePatterns = settings.ignorePatterns;
    this._respectGitignore = settings.respectGitignore;
    this._clearOnBranchSwitch = settings.clearOnBranchSwitch;
    this._quoteRotationInterval = settings.quoteRotationInterval;
    this._useDiffEditor = settings.useDiffEditor;
    this._showInlineDecorations = settings.showInlineDecorations;

    // Initialize git (idempotent) then restore in-memory state from HEAD
    await g.initGit();
    const tracked = await g.listTrackedFiles();
    const ignored: string[] = [];
    const skippedNoBaseline: string[] = [];
    const reviewing: string[] = [];
    const idle: string[] = [];
    await Promise.all(tracked.map(async filePath => {
      if (shouldIgnore?.(filePath)) {
        ignored.push(filePath);
        return;
      }
      const baseline = await g.getBaseline(filePath);
      if (baseline === undefined) {
        skippedNoBaseline.push(filePath);
        return;
      }
      // Compare baseline with current disk content — only enter reviewing if there's a real diff
      let diskContent: string | undefined;
      try { diskContent = await fs.promises.readFile(filePath, 'utf-8'); } catch { /* file deleted or unreadable */ }
      if (diskContent !== undefined && diskContent !== baseline) {
        this.state.set(filePath, { status: 'reviewing', baseline });
        reviewing.push(filePath);
      } else {
        // No diff (or file deleted) — baseline is stored in git, no need to set reviewing
        idle.push(filePath);
      }
    }));
    if (skippedNoBaseline.length > 0) {
      log(`load: skipped ${skippedNoBaseline.length} file(s) with no baseline in index: ${logFileList(skippedNoBaseline, this.workspaceRoot)}`);
    }
    if (reviewing.length > 0) {
      log(`load: ${reviewing.length} file(s) have diffs: ${logFileList(reviewing, this.workspaceRoot)}`);
    }
    if (idle.length > 0) {
      log(`load: ${idle.length} file(s) unchanged, baseline preserved`);
    }
    // Clean up stale ignored entries from the git repo
    if (ignored.length > 0) {
      log(`load: removing ${ignored.length} ignored file(s) from git: ${logFileList(ignored, this.workspaceRoot)}`);
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(ignored)).catch(err => { log(`git queue error: ${err}`); });
    }
  }

  /**
   * Rebuild in-memory state from git baselines, comparing with the current state.
   * Logs a diff report showing what changed.
   */
  async rebuildState(shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean): Promise<void> {
    const g = this._git;
    if (!g || !this._enabled) {
      log('rebuildState: not enabled or no git, skip');
      return;
    }

    log('rebuildState: begin');

    // Wait for pending git operations to complete before reading
    await this.gitQueue;

    // Snapshot old state for comparison
    const oldState = new Map<string, FileState>();
    for (const [fp, fs] of this.state) {
      oldState.set(fp, { ...fs });
    }

    // Rebuild: clear and reload from git (same logic as load, but parallelized)
    this.state.clear();
    await g.initGit();
    const tracked = await g.listTrackedFiles();
    const filtered = tracked.filter(fp => !shouldIgnore?.(fp));
    await Promise.all(filtered.map(async filePath => {
      const baseline = await g.getBaseline(filePath);
      if (baseline === undefined) return;
      let diskContent: string | undefined;
      try { diskContent = await fs.promises.readFile(filePath, 'utf-8'); } catch { /* deleted or unreadable */ }
      if (diskContent !== undefined && diskContent !== baseline) {
        this.state.set(filePath, { status: 'reviewing', baseline });
      }
    }));

    // Compare old vs new state
    const added: string[] = [];
    const removed: string[] = [];
    const baselineChanged: string[] = [];
    const statusChanged: string[] = [];

    const rootPath = this.workspaceRoot;
    const rel = (fp: string) => rootPath ? path.relative(rootPath, fp) : fp;

    for (const [fp, newFs] of this.state) {
      const oldFs = oldState.get(fp);
      if (!oldFs) {
        added.push(rel(fp));
      } else {
        if (oldFs.baseline !== newFs.baseline) baselineChanged.push(rel(fp));
        if (oldFs.status !== newFs.status) statusChanged.push(rel(fp));
      }
    }
    for (const fp of oldState.keys()) {
      if (!this.state.has(fp)) removed.push(rel(fp));
    }

    if (added.length === 0 && removed.length === 0 && baselineChanged.length === 0 && statusChanged.length === 0) {
      log('rebuildState: no differences found — memory state matches git');
    } else {
      log(`rebuildState: differences found:`);
      if (added.length > 0) log(`  added (in git but was missing from memory): ${added.join(', ')}`);
      if (removed.length > 0) log(`  removed (in memory but not in git/disk): ${removed.join(', ')}`);
      if (baselineChanged.length > 0) log(`  baseline changed: ${baselineChanged.join(', ')}`);
      if (statusChanged.length > 0) log(`  status changed: ${statusChanged.join(', ')}`);
    }

    log(`rebuildState: done — ${this.state.size} file(s) in reviewing state`);
  }

  // ── file state ────────────────────────────────────────────────────────────

  getFile(filePath: string): FileState | undefined {
    return this.state.get(filePath);
  }

  setFile(filePath: string, state: FileState, skipSnapshot?: boolean): void {
    // Clone old state so callers mutating the FileState object don't corrupt the rollback snapshot
    const oldState = this.state.has(filePath) ? { ...this.state.get(filePath)! } : undefined;
    this.state.set(filePath, state);
    if (!skipSnapshot && this._git && state.baseline !== null) {
      const g = this._git;
      const baseline = state.baseline;
      this.gitQueue = this.gitQueue.then(() => g.snapshot(filePath, baseline)).catch(err => {
        log(`git queue error (setFile rollback): ${err}`);
        // Only rollback if this exact state object is still current (no newer operation has updated it)
        if (this.state.get(filePath) === state) {
          if (oldState) { this.state.set(filePath, oldState); } else { this.state.delete(filePath); }
          this.onRollback?.();
        }
      });
    }
  }

  removeFile(filePath: string): void {
    // Clone old state so the rollback has an independent snapshot
    const oldState = this.state.has(filePath) ? { ...this.state.get(filePath)! } : undefined;
    this.state.delete(filePath);
    // Skip git removal only when we know the file had a null baseline (never stored in git).
    // If oldState is undefined (idle file, not in map) or has a real baseline, queue the removal.
    if (this._git && !(oldState !== undefined && oldState.baseline === null)) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.removeFile(filePath)).catch(err => {
        log(`git queue error (removeFile rollback): ${err}`);
        // Only rollback if no newer operation has re-added the entry
        if (!this.state.has(filePath) && oldState) {
          this.state.set(filePath, { ...oldState });
          this.onRollback?.();
        }
      });
    }
  }

  renameFile(oldFilePath: string, newFilePath: string): void {
    const fileState = this.state.get(oldFilePath);
    this.state.delete(oldFilePath);
    if (fileState) {
      this.state.set(newFilePath, fileState);
    }
    // Skip git rename only when we know the file had a null baseline (never stored in hunkwise git).
    // If fileState is undefined (idle file, not in map) or has a real baseline, queue the rename.
    if (this._git && !(fileState && fileState.baseline === null)) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.renameFile(oldFilePath, newFilePath)).catch(err => {
        // Do not rollback in-memory path mapping: the file has already been renamed on disk,
        // so reverting to oldFilePath would desync state/UI from the filesystem.
        log(`git queue error (renameFile): ${err}`);
      });
    }
  }

  /**
   * Snapshot a file's content as baseline via the git queue (serialized).
   * Use this instead of calling git.snapshot() directly to avoid concurrent git ops.
   */
  snapshotFile(filePath: string, content: string): void {
    if (this._git) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.snapshot(filePath, content)).catch(err => { log(`git queue error: ${err}`); });
    }
  }

  getAllFiles(): ReadonlyMap<string, FileState> {
    return this.state;
  }

  isReviewing(filePath: string): boolean {
    return this.state.get(filePath)?.status === 'reviewing';
  }

  /**
   * Exit reviewing state without removing the file from git.
   * If newBaseline is provided as a non-null string, update the baseline in git (e.g. after accept).
   * If omitted or explicitly null, do not snapshot or update the git baseline; the existing baseline
   * is assumed to already be correct (e.g. hunks resolved to 0, or discard).
   */
  exitReviewing(filePath: string, newBaseline?: string | null): void {
    const oldState = this.state.has(filePath) ? { ...this.state.get(filePath)! } : undefined;
    this.state.delete(filePath);
    if (newBaseline !== undefined && newBaseline !== null) {
      if (this._git) {
        const g = this._git;
        const baseline = newBaseline;
        this.gitQueue = this.gitQueue.then(() => g.snapshot(filePath, baseline)).catch(err => {
          log(`git queue error (exitReviewing rollback): ${err}`);
          // Restore reviewing state so the user can retry rather than silently getting a stale baseline
          if (!this.state.has(filePath) && oldState) {
            this.state.set(filePath, { ...oldState });
            this.onRollback?.();
            void vscode.window.showErrorMessage(
              `Failed to update review baseline for ${path.basename(filePath)}. The file has been kept in reviewing so you can retry.`
            );
          }
        });
      }
    }
  }


  // ── settings ──────────────────────────────────────────────────────────────

  async setEnabled(value: boolean): Promise<void> {
    this._enabled = value;
    if (value) {
      const g = this.ensureGit();
      if (!g) return;
      await g.initGit();
      const merged = g.mergeDefaultSettings(this.currentSettings());
      this._ignorePatterns = merged.ignorePatterns;
      this._respectGitignore = merged.respectGitignore;
      this._clearOnBranchSwitch = merged.clearOnBranchSwitch;
      this._quoteRotationInterval = merged.quoteRotationInterval;
      this._useDiffEditor = merged.useDiffEditor;
      this._showInlineDecorations = merged.showInlineDecorations;
    } else {
      this.state.clear();
      this._git?.destroyGit();
      this._git = undefined;
    }
  }

  /**
   * Snapshot all current workspace files into hunkwise git as baselines.
   * Only snapshots files that don't already have a baseline recorded.
   * Should be called once after enable.
   */
  async snapshotWorkspace(shouldIgnore: (filePath: string, isDirectory?: boolean) => boolean): Promise<void> {
    const g = this._git;
    if (!g || !this.workspaceRoot) return;

    const collect = async (dir: string): Promise<string[]> => {
      let results: string[] = [];
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const isDir = entry.isDirectory();
        if (shouldIgnore(full, isDir)) continue;
        if (isDir) {
          results = results.concat(await collect(full));
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
      return results;
    };

    const filePaths = await collect(this.workspaceRoot);
    const batch: { filePath: string; content: string }[] = [];
    await Promise.all(filePaths.map(async filePath => {
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        batch.push({ filePath, content });
      } catch {
        // Skip binary or unreadable files
      }
    }));
    if (batch.length > 0) {
      await g.snapshotBatch(batch);
    }
  }

  private currentSettings() {
    return { ignorePatterns: this._ignorePatterns, respectGitignore: this._respectGitignore, clearOnBranchSwitch: this._clearOnBranchSwitch, quoteRotationInterval: this._quoteRotationInterval, useDiffEditor: this._useDiffEditor, showInlineDecorations: this._showInlineDecorations };
  }

  setIgnorePatterns(patterns: string[]): void {
    this._ignorePatterns = patterns;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), ignorePatterns: patterns });
    }
  }

  setRespectGitignore(value: boolean): void {
    this._respectGitignore = value;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), respectGitignore: value });
    }
  }

  setClearOnBranchSwitch(value: boolean): void {
    this._clearOnBranchSwitch = value;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), clearOnBranchSwitch: value });
    }
  }

  setQuoteRotationInterval(value: number): void {
    const normalized = (Number.isFinite(value) && value >= 0) ? Math.floor(value) : 0;
    this._quoteRotationInterval = normalized;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), quoteRotationInterval: normalized });
    }
  }

  setUseDiffEditor(value: boolean): void {
    log(`settings: useDiffEditor=${value}`);
    this._useDiffEditor = value;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), useDiffEditor: value });
    }
  }

  setShowInlineDecorations(value: boolean): void {
    log(`settings: showInlineDecorations=${value}`);
    this._showInlineDecorations = value;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), showInlineDecorations: value });
    }
  }

  /**
   * Reload all settings from settings.json (called when settings.json is modified externally).
   * Returns the new ignorePatterns if enabled, null if not enabled or no git.
   */
  reloadIgnorePatterns(): string[] | null {
    if (!this._enabled || !this._git) return null;
    const settings = this._git.loadSettings();
    this._ignorePatterns = settings.ignorePatterns;
    this._respectGitignore = settings.respectGitignore;
    this._clearOnBranchSwitch = settings.clearOnBranchSwitch;
    this._quoteRotationInterval = settings.quoteRotationInterval;
    this._useDiffEditor = settings.useDiffEditor;
    this._showInlineDecorations = settings.showInlineDecorations;
    return this._ignorePatterns;
  }

  /**
   * Sync tracked files with current ignore rules.
   * - Removes baselines for files that are now ignored.
   * - Snapshots files newly allowed by current rules but not yet tracked.
   * Called after ignorePatterns / respectGitignore / .gitignore changes.
   */
  async syncIgnoreState(shouldIgnore: (filePath: string, isDirectory?: boolean) => boolean): Promise<void> {
    const g = this._git;
    if (!g || !this.workspaceRoot) return;

    const collect = async (dir: string): Promise<string[]> => {
      let results: string[] = [];
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const isDir = entry.isDirectory();
        if (shouldIgnore(full, isDir)) continue;
        if (isDir) {
          results = results.concat(await collect(full));
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
      return results;
    };

    const [allowedFiles, trackedFiles] = await Promise.all([
      collect(this.workspaceRoot),
      g.listTrackedFiles(),
    ]);

    // Remove tracked files that are now ignored (from git and from in-memory state)
    const allowedSet = new Set(allowedFiles);
    const toRemove = trackedFiles.filter(fp => !allowedSet.has(fp));
    // Also remove in-memory state entries that are ignored but have no git baseline (e.g. new files in reviewing)
    for (const fp of this.state.keys()) {
      if (!allowedSet.has(fp) && !toRemove.includes(fp)) {
        this.state.delete(fp);
      }
    }
    if (toRemove.length > 0) {
      log(`syncIgnoreState: removing ${toRemove.length} file(s): ${logFileList(toRemove, this.workspaceRoot)}`);
    }
    for (const fp of toRemove) {
      this.state.delete(fp);
    }
    if (toRemove.length > 0) {
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(toRemove)).catch(err => { log(`git queue error: ${err}`); });
    }

    // Add newly allowed files not yet tracked (check both git HEAD and in-memory state
    // to avoid re-adding files that were loaded from index but not yet committed to HEAD).
    //
    // These files are silently snapshotted with their current content as baseline,
    // rather than treated as "new" (baseline='') which would produce hunks. This is
    // intentional to avoid flooding the user with false positives when:
    // - ignore rules changed and previously-ignored files are now un-ignored
    // - a large number of files become visible at once
    // Genuine new files created while hunkwise is running are caught by
    // FileWatcher.onDidCreate, not this path. This is intentionally consistent
    // with the onDiskChange fallback which also silently adopts content.
    const trackedSet = new Set(trackedFiles);
    for (const fp of this.state.keys()) trackedSet.add(fp);
    const toAdd = allowedFiles.filter(fp => !trackedSet.has(fp));
    if (toAdd.length > 0) {
      log(`syncIgnoreState: adding ${toAdd.length} file(s): ${logFileList(toAdd, this.workspaceRoot)}`);
    }
    if (toAdd.length > 0) {
      const batch: { filePath: string; content: string }[] = [];
      await Promise.all(toAdd.map(async fp => {
        try {
          const content = await fs.promises.readFile(fp, 'utf-8');
          batch.push({ filePath: fp, content });
        } catch { /* skip unreadable */ }
      }));
      if (batch.length > 0) {
        this.gitQueue = this.gitQueue.then(() => g.snapshotBatch(batch)).catch(err => { log(`git queue error: ${err}`); });
      }
    }

    // Wait for all queued git operations to complete
    await this.gitQueue;
  }

  /**
   * Called on branch switch when clearOnBranchSwitch is enabled.
   * Clears all reviewing state, re-snapshots every tracked file to the current
   * disk content, and removes baselines for files that no longer exist.
   * This must be called while FileWatcher events are suppressed so that
   * git-checkout-induced file changes don't race with the clear.
   */
  async clearHunksOnBranchSwitch(shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean): Promise<void> {
    const g = this._git;
    if (!g || !this.workspaceRoot) return;

    const reviewingCount = Array.from(this.state.values()).filter(s => s.status === 'reviewing').length;
    log(`clearHunksOnBranchSwitch: clearing ${reviewingCount} reviewing file(s), re-syncing all baselines`);

    // Clear all in-memory state — fresh start
    this.state.clear();

    // Collect all current workspace files (respecting ignore rules)
    const collect = async (dir: string): Promise<string[]> => {
      let results: string[] = [];
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const isDir = entry.isDirectory();
        if (shouldIgnore?.(full, isDir)) continue;
        if (isDir) {
          results = results.concat(await collect(full));
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
      return results;
    };

    const [diskFiles, trackedFiles] = await Promise.all([
      collect(this.workspaceRoot),
      g.listTrackedFiles(),
    ]);

    // Snapshot all disk files as new baselines
    const diskSet = new Set(diskFiles);
    const batch: { filePath: string; content: string }[] = [];
    await Promise.all(diskFiles.map(async fp => {
      try {
        const content = await fs.promises.readFile(fp, 'utf-8');
        batch.push({ filePath: fp, content });
      } catch { /* skip unreadable */ }
    }));

    // Remove baselines for files that no longer exist on disk
    const toRemove = trackedFiles.filter(fp => !diskSet.has(fp));

    if (toRemove.length > 0) {
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(toRemove)).catch(err => { log(`git queue error: ${err}`); });
    }
    if (batch.length > 0) {
      this.gitQueue = this.gitQueue.then(() => g.snapshotBatch(batch)).catch(err => { log(`git queue error: ${err}`); });
    }

    // Wait for all git ops to complete before returning
    await this.gitQueue;
  }

  /**
   * Reset extension to disabled state (called when hunkwiseDir is deleted externally).
   */
  resetToDisabled(): void {
    this._enabled = false;
    this._ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
    this._useDiffEditor = false;
    this._showInlineDecorations = true;
    this.state.clear();
    this._git = undefined;
    this.gitQueue = Promise.resolve();
  }

  /** Wait for all pending git operations to complete. Call on deactivate. */
  async flush(): Promise<void> {
    await this.gitQueue;
  }

  /** Cancel any pending saves (no-op now, kept for API compatibility). */
  cancelPendingSave(): void {}
}
