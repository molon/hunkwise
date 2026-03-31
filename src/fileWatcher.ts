import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ignoreLib: ((options?: { ignoreCase?: boolean }) => import('ignore').Ignore) & typeof import('ignore') = require('ignore');
type Ignore = import('ignore').Ignore;
import { StateManager } from './stateManager';
import { computeHunks } from './diffEngine';
import { log } from './log';

// Transform gitignore rules from a sub-directory so they work in a single
// root-level matcher. Adds the directory's relative path as prefix, handling
// anchored (/), unanchored (any-depth), negation (!) and comment lines.
function prefixGitignoreRules(content: string, prefix: string): string {
  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    const neg = trimmed.startsWith('!');
    let pattern = neg ? trimmed.slice(1) : trimmed;

    if (pattern.startsWith('/')) {
      // Anchored to directory: /dist → prefix/dist
      pattern = prefix + pattern;
    } else if (!pattern.includes('/') || (pattern.endsWith('/') && !pattern.slice(0, -1).includes('/'))) {
      // No internal slash (or only trailing slash): matches any depth
      // *.tmp → prefix/**/*.tmp, build/ → prefix/**/build/
      pattern = prefix + '/**/' + pattern;
    } else {
      // Has internal slash: relative to directory: foo/bar → prefix/foo/bar
      pattern = prefix + '/' + pattern;
    }

    return (neg ? '!' : '') + pattern;
  }).join('\n');
}

export class FileWatcher {
  private disposables: vscode.Disposable[] = [];
  private selfEditFiles: Set<string> = new Set();
  // Files being deleted by the user via VSCode (explorer / applyEdit)
  private pendingUserDeletes: Set<string> = new Set();
  // Old paths of in-progress user renames — suppress onDiskDelete without extra git ops
  private pendingRenameOldPaths: Set<string> = new Set();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private onStateChanged: () => void;
  private onIgnoreRulesChanged: (() => void) | undefined;
  // Compiled ignore instance from workspace .gitignore
  private gitignoreMatcher: Ignore = ignoreLib();
  // When true, all file-system events are suppressed (used during branch switch)
  private _suppressed: boolean = false;

  constructor(
    private stateManager: StateManager,
    onStateChanged: () => void,
    onIgnoreRulesChanged?: () => void
  ) {
    this.onStateChanged = onStateChanged;
    this.onIgnoreRulesChanged = onIgnoreRulesChanged;
  }

  register(context: vscode.ExtensionContext): void {
    this.loadGitignore();

    const gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
    gitignoreWatcher.onDidChange(() => { this.loadGitignore(); this.onIgnoreRulesChanged?.(); });
    gitignoreWatcher.onDidCreate(() => { this.loadGitignore(); this.onIgnoreRulesChanged?.(); });
    gitignoreWatcher.onDidDelete(() => { this.loadGitignore(); this.onIgnoreRulesChanged?.(); });
    this.disposables.push(gitignoreWatcher);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidChange(uri => this.onDiskChange(uri));
    watcher.onDidDelete(uri => this.onDiskDelete(uri));
    watcher.onDidCreate(uri => this.onDiskCreate(uri));
    this.disposables.push(watcher);

    // onWillDeleteFiles fires for user-initiated deletes (explorer, applyEdit),
    // but NOT for external tool deletes — use this to distinguish the two.
    // onDidDeleteFiles may fire before FileSystemWatcher.onDidDelete, so we use
    // a short timeout as fallback cleanup instead of removing immediately.
    this.disposables.push(
      vscode.workspace.onWillDeleteFiles(e => {
        for (const uri of e.files) {
          this.pendingUserDeletes.add(uri.fsPath);
        }
      }),
      vscode.workspace.onDidDeleteFiles(e => {
        setTimeout(() => {
          for (const uri of e.files) {
            this.pendingUserDeletes.delete(uri.fsPath);
          }
        }, 500);
      }),
      // onWillRenameFiles fires BEFORE the actual rename. Record paths so
      // the subsequent onDiskDelete/onDiskCreate events are suppressed, and
      // migrate state+git. UI refresh is deferred to onDidRenameFiles because
      // the new file doesn't exist on disk yet when onWill fires.
      vscode.workspace.onWillRenameFiles(e => {
        for (const { oldUri, newUri } of e.files) {
          const oldPath = oldUri.fsPath;
          const newPath = newUri.fsPath;
          if (!this.stateManager.enabled) continue;
          log(`rename: ${path.basename(oldPath)} → ${path.basename(newPath)}`);
          this.pendingRenameOldPaths.add(oldPath);
          this.selfEditFiles.add(newPath);
          this.stateManager.renameFile(oldPath, newPath);
        }
      }),
      vscode.workspace.onDidRenameFiles(e => {
        let needsRefresh = false;
        for (const { oldUri, newUri } of e.files) {
          this.pendingRenameOldPaths.delete(oldUri.fsPath);
          this.selfEditFiles.delete(newUri.fsPath);
          if (this.stateManager.getFile(newUri.fsPath)) {
            needsRefresh = true;
          }
        }
        if (needsRefresh) this.onStateChanged();
      }),
    );

    const docChange = vscode.workspace.onDidChangeTextDocument(e => {
      this.onDocumentChange(e);
    });
    this.disposables.push(docChange);

    context.subscriptions.push(...this.disposables);
  }

  private loadGitignore(): void {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.gitignoreMatcher = ignoreLib();
    if (!rootPath) return;

    // Load global gitignore (core.excludesfile or default ~/.config/git/ignore)
    try {
      const { execFileSync } = require('child_process');
      const globalPath = (execFileSync('git', ['config', '--global', 'core.excludesfile'], {
        encoding: 'utf-8',
        timeout: 3000,
      }) as string).trim();
      if (globalPath) {
        const resolved = globalPath.startsWith('~')
          ? path.join(require('os').homedir(), globalPath.slice(1))
          : globalPath;
        try {
          this.gitignoreMatcher.add(fs.readFileSync(resolved, 'utf-8'));
        } catch { /* file may not exist */ }
      }
    } catch {
      // No core.excludesfile configured — try default location
      try {
        const defaultPath = path.join(require('os').homedir(), '.config', 'git', 'ignore');
        this.gitignoreMatcher.add(fs.readFileSync(defaultPath, 'utf-8'));
      } catch { /* no global gitignore */ }
    }

    // Collect all .gitignore files recursively from workspace root.
    // Root .gitignore rules are added directly; sub-directory rules get a
    // relative-path prefix so the single matcher instance handles scoping.
    this.collectGitignores(rootPath, rootPath);
  }

  /**
   * Recursively collect .gitignore files starting from `dir`.
   * Skips directories already ignored by the current matcher state.
   */
  private collectGitignores(dir: string, rootPath: string): void {
    const gitignorePath = path.join(dir, '.gitignore');
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      if (dir === rootPath) {
        this.gitignoreMatcher.add(content);
      } else {
        const prefix = path.relative(rootPath, dir);
        this.gitignoreMatcher.add(prefixGitignoreRules(content, prefix));
      }
    } catch { /* no .gitignore in this directory */ }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootPath, full);
      // Skip directories already ignored — no need to descend
      if (this.gitignoreMatcher.ignores(rel + '/')) continue;
      this.collectGitignores(full, rootPath);
    }
  }

  /** Suppress all file-system event handling (used during branch switch). */
  suppressAll(): void {
    this._suppressed = true;
  }

  /** Resume file-system event handling after branch switch completes. */
  resumeAll(): void {
    this._suppressed = false;
  }

  markSelfEdit(filePath: string): void {
    this.selfEditFiles.add(filePath);
  }

  clearSelfEdit(filePath: string): void {
    this.selfEditFiles.delete(filePath);
  }

  shouldIgnore(filePath: string, isDirectory?: boolean): boolean {
    const hunkwiseDir = this.stateManager.dir;
    if (hunkwiseDir && filePath.startsWith(hunkwiseDir + path.sep)) return true;
    if (hunkwiseDir && filePath === hunkwiseDir) return true;

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) return false;

    let relPath = path.relative(rootPath, filePath);
    if (relPath.startsWith('..')) return false;

    // The `ignore` library requires a trailing slash to match directory-only
    // patterns (e.g. `.vscode-test/`). Without it, `ignores('.vscode-test')`
    // returns false even though the pattern is meant to ignore that directory.
    if (isDirectory) relPath += '/';

    const userMatcher = ignoreLib().add(this.stateManager.ignorePatterns);
    if (userMatcher.ignores(relPath)) return true;

    if (this.stateManager.respectGitignore && this.gitignoreMatcher.ignores(relPath)) return true;

    return false;
  }

  private async onDiskCreate(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;
    const basename = path.basename(filePath);
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;

    const fileState = this.stateManager.getFile(filePath);
    log(`onDiskCreate(${basename}): fileState=${fileState ? `{status:${fileState.status}, baseline.len:${fileState.baseline?.length ?? 'null'}}` : 'undefined'}`);
    if (fileState?.status === 'reviewing') {
      // File was deleted (showing deletion hunk) but now re-created — recompute
      let diskContent: string;
      try {
        diskContent = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        log(`onDiskCreate(${basename}): read failed while reviewing, skip`);
        return;
      }
      log(`onDiskCreate(${basename}): reviewing, recompute hunks (baseline.len=${fileState.baseline?.length ?? 'null'}, disk.len=${diskContent.length})`);
      this.recomputeHunks(filePath, fileState.baseline, diskContent);
      return;
    }
    if (fileState) { log(`onDiskCreate(${basename}): has fileState but not reviewing, skip`); return; }

    const git = this.stateManager.git;
    if (!git) { log(`onDiskCreate(${basename}): no git, skip`); return; }

    let diskContent: string;
    try {
      diskContent = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      log(`onDiskCreate(${basename}): read failed, skip`);
      return;
    }

    const gitBaseline = await git.getBaseline(filePath);
    log(`onDiskCreate(${basename}): gitBaseline=${gitBaseline !== undefined ? `'${gitBaseline.length} chars'` : 'undefined'}`);
    if (gitBaseline !== undefined) {
      // Hunkwise already has a baseline — treat as a change
      log(`onDiskCreate(${basename}): has baseline, enterReviewing as change`);
      this.enterReviewing(filePath, gitBaseline, diskContent);
      return;
    }

    // Check if this was a manual create in VSCode (editor buffer matches disk)
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
    const bufferMatch = openDoc ? openDoc.getText() === diskContent : false;
    log(`onDiskCreate(${basename}): openDoc=${!!openDoc}, bufferMatch=${bufferMatch}`);
    if (openDoc && bufferMatch) {
      // User created/saved this file in VSCode — snapshot as baseline, no hunk
      log(`onDiskCreate(${basename}): buffer matches disk, snapshot as baseline`);
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }

    // External tool created this file — show as new file hunk (null = file didn't exist before)
    log(`onDiskCreate(${basename}): external create, enterReviewing as NEW`);
    this.enterReviewing(filePath, null, diskContent);
  }

  private async onDiskDelete(uri: vscode.Uri): Promise<void> {
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    const filePath = uri.fsPath;
    const basename = path.basename(filePath);
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;

    const fileState = this.stateManager.getFile(filePath);
    const git = this.stateManager.git;

    if (this.pendingRenameOldPaths.has(filePath)) {
      // User-initiated rename — renameFile already migrated state+git, nothing to do
      this.pendingRenameOldPaths.delete(filePath);
      log(`onDiskDelete(${basename}): rename old path, skip`);
      return;
    }

    if (this.pendingUserDeletes.has(filePath)) {
      // User-initiated delete (explorer / VSCode API) — treat as manual, remove baseline.
      // Always go through stateManager.removeFile so git ops are serialized via gitQueue.
      this.pendingUserDeletes.delete(filePath);
      log(`onDiskDelete(${basename}): user delete, removeFile`);
      this.stateManager.removeFile(filePath);
      if (fileState) {
        this.onStateChanged();
      }
      return;
    }

    // External tool deleted the file
    if (!git) { log(`onDiskDelete(${basename}): no git, skip`); return; }

    // If file was new (null baseline), just clean up — nothing to show, nothing in git
    if (fileState?.baseline === null) {
      log(`onDiskDelete(${basename}): new file (null baseline) deleted, removing fileState`);
      this.stateManager.exitReviewing(filePath);
      this.onStateChanged();
      return;
    }

    const gitBaseline = fileState?.baseline ?? await git.getBaseline(filePath);
    log(`onDiskDelete(${basename}): external delete, gitBaseline=${gitBaseline !== undefined ? `'${gitBaseline.length} chars'` : 'undefined'}`);
    if (gitBaseline === undefined) {
      // Not tracked at all — nothing to show
      if (fileState) {
        log(`onDiskDelete(${basename}): no baseline, removing fileState`);
        this.stateManager.removeFile(filePath);
        this.onStateChanged();
      }
      return;
    }
    // gitBaseline is '' (empty file) or has content — enterReviewing records
    // this as a deletion (isDeleted=true), which passes the 0-hunk guard too.
    this.enterReviewing(filePath, gitBaseline, '');
  }

  private async onDiskChange(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;

    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;

    let diskContent: string;
    try {
      diskContent = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      return;
    }

    const fileState = this.stateManager.getFile(filePath);

    if (fileState?.status === 'reviewing') {
      // Already has diff — recompute against known baseline
      this.recomputeHunks(filePath, fileState.baseline, diskContent);
      return;
    }

    const git = this.stateManager.git;
    if (!git) return;

    // Check if this was a manual save in VSCode (editor buffer matches disk)
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
    if (openDoc && openDoc.getText() === diskContent) {
      // User saved in VSCode — accept into baseline, no hunk
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }

    // External change — compare against hunkwise baseline
    const gitBaseline = await git.getBaseline(filePath);
    if (gitBaseline === undefined) {
      // No baseline in git — silently adopt current content as baseline rather than
      // treating as a new file. This avoids false "new file" hunks in cases like:
      // - ignore rules just changed (file newly un-ignored, not actually new)
      // - syncIgnoreState hasn't finished its git queue yet
      // - first enable where snapshotWorkspace is still in progress
      // Genuine new files created while hunkwise is running are caught by onDidCreate,
      // not this path. This is intentionally consistent with syncIgnoreState's toAdd
      // behavior which also silently snapshots.
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }
    this.enterReviewing(filePath, gitBaseline, diskContent);
  }

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (e.document.uri.scheme !== 'file') return;
    const filePath = e.document.uri.fsPath;

    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;

    const fileState = this.stateManager.getFile(filePath);
    if (fileState?.status !== 'reviewing') return;

    // Already has diff — recompute hunks against baseline
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      const latestState = this.stateManager.getFile(filePath);
      if (!latestState || latestState.status !== 'reviewing') return;
      this.recomputeHunks(filePath, latestState.baseline, e.document.getText());
    }, 50);
    this.debounceTimers.set(filePath, timer);
  }

  private enterReviewing(filePath: string, baseline: string | null, current: string): void {
    const hunks = computeHunks(baseline, current);
    const isNew = baseline === null;
    const isDeleted = current === '' && baseline !== null;
    // Allow 0-hunk entry for new files (null baseline) and deleted files (file gone, nothing to diff)
    if (hunks.length === 0 && !isNew && !isDeleted) return;
    const tag = isNew ? ' (new)' : isDeleted ? ' (deleted)' : '';
    log(`reviewing: ${path.basename(filePath)}${tag}`);
    this.stateManager.setFile(filePath, { status: 'reviewing', baseline });
    this.onStateChanged();
  }

  private recomputeHunks(filePath: string, baseline: string | null, current: string): void {
    if (computeHunks(baseline, current).length === 0) {
      // No diff remaining — exit reviewing.
      // For null-baseline (new) files with empty current, keep reviewing
      // so the user can still accept/discard.
      if (baseline === null && current === '') {
        this.onStateChanged();
        return;
      }
      this.stateManager.exitReviewing(filePath);
    }
    this.onStateChanged();
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingUserDeletes.clear();
    this.pendingRenameOldPaths.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
