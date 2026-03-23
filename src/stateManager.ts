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
  private _git: HunkwiseGit | undefined;

  // Serial queue: git ops run one at a time; flush() awaits the tail
  private gitQueue: Promise<void> = Promise.resolve();

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
  get dir(): string | undefined { return this.hunkwiseDir; }
  get git(): HunkwiseGit | undefined { return this._git; }

  // ── init / load ───────────────────────────────────────────────────────────

  private ensureGit(): HunkwiseGit | undefined {
    if (!this.hunkwiseDir || !this.workspaceRoot) return undefined;
    if (!this._git) {
      this._git = new HunkwiseGit(this.hunkwiseDir, this.workspaceRoot);
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

    // Initialize git (idempotent) then restore in-memory state from HEAD
    await g.initGit();
    const tracked = await g.listTrackedFiles();
    const ignored: string[] = [];
    await Promise.all(tracked.map(async filePath => {
      if (shouldIgnore?.(filePath)) {
        ignored.push(filePath);
        return;
      }
      const baseline = await g.getBaseline(filePath);
      if (baseline !== undefined) {
        this.state.set(filePath, { status: 'reviewing', baseline });
      }
    }));
    // Clean up stale ignored entries from the git repo
    if (ignored.length > 0) {
      log(`load: removing ${ignored.length} ignored file(s) from git: ${logFileList(ignored, this.workspaceRoot)}`);
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(ignored)).catch(() => {});
    }
  }

  // ── file state ────────────────────────────────────────────────────────────

  getFile(filePath: string): FileState | undefined {
    return this.state.get(filePath);
  }

  setFile(filePath: string, state: FileState): void {
    this.state.set(filePath, state);
    if (this._git) {
      const g = this._git;
      const baseline = state.baseline;
      this.gitQueue = this.gitQueue.then(() => g.snapshot(filePath, baseline)).catch(() => {});
    }
  }

  removeFile(filePath: string): void {
    this.state.delete(filePath);
    if (this._git) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.removeFile(filePath)).catch(() => {});
    }
  }

  renameFile(oldFilePath: string, newFilePath: string): void {
    const fileState = this.state.get(oldFilePath);
    this.state.delete(oldFilePath);
    if (fileState) {
      this.state.set(newFilePath, fileState);
    }
    if (this._git) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.renameFile(oldFilePath, newFilePath)).catch(() => {});
    }
  }

  /**
   * Snapshot a file's content as baseline via the git queue (serialized).
   * Use this instead of calling git.snapshot() directly to avoid concurrent git ops.
   */
  snapshotFile(filePath: string, content: string): void {
    if (this._git) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.snapshot(filePath, content)).catch(() => {});
    }
  }

  getAllFiles(): ReadonlyMap<string, FileState> {
    return this.state;
  }

  isReviewing(filePath: string): boolean {
    return this.state.get(filePath)?.status === 'reviewing';
  }

  clearAllFiles(): void {
    const paths = Array.from(this.state.keys());
    this.state.clear();
    if (this._git) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(async () => {
        for (const fp of paths) {
          await g.removeFile(fp);
        }
      }).catch(() => {});
    }
  }

  // ── settings ──────────────────────────────────────────────────────────────

  async setEnabled(value: boolean): Promise<void> {
    this._enabled = value;
    if (value) {
      const g = this.ensureGit();
      if (!g) return;
      await g.initGit();
      const merged = g.mergeDefaultSettings({ ignorePatterns: this._ignorePatterns, respectGitignore: this._respectGitignore, clearOnBranchSwitch: this._clearOnBranchSwitch });
      this._ignorePatterns = merged.ignorePatterns;
      this._respectGitignore = merged.respectGitignore;
      this._clearOnBranchSwitch = merged.clearOnBranchSwitch;
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

  setIgnorePatterns(patterns: string[]): void {
    this._ignorePatterns = patterns;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ignorePatterns: patterns, respectGitignore: this._respectGitignore, clearOnBranchSwitch: this._clearOnBranchSwitch });
    }
  }

  setRespectGitignore(value: boolean): void {
    this._respectGitignore = value;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ignorePatterns: this._ignorePatterns, respectGitignore: value, clearOnBranchSwitch: this._clearOnBranchSwitch });
    }
  }

  setClearOnBranchSwitch(value: boolean): void {
    this._clearOnBranchSwitch = value;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ignorePatterns: this._ignorePatterns, respectGitignore: this._respectGitignore, clearOnBranchSwitch: value });
    }
  }

  /**
   * Reload ignorePatterns from settings.json (called when settings.json is modified externally).
   * Returns the new patterns if changed, null if not enabled or no git.
   */
  reloadIgnorePatterns(): string[] | null {
    if (!this._enabled || !this._git) return null;
    const settings = this._git.loadSettings();
    this._ignorePatterns = settings.ignorePatterns;
    this._respectGitignore = settings.respectGitignore;
    this._clearOnBranchSwitch = settings.clearOnBranchSwitch;
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
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(toRemove)).catch(() => {});
    }

    // Add newly allowed files not yet tracked
    const trackedSet = new Set(trackedFiles);
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
        this.gitQueue = this.gitQueue.then(() => g.snapshotBatch(batch)).catch(() => {});
      }
    }

    // Wait for all queued git operations to complete
    await this.gitQueue;
  }

  /**
   * Called on branch switch when clearOnBranchSwitch is enabled.
   * Updates each reviewing file's baseline to current disk content and removes it from reviewing.
   * Files that can't be read (deleted) are removed from tracking entirely.
   */
  async clearHunksOnBranchSwitch(): Promise<void> {
    const g = this._git;
    if (!g) return;

    const reviewingPaths = Array.from(this.state.entries())
      .filter(([, s]) => s.status === 'reviewing')
      .map(([fp]) => fp);

    if (reviewingPaths.length === 0) return;
    log(`clearHunksOnBranchSwitch: clearing ${reviewingPaths.length} file(s)`);

    const toRemove: string[] = [];
    const toSnapshot: { filePath: string; content: string }[] = [];

    await Promise.all(reviewingPaths.map(async filePath => {
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        toSnapshot.push({ filePath, content });
      } catch {
        // File no longer exists — remove from tracking
        toRemove.push(filePath);
      }
    }));

    // Update in-memory state: remove all reviewing entries
    for (const fp of reviewingPaths) {
      this.state.delete(fp);
    }

    // Persist to git
    if (toRemove.length > 0) {
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(toRemove)).catch(() => {});
    }
    if (toSnapshot.length > 0) {
      this.gitQueue = this.gitQueue.then(() => g.snapshotBatch(toSnapshot)).catch(() => {});
    }
  }

  /**
   * Reset extension to disabled state (called when hunkwiseDir is deleted externally).
   */
  resetToDisabled(): void {
    this._enabled = false;
    this._ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
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
