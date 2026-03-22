import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { DecorationManager } from './decorationManager';
import { ReviewPanel } from './reviewPanel';
import { registerCommands, acceptHunk, discardHunk } from './commands';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const stateManager = new StateManager();
  await stateManager.load();

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
  syncIgnore = () => stateManager.syncIgnoreState(fp => fileWatcher.shouldIgnore(fp)).then(onStateChanged);
  fileWatcher.register(context);

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

  onStateChanged();

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

  context.subscriptions.push({
    dispose: () => { decorationManager?.dispose(); },
  });

  activeStateManager = stateManager;
}

let activeStateManager: StateManager | undefined;

export async function deactivate(): Promise<void> {
  await activeStateManager?.flush();
}
