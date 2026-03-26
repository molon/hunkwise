import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface Settings {
  ignorePatterns: string[];
  respectGitignore: boolean;
  clearOnBranchSwitch: boolean;
  quoteRotationInterval: number;
  useDiffEditor: boolean;
  showInlineDecorations: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  ignorePatterns: process.platform === 'darwin' ? ['.git', '.DS_Store'] : ['.git'],
  respectGitignore: true,
  clearOnBranchSwitch: false,
  quoteRotationInterval: 30,
  useDiffEditor: false,
  showInlineDecorations: true,
};

/**
 * Manages all hunkwise persistent state via:
 *   .vscode/hunkwise/settings.json  — enabled flag + ignorePatterns
 *   .vscode/hunkwise/git/           — private git repo storing baselines
 *
 * The git repo uses the workspace root as its work tree but keeps all git
 * metadata inside the hunkwise directory, so it never touches the project's
 * own .git and works even when the project has no git at all.
 *
 *   GIT_DIR       = <hunkwiseDir>/git
 *   GIT_WORK_TREE = <workspaceRoot>
 *
 * Each tracked file has exactly one entry in the single HEAD commit.
 * Every mutation (snapshot / remove) rewrites that commit via --amend so
 * the repo always has at most one commit and stays compact.
 */
export class HunkwiseGit {
  private hunkwiseDir: string;
  private gitDir: string;
  private workTree: string;
  private gitInitialized = false;
  private destroyed = false;
  private initPromise: Promise<void> | undefined;
  private log: (message: string) => void;

  constructor(hunkwiseDir: string, workspaceRoot: string, logger?: (message: string) => void) {
    this.hunkwiseDir = hunkwiseDir;
    this.gitDir = path.join(hunkwiseDir, 'git');
    this.workTree = workspaceRoot;
    this.log = logger ?? ((msg: string) => console.warn(`[hunkwise] ${msg}`));
  }

  // ── env / low-level git ───────────────────────────────────────────────────

  private get env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workTree,
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.workTree,
      env: this.env,
      maxBuffer: 10 * 1024 * 1024, // 10 MB — default 1 MB is too small for large files
    });
    return stdout;
  }

  // ── settings.json ─────────────────────────────────────────────────────────

  private get settingsPath(): string {
    return path.join(this.hunkwiseDir, 'settings.json');
  }

  loadSettings(): Settings {
    try {
      const raw = fs.readFileSync(this.settingsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        ignorePatterns: parsed.ignorePatterns ?? [...DEFAULT_SETTINGS.ignorePatterns],
        respectGitignore: parsed.respectGitignore ?? DEFAULT_SETTINGS.respectGitignore,
        clearOnBranchSwitch: parsed.clearOnBranchSwitch ?? DEFAULT_SETTINGS.clearOnBranchSwitch,
        quoteRotationInterval: (typeof parsed.quoteRotationInterval === 'number' && Number.isFinite(parsed.quoteRotationInterval) && parsed.quoteRotationInterval >= 0)
          ? parsed.quoteRotationInterval
          : DEFAULT_SETTINGS.quoteRotationInterval,
        useDiffEditor: typeof parsed.useDiffEditor === 'boolean'
          ? parsed.useDiffEditor
          : DEFAULT_SETTINGS.useDiffEditor,
        showInlineDecorations: typeof parsed.showInlineDecorations === 'boolean'
          ? parsed.showInlineDecorations
          : DEFAULT_SETTINGS.showInlineDecorations,
      };
    } catch {
      return { ...DEFAULT_SETTINGS, ignorePatterns: [...DEFAULT_SETTINGS.ignorePatterns] };
    }
  }

  saveSettings(settings: Settings): void {
    try {
      fs.mkdirSync(this.hunkwiseDir, { recursive: true });
      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (err) {
      this.log(`saveSettings failed: ${err}`);
    }
  }

  /**
   * Merge defaults into existing settings.json.
   * Fields already present are kept; missing fields are added.
   * Returns the resulting settings.
   */
  mergeDefaultSettings(defaults: Settings): Settings {
    const existing = fs.existsSync(this.settingsPath) ? this.loadSettings() : ({} as Partial<Settings>);
    const merged: Settings = { ...defaults, ...existing };
    this.saveSettings(merged);
    return merged;
  }

  // ── git init ──────────────────────────────────────────────────────────────

  async initGit(): Promise<void> {
    if (this.destroyed || this.gitInitialized) return;
    // Serialize concurrent calls — only one init runs at a time
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitGit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }

  private async doInitGit(): Promise<void> {
    // Check for a valid git repo: HEAD file must exist. If the directory
    // exists but HEAD is missing, the repo is corrupted (e.g. interrupted
    // init). Re-initialize from scratch in that case.
    const headPath = path.join(this.gitDir, 'HEAD');
    if (!fs.existsSync(this.gitDir) || !fs.existsSync(headPath)) {
      if (fs.existsSync(this.gitDir)) {
        this.log('initGit: corrupted git dir detected (HEAD missing), re-initializing');
        try {
          fs.rmSync(this.gitDir, { recursive: true, force: true });
        } catch (err) {
          this.log(`initGit: failed to remove corrupted git dir: ${err}`);
          throw err;
        }
      }
      if (this.destroyed) return;
      fs.mkdirSync(this.gitDir, { recursive: true });
      await this.git(['init']);
      if (this.destroyed) return;
      await this.git(['config', 'user.email', 'hunkwise@localhost']);
      if (this.destroyed) return;
      await this.git(['config', 'user.name', 'hunkwise']);
    }
    if (this.destroyed) return;
    this.gitInitialized = true;
  }

  private async hasHead(): Promise<boolean> {
    try {
      await this.git(['rev-parse', 'HEAD']);
      return true;
    } catch {
      // Expected when repo has no commits yet
      return false;
    }
  }

  // ── snapshot / remove ─────────────────────────────────────────────────────

  /**
   * Write content into the git index for filePath (no commit).
   * Use commit() to persist.
   */
  async snapshot(filePath: string, content: string): Promise<void> {
    await this.initGit();
    const rel = path.relative(this.workTree, filePath);
    try {
      const hash = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          'git',
          ['hash-object', '-w', '--stdin'],
          { env: this.env },
          (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
        );
        child.stdin!.end(content, 'utf-8');
      });
      await this.git(['update-index', '--add', '--cacheinfo', `100644,${hash},${rel}`]);
      await this.commit();
    } catch (err) {
      this.log(`snapshot failed for ${rel}: ${err}`);
    }
  }

  /**
   * Rename a file's baseline entry in the git index and commit.
   * Reuses the existing blob hash — no content re-hashing needed.
   */
  async renameFile(oldFilePath: string, newFilePath: string): Promise<void> {
    await this.initGit();
    const oldRel = path.relative(this.workTree, oldFilePath);
    const newRel = path.relative(this.workTree, newFilePath);
    try {
      const lsOut = await this.git(['ls-files', '--stage', '--', oldRel]);
      const match = lsOut.trim().match(/^(\d+) ([0-9a-f]+) \d+\t/);
      if (!match) return; // not tracked — nothing to rename
      const [, mode, hash] = match;
      await this.git(['update-index', '--force-remove', '--', oldRel]);
      await this.git(['update-index', '--add', '--cacheinfo', `${mode},${hash},${newRel}`]);
      await this.commit();
    } catch (err) {
      this.log(`renameFile failed (${path.relative(this.workTree, oldFilePath)} → ${path.relative(this.workTree, newFilePath)}): ${err}`);
    }
  }

  /**
   * Remove a file's baseline from the git index and commit.
   */
  async removeFile(filePath: string): Promise<void> {
    await this.initGit();
    const rel = path.relative(this.workTree, filePath);
    try {
      await this.git(['update-index', '--force-remove', '--', rel]);
      await this.commit();
    } catch (err) {
      this.log(`removeFile failed for ${rel}: ${err}`);
    }
  }

  /**
   * Snapshot multiple files at once — writes all blobs to index then commits once.
   * Much faster than calling snapshot() per file.
   */
  async snapshotBatch(files: { filePath: string; content: string }[]): Promise<void> {
    if (files.length === 0) return;
    await this.initGit();
    try {
      // Hash all blobs in parallel, then stage all at once and commit once
      const entries = await Promise.all(
        files.map(({ filePath, content }) =>
          new Promise<{ rel: string; hash: string }>((resolve, reject) => {
            const rel = path.relative(this.workTree, filePath);
            const child = execFile(
              'git',
              ['hash-object', '-w', '--stdin'],
              { env: this.env },
              (err, stdout) => (err ? reject(err) : resolve({ rel, hash: stdout.trim() }))
            );
            child.stdin!.end(content, 'utf-8');
          })
        )
      );
      // Stage all entries, chunked to avoid OS argument length limits
      const CHUNK = 100;
      for (let i = 0; i < entries.length; i += CHUNK) {
        const cacheArgs = entries.slice(i, i + CHUNK).flatMap(({ rel, hash }) => ['--add', '--cacheinfo', `100644,${hash},${rel}`]);
        await this.git(['update-index', ...cacheArgs]);
      }
      await this.commit();
    } catch (err) {
      this.log(`snapshotBatch failed (${files.length} files): ${err}`);
    }
  }

  /**
   * Remove multiple files from the git index in a single operation and commit once.
   * Much faster than calling removeFile() per file.
   */
  async removeFileBatch(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    await this.initGit();
    try {
      const rels = filePaths.map(fp => path.relative(this.workTree, fp));
      // Chunk to avoid exceeding OS argument length limits (~250KB on macOS)
      const CHUNK = 200;
      for (let i = 0; i < rels.length; i += CHUNK) {
        await this.git(['update-index', '--force-remove', '--', ...rels.slice(i, i + CHUNK)]);
      }
      await this.commit();
    } catch (err) {
      this.log(`removeFileBatch failed (${filePaths.length} files): ${err}`);
    }
  }

  private async commit(): Promise<void> {
    if (await this.hasHead()) {
      await this.git(['commit', '--amend', '--no-edit', '--allow-empty']);
    } else {
      await this.git(['commit', '-m', 'hunkwise baselines']);
    }
  }

  /**
   * Return the baseline content for a file from the git index, or undefined if not tracked.
   * Reads from index (not HEAD) so newly staged files are immediately visible.
   */
  async getBaseline(filePath: string): Promise<string | undefined> {
    await this.initGit();
    const rel = path.relative(this.workTree, filePath);
    try {
      return await this.git(['show', `:${rel}`]);
    } catch {
      return undefined;
    }
  }

  /**
   * Return absolute paths of all files currently tracked in HEAD.
   */
  async listTrackedFiles(): Promise<string[]> {
    await this.initGit();
    try {
      const out = await this.git(['ls-tree', 'HEAD', '--name-only', '-r']);
      return out
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(rel => path.join(this.workTree, rel));
    } catch {
      return [];
    }
  }

  // ── destroy ───────────────────────────────────────────────────────────────

  /** Remove only the git directory (called on disable). settings.json is preserved. */
  destroyGit(): void {
    this.gitInitialized = false;
    this.destroyed = true;
    if (fs.existsSync(this.gitDir)) {
      try {
        fs.rmSync(this.gitDir, { recursive: true, force: true });
      } catch (err) {
        this.log(`destroyGit failed: ${err}`);
      }
    }
  }
}
