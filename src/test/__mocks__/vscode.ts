// Minimal vscode stub for unit-testing gitignoreManager.
// Only vscode.workspace.workspaceFolders is used.

declare const global: Record<string, unknown>;

export const workspace = {
  get workspaceFolders() {
    const root = global.__hunkwiseTestRoot as string | undefined;
    if (!root) return undefined;
    return [{ uri: { fsPath: root } }];
  },
};
