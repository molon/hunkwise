import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { computeHunks, hunkId } from './diffEngine';

export class DiffCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private stateManager: StateManager) {}

  fire(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== 'file') return [];
    if (!this.stateManager.enabled) return [];

    // Only show CodeLenses when:
    // 1. A hunkwise diff tab for this file is the active tab in some group
    // 2. No normal editor (viewColumn defined) for this file is visible
    //    (avoids duplicate actions when split-view shows both diff + normal editor)
    if (!this.isActiveHunkwiseDiffTab(document.uri)) return [];
    if (this.hasVisibleNormalEditor(document.uri)) return [];

    const fileState = this.stateManager.getFile(document.uri.fsPath);
    if (!fileState || fileState.status !== 'reviewing') return [];

    const hunks = computeHunks(fileState.baseline, document.getText());
    const lenses: vscode.CodeLens[] = [];

    for (const hunk of hunks) {
      // CodeLens renders above the target line, so place it on the line
      // after the hunk to appear visually below the changed block.
      const afterHunk = hunk.newStart - 1 + hunk.newLines;
      const line = Math.min(afterHunk, document.lineCount - 1);
      const range = new vscode.Range(line, 0, line, 0);
      const id = hunkId(hunk);

      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(check) Accept',
          command: 'hunkwise.codeLensAcceptHunk',
          arguments: [document.uri.fsPath, id],
        }),
        new vscode.CodeLens(range, {
          title: '$(x) Discard',
          command: 'hunkwise.codeLensDiscardHunk',
          arguments: [document.uri.fsPath, id],
        }),
      );
    }

    return lenses;
  }

  private hasVisibleNormalEditor(uri: vscode.Uri): boolean {
    const fsPath = uri.fsPath;
    return vscode.window.visibleTextEditors.some(
      e => e.document.uri.scheme === 'file'
        && e.document.uri.fsPath === fsPath
        && e.viewColumn !== undefined
    );
  }

  private isActiveHunkwiseDiffTab(uri: vscode.Uri): boolean {
    const fsPath = uri.fsPath;
    for (const group of vscode.window.tabGroups.all) {
      const active = group.activeTab;
      if (active?.input instanceof vscode.TabInputTextDiff) {
        if (active.input.original.scheme === 'hunkwise-baseline'
          && active.input.modified.fsPath === fsPath) {
          return true;
        }
      }
    }
    return false;
  }
}
