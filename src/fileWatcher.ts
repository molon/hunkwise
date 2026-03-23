import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ignoreLib: ((options?: { ignoreCase?: boolean }) => import('ignore').Ignore) & typeof import('ignore') = require('ignore');
type Ignore = import('ignore').Ignore;
import { StateManager } from './stateManager';
import { computeHunks } from './diffEngine';
import { log } from './log';

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

    // Only watch the root .gitignore — sub-directory .gitignore changes (e.g. from
    // integration tests in workspace sub-folders) must not reset the matcher or trigger sync.
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const gitignoreWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootPath || '', '.gitignore')
    );
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

    // Load workspace .gitignore
    const gitignorePath = path.join(rootPath, '.gitignore');
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      this.gitignoreMatcher.add(content);
    } catch {
      // No .gitignore — matcher stays empty (global rules still active)
    }
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
    if (!this.stateManager.enabled) return;
    const filePath = uri.fsPath;
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;
    if (this.stateManager.getFile(filePath)) return;

    const git = this.stateManager.git;
    if (!git) return;

    let diskContent: string;
    try {
      diskContent = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      return;
    }
    if (diskContent.length === 0) return;

    const gitBaseline = await git.getBaseline(filePath);
    if (gitBaseline !== undefined) {
      // Hunkwise already has a baseline — treat as a change
      this.enterReviewing(filePath, gitBaseline, diskContent);
      return;
    }

    // Check if this was a manual create in VSCode (editor buffer matches disk)
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
    if (openDoc && openDoc.getText() === diskContent) {
      // User created/saved this file in VSCode — snapshot as baseline, no hunk
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }

    // External tool created this file — show as new file hunk
    this.enterReviewing(filePath, '', diskContent);
  }

  private async onDiskDelete(uri: vscode.Uri): Promise<void> {
    if (!this.stateManager.enabled) return;
    const filePath = uri.fsPath;
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;

    const fileState = this.stateManager.getFile(filePath);
    const git = this.stateManager.git;

    if (this.pendingRenameOldPaths.has(filePath)) {
      // User-initiated rename — renameFile already migrated state+git, nothing to do
      this.pendingRenameOldPaths.delete(filePath);
      return;
    }

    if (this.pendingUserDeletes.has(filePath)) {
      // User-initiated delete (explorer / VSCode API) — treat as manual, update baseline
      this.pendingUserDeletes.delete(filePath);
      if (git) await git.removeFile(filePath).catch(() => {});
      if (fileState) {
        this.stateManager.removeFile(filePath);
        this.onStateChanged();
      }
      return;
    }

    // External tool deleted the file — always produce a hunk
    if (!git) return;
    const gitBaseline = fileState?.baseline ?? await git.getBaseline(filePath);
    if (gitBaseline === undefined || gitBaseline === '') {
      // No baseline (new untracked file deleted) — nothing to show
      if (fileState) {
        this.stateManager.removeFile(filePath);
        this.onStateChanged();
      }
      return;
    }
    this.enterReviewing(filePath, gitBaseline, '');
  }

  private async onDiskChange(uri: vscode.Uri): Promise<void> {
    if (!this.stateManager.enabled) return;
    const filePath = uri.fsPath;

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
      // No baseline yet — snapshot current content as baseline
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }
    this.enterReviewing(filePath, gitBaseline, diskContent);
  }

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
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

  private enterReviewing(filePath: string, baseline: string, current: string): void {
    if (computeHunks(baseline, current).length === 0) return;
    const isNew = baseline === '';
    const isDeleted = current === '';
    const tag = isNew ? ' (new)' : isDeleted ? ' (deleted)' : '';
    log(`reviewing: ${path.basename(filePath)}${tag}`);
    this.stateManager.setFile(filePath, { status: 'reviewing', baseline });
    this.onStateChanged();
  }

  private recomputeHunks(filePath: string, baseline: string, current: string): void {
    if (computeHunks(baseline, current).length === 0) {
      this.stateManager.removeFile(filePath);
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
