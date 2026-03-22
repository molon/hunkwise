import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ignoreLib: ((options?: { ignoreCase?: boolean }) => import('ignore').Ignore) & typeof import('ignore') = require('ignore');
type Ignore = import('ignore').Ignore;
import { StateManager } from './stateManager';
import { computeHunks } from './diffEngine';

export class FileWatcher {
  private disposables: vscode.Disposable[] = [];
  private selfEditFiles: Set<string> = new Set();
  // Files being deleted by the user via VSCode (explorer / applyEdit)
  private pendingUserDeletes: Set<string> = new Set();
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

    const gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
    gitignoreWatcher.onDidChange(() => { this.loadGitignore(); this.onIgnoreRulesChanged?.(); });
    gitignoreWatcher.onDidCreate(() => { this.loadGitignore(); this.onIgnoreRulesChanged?.(); });
    gitignoreWatcher.onDidDelete(() => { this.gitignoreMatcher = ignoreLib(); this.onIgnoreRulesChanged?.(); });
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
    const gitignorePath = path.join(rootPath, '.gitignore');
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      this.gitignoreMatcher.add(content);
    } catch {
      // No .gitignore — matcher stays empty
    }
  }

  markSelfEdit(filePath: string): void {
    this.selfEditFiles.add(filePath);
  }

  clearSelfEdit(filePath: string): void {
    this.selfEditFiles.delete(filePath);
  }

  shouldIgnore(filePath: string): boolean {
    const hunkwiseDir = this.stateManager.dir;
    if (hunkwiseDir && filePath.startsWith(hunkwiseDir + path.sep)) return true;
    if (hunkwiseDir && filePath === hunkwiseDir) return true;

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) return false;

    const relPath = path.relative(rootPath, filePath);
    if (relPath.startsWith('..')) return false;

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
      await git.snapshot(filePath, diskContent);
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
      await git.snapshot(filePath, diskContent);
      return;
    }

    // External change — compare against hunkwise baseline
    const gitBaseline = await git.getBaseline(filePath);
    if (gitBaseline === undefined) {
      // No baseline yet — snapshot current content as baseline
      await git.snapshot(filePath, diskContent);
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
    this.disposables.forEach(d => d.dispose());
  }
}
