import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileState } from './types';
import { HunkwiseGit } from './hunkwiseGit';

const DEFAULT_IGNORE_PATTERNS = ['.git'];

export class StateManager {
  // In-memory cache — rebuilt from git on load(), updated synchronously on mutations
  private state: Map<string, FileState> = new Map();
  private hunkwiseDir: string | undefined;
  private workspaceRoot: string | undefined;
  private _enabled: boolean = false;
  private _ignorePatterns: string[] = [...DEFAULT_IGNORE_PATTERNS];
  private _respectGitignore: boolean = true;
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
  async load(): Promise<void> {
    const g = this.ensureGit();
    if (!g) return;

    // enabled state is determined by whether the hunkwise git dir exists on disk
    const gitDir = path.join(this.hunkwiseDir!, 'git');
    if (!fs.existsSync(gitDir)) return;

    this._enabled = true;
    const settings = g.loadSettings();
    this._ignorePatterns = settings.ignorePatterns;
    this._respectGitignore = settings.respectGitignore;

    // Initialize git (idempotent) then restore in-memory state from HEAD
    await g.initGit();
    const tracked = await g.listTrackedFiles();
    await Promise.all(tracked.map(async filePath => {
      const baseline = await g.getBaseline(filePath);
      if (baseline !== undefined) {
        this.state.set(filePath, { status: 'reviewing', baseline });
      }
    }));
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
      const merged = g.mergeDefaultSettings({ ignorePatterns: this._ignorePatterns, respectGitignore: this._respectGitignore });
      this._ignorePatterns = merged.ignorePatterns;
      this._respectGitignore = merged.respectGitignore;
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
  async snapshotWorkspace(shouldIgnore: (filePath: string) => boolean): Promise<void> {
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
        if (shouldIgnore(full)) continue;
        if (entry.isDirectory()) {
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
      this._git.saveSettings({ ignorePatterns: patterns, respectGitignore: this._respectGitignore });
    }
  }

  setRespectGitignore(value: boolean): void {
    this._respectGitignore = value;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ignorePatterns: this._ignorePatterns, respectGitignore: value });
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
    return this._ignorePatterns;
  }

  /**
   * Snapshot files newly allowed by current ignore rules but not yet tracked.
   * Never removes existing baselines — removing tracked files mid-session is unsafe.
   * Called after ignorePatterns / respectGitignore / .gitignore changes.
   */
  async syncIgnoreState(shouldIgnore: (filePath: string) => boolean): Promise<void> {
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
        if (shouldIgnore(full)) continue;
        if (entry.isDirectory()) {
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

    const trackedSet = new Set(trackedFiles);
    const toAdd = allowedFiles.filter(fp => !trackedSet.has(fp));
    if (toAdd.length === 0) return;

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
