import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { DecorationManager } from './decorationManager';
import { ReviewPanel } from './reviewPanel';
import { registerCommands, acceptHunk, discardHunk } from './commands';
import { initLog, log } from './log';

export async function activate(context: vscode.ExtensionContext): Promise<{ getReviewPanel: () => ReviewPanel | undefined; getStateManager: () => StateManager | undefined }> {
  initLog();
  const ext = vscode.extensions.getExtension('molon.hunkwise');
  log(`activate v${ext?.packageJSON?.version ?? '?'}`);
  const stateManager = new StateManager();

  // Content provider for showing deleted file baselines in diff view
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('hunkwise-baseline', {
      provideTextDocumentContent(uri: vscode.Uri): string {
        const filePath = uri.path;
        const fileState = stateManager.getFile(filePath);
        return fileState?.baseline ?? '';
      },
    })
  );

  let decorationManager: DecorationManager | undefined;
  let reviewPanel: ReviewPanel | undefined;

  function onStateChanged(): void {
    decorationManager?.refresh();
    reviewPanel?.refresh();
  }

  let syncIgnore: () => void;
  const fileWatcher = new FileWatcher(stateManager, onStateChanged, () => syncIgnore());
  syncIgnore = () => stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)).then(onStateChanged);
  // Register watcher early so gitignoreMatcher is initialized before load()
  fileWatcher.register(context);

  await stateManager.load((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
  log(`loaded state: enabled=${stateManager.enabled}, files=${stateManager.getAllFiles().size}`);

  decorationManager = new DecorationManager(stateManager, (command, filePath, hId) => {
    if (command === 'accept') {
      acceptHunk(stateManager, filePath, hId, onStateChanged);
    } else {
      discardHunk(stateManager, fileWatcher, filePath, hId, onStateChanged);
    }
  });

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      decorationManager?.refresh(editors);
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) decorationManager?.refresh([editor]);
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== 'file') return;
      const editor = vscode.window.visibleTextEditors.find(
        ed => ed.document.uri.fsPath === e.document.uri.fsPath
      );
      if (editor) decorationManager?.refresh([editor]);
      reviewPanel?.refresh();
    }),
  );

  reviewPanel = new ReviewPanel(context, stateManager, fileWatcher, onStateChanged);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hunkwiseToolbar', reviewPanel)
  );

  registerCommands(context, stateManager, fileWatcher, reviewPanel, onStateChanged);

  context.subscriptions.push(
    vscode.commands.registerCommand('hunkwise.openSettings', () => {
      reviewPanel?.openSettings();
    })
  );

  // Sync ignore state on startup in case .gitignore or ignorePatterns
  // changed while VSCode was closed. Show loading state during sync so
  // the panel doesn't flash stale data before the sync completes.
  if (stateManager.enabled) {
    reviewPanel.setLoading(true);
    log('startup sync: begin');
    Promise.all([
      new Promise(resolve => setTimeout(resolve, 750)),
      stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)),
    ]).then(() => {
      log('startup sync: complete');
      reviewPanel?.setLoading(false);
      onStateChanged();
    }).catch((err) => {
      log(`startup sync: error — ${err}`);
      reviewPanel?.setLoading(false);
      onStateChanged();
    });
  } else {
    onStateChanged();
  }

  // ── Watch .vscode/hunkwise/git/ for deletion ────────────────────────────────
  // Detects: git dir deleted → reset to disabled; settings.json changed → reload patterns.
  const hunkwiseDir = stateManager.dir;
  if (hunkwiseDir) {
    const gitDir = path.join(hunkwiseDir, 'git');
    let settingsWatcher: fs.FSWatcher | undefined;

    const startSettingsWatch = () => {
      if (!fs.existsSync(hunkwiseDir)) return;
      try {
        settingsWatcher = fs.watch(hunkwiseDir, { persistent: false }, (_eventType, filename) => {
          if (filename === 'settings.json') {
            stateManager.reloadIgnorePatterns();
            syncIgnore();
          }
        });
      } catch { /* dir may not exist */ }
    };

    // Poll for git dir existence — detect external deletion
    const pollInterval = setInterval(() => {
      const gitExists = fs.existsSync(gitDir);
      if (!gitExists && stateManager.enabled) {
        log('git dir deleted externally — resetting to disabled');
        settingsWatcher?.close();
        settingsWatcher = undefined;
        stateManager.resetToDisabled();
        onStateChanged();
      } else if (gitExists && stateManager.enabled && !settingsWatcher) {
        startSettingsWatch();
      }
    }, 1000);

    startSettingsWatch();

    context.subscriptions.push({
      dispose: () => {
        clearInterval(pollInterval);
        settingsWatcher?.close();
      },
    });
  }

  // ── Watch .git/HEAD for branch switches ─────────────────────────────────────
  // When clearOnBranchSwitch is enabled, clear all reviewing hunks on branch switch.
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    const gitHeadPath = path.join(workspaceRoot, '.git', 'HEAD');
    let lastHead: string | undefined;
    try { lastHead = fs.readFileSync(gitHeadPath, 'utf-8').trim(); } catch { /* no .git */ }

    if (lastHead !== undefined) {
      let headWatcher: fs.FSWatcher | undefined;
      const startHeadWatch = () => {
        try {
          headWatcher = fs.watch(gitHeadPath, { persistent: false }, () => {
            if (!stateManager.enabled || !stateManager.clearOnBranchSwitch) return;
            let currentHead: string | undefined;
            try { currentHead = fs.readFileSync(gitHeadPath, 'utf-8').trim(); } catch { return; }
            if (currentHead !== lastHead) {
              lastHead = currentHead;
              log(`branch switched → clearing hunks`);
              stateManager.clearHunksOnBranchSwitch().then(onStateChanged);
            }
          });
        } catch { /* .git/HEAD may not exist in some workspaces */ }
      };
      startHeadWatch();
      context.subscriptions.push({ dispose: () => headWatcher?.close() });
    }
  }

  context.subscriptions.push({
    dispose: () => { decorationManager?.dispose(); },
  });

  activeStateManager = stateManager;
  activeReviewPanel = reviewPanel;

  return { getReviewPanel, getStateManager };
}

let activeStateManager: StateManager | undefined;
let activeReviewPanel: ReviewPanel | undefined;

/** Exposed for integration tests */
export function getReviewPanel(): ReviewPanel | undefined {
  return activeReviewPanel;
}

/** Exposed for integration tests */
export function getStateManager(): StateManager | undefined {
  return activeStateManager;
}

export async function deactivate(): Promise<void> {
  log('deactivate');
  await activeStateManager?.flush();
}
