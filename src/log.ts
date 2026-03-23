import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Hunkwise');
  }
}

export function log(message: string): void {
  channel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}
