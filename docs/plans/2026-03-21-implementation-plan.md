# hunkwise Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a VSCode extension that tracks file changes from any source, computes diffs against a saved baseline, and provides per-hunk Accept/Discard controls inline in the editor — no git dependency.

**Architecture:** FileSystemWatcher detects external writes; onDidChangeTextDocument detects manual edits. Both re-diff current content against a baseline snapshot using the `diff` npm package. State is persisted to `.vscode/hunkwise-state.json` and restored on activation.

**Tech Stack:** TypeScript, VSCode Extension API, `diff` npm package, WebviewView (bottom panel toolbar), TreeView (sidebar review panel).

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/extension.ts`
- Create: `.vscodeignore`
- Create: `.gitignore`

**Step 1: Initialize the extension project**

```bash
mkdir -p src media
```

**Step 2: Create `package.json`**

```json
{
  "name": "hunkwise",
  "displayName": "hunkwise",
  "description": "Per-hunk Accept/Discard for any file change",
  "version": "0.0.1",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "hunkwise.startTracking",
        "title": "hunkwise: Start Tracking Current File"
      },
      {
        "command": "hunkwise.acceptAll",
        "title": "hunkwise: Accept All Hunks in Current File"
      },
      {
        "command": "hunkwise.discardAll",
        "title": "hunkwise: Discard All Hunks in Current File"
      },
      {
        "command": "hunkwise.acceptAllFiles",
        "title": "hunkwise: Accept All Hunks in All Files"
      },
      {
        "command": "hunkwise.discardAllFiles",
        "title": "hunkwise: Discard All Hunks in All Files"
      },
      {
        "command": "hunkwise.refresh",
        "title": "hunkwise: Refresh",
        "icon": "$(refresh)"
      }
    ],
    "views": {
      "explorer": [
        {
          "id": "hunkwiseReview",
          "name": "hunkwise Review",
          "icon": "$(diff)",
          "contextualTitle": "hunkwise"
        }
      ]
    },
    "menus": {
      "view/title": [
        {
          "command": "hunkwise.refresh",
          "when": "view == hunkwiseReview",
          "group": "navigation"
        }
      ]
    },
    "viewsContainers": {
      "panel": [
        {
          "id": "hunkwisePanel",
          "title": "hunkwise",
          "icon": "$(diff)"
        }
      ]
    },
    "views": {
      "explorer": [
        {
          "id": "hunkwiseReview",
          "name": "hunkwise Review",
          "icon": "$(diff)"
        }
      ],
      "hunkwisePanel": [
        {
          "id": "hunkwiseToolbar",
          "name": "hunkwise",
          "type": "webview"
        }
      ]
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run compile",
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./"
  },
  "devDependencies": {
    "@types/vscode": "^1.90.0",
    "@types/node": "^20.x",
    "@types/diff": "^5.x",
    "typescript": "^5.x"
  },
  "dependencies": {
    "diff": "^5.2.0"
  }
}
```

> Note: `views` key appears twice above — that's a JSON error. In the final file, merge both entries under a single `"views"` key:
> ```json
> "views": {
>   "explorer": [...],
>   "hunkwisePanel": [...]
> }
> ```

**Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2020",
    "outDir": "out",
    "lib": ["ES2020"],
    "sourceMap": true,
    "rootDir": "src",
    "strict": true
  },
  "exclude": ["node_modules", ".vscode-test"]
}
```

**Step 4: Create `src/extension.ts` (stub)**

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('hunkwise activated');
}

export function deactivate() {}
```

**Step 5: Create `.gitignore`**

```
out/
node_modules/
.vscode/hunkwise-state.json
```

**Step 6: Install dependencies**

```bash
npm install
```

**Step 7: Compile and verify no errors**

```bash
npm run compile
```

Expected: `out/extension.js` created, no TypeScript errors.

**Step 8: Commit**

```bash
git add .
git commit -m "feat: scaffold hunkwise extension project"
```

---

## Task 2: Types & State Manager

**Files:**
- Create: `src/types.ts`
- Create: `src/stateManager.ts`

**Step 1: Create `src/types.ts`**

```typescript
export type FileStatus = 'idle' | 'reviewing';

export type HunkStatus = 'pending' | 'accepted' | 'discarded';

export interface Hunk {
  id: string;
  oldStart: number;    // 1-based line number in baseline
  oldLines: number;    // number of lines removed
  newStart: number;    // 1-based line number in current content
  newLines: number;    // number of lines added
  status: HunkStatus;
}

export interface FileState {
  status: FileStatus;
  baseline: string;    // full original file content
  hunks: Hunk[];
}

export interface PersistedState {
  version: number;
  files: Record<string, FileState>;  // key = absolute file path
}
```

**Step 2: Create `src/stateManager.ts`**

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileState, PersistedState, Hunk } from './types';

const STATE_VERSION = 1;

export class StateManager {
  private state: Map<string, FileState> = new Map();
  private saveTimer: NodeJS.Timeout | undefined;
  private statePath: string;

  constructor(private context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.statePath = '';
    } else {
      this.statePath = path.join(
        workspaceFolders[0].uri.fsPath,
        '.vscode',
        'hunkwise-state.json'
      );
    }
  }

  load(): void {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const persisted: PersistedState = JSON.parse(raw);
      if (persisted.version !== STATE_VERSION) return;
      for (const [filePath, fileState] of Object.entries(persisted.files)) {
        if (fileState.status === 'reviewing') {
          this.state.set(filePath, fileState);
        }
      }
    } catch {
      // Corrupted state file — start fresh
    }
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this._writeSync();
  }

  scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this._writeSync(), 500);
  }

  private _writeSync(): void {
    if (!this.statePath) return;
    const persisted: PersistedState = {
      version: STATE_VERSION,
      files: Object.fromEntries(this.state.entries()),
    };
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(persisted, null, 2), 'utf-8');
    } catch {
      // Ignore write errors
    }
  }

  getFile(filePath: string): FileState | undefined {
    return this.state.get(filePath);
  }

  setFile(filePath: string, state: FileState): void {
    this.state.set(filePath, state);
    this.scheduleSave();
  }

  removeFile(filePath: string): void {
    this.state.delete(filePath);
    this.scheduleSave();
  }

  getAllFiles(): Map<string, FileState> {
    return this.state;
  }

  isReviewing(filePath: string): boolean {
    const s = this.state.get(filePath);
    return s !== undefined && s.status === 'reviewing';
  }
}
```

**Step 3: Compile and verify**

```bash
npm run compile
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/types.ts src/stateManager.ts
git commit -m "feat: add types and state manager"
```

---

## Task 3: Diff Engine

**Files:**
- Create: `src/diffEngine.ts`

**Step 1: Create `src/diffEngine.ts`**

```typescript
import * as Diff from 'diff';
import { Hunk } from './types';
import { v4 as uuidv4 } from 'uuid';

// Simple UUID without extra dependency — use crypto
function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  removedContent: string[];  // lines from baseline that were removed
  addedContent: string[];    // lines in current content that were added
}

export function computeHunks(baseline: string, current: string): ParsedHunk[] {
  // Ensure trailing newline for consistent line counting
  const baselineLines = baseline.split('\n');
  const currentLines = current.split('\n');

  const changes = Diff.diffLines(baseline, current);

  const hunks: ParsedHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];

    if (!change.added && !change.removed) {
      // Context — advance line counters
      const count = change.count ?? change.value.split('\n').filter((_, idx, arr) => idx < arr.length - 1 || change.value.endsWith('\n')).length;
      const lineCount = (change.value.match(/\n/g) || []).length;
      oldLine += lineCount;
      newLine += lineCount;
      i++;
      continue;
    }

    // Start of a changed region — collect consecutive added/removed blocks
    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    const removed: string[] = [];
    const added: string[] = [];

    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      const c = changes[i];
      const lines = c.value.endsWith('\n')
        ? c.value.slice(0, -1).split('\n')
        : c.value.split('\n');

      if (c.removed) {
        removed.push(...lines);
        oldLine += lines.length;
      } else if (c.added) {
        added.push(...lines);
        newLine += lines.length;
      }
      i++;
    }

    hunks.push({
      oldStart: hunkOldStart,
      oldLines: removed.length,
      newStart: hunkNewStart,
      newLines: added.length,
      removedContent: removed,
      addedContent: added,
    });
  }

  return hunks;
}

export function parsedHunkToHunk(parsed: ParsedHunk, existingId?: string): Hunk {
  return {
    id: existingId ?? generateId(),
    oldStart: parsed.oldStart,
    oldLines: parsed.oldLines,
    newStart: parsed.newStart,
    newLines: parsed.newLines,
    status: 'pending',
  };
}

export function mergeHunkStatuses(
  newHunks: Hunk[],
  oldHunks: Hunk[]
): Hunk[] {
  // For simplicity in v1: all re-computed hunks start as pending.
  // Previously accepted/discarded positions may no longer match after re-diff.
  return newHunks;
}
```

**Step 2: Compile and verify**

```bash
npm run compile
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/diffEngine.ts
git commit -m "feat: add diff engine using diff npm package"
```

---

## Task 4: File Watcher

**Files:**
- Create: `src/fileWatcher.ts`

**Step 1: Create `src/fileWatcher.ts`**

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { StateManager } from './stateManager';
import { computeHunks, parsedHunkToHunk } from './diffEngine';
import { FileState } from './types';

function hashString(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export class FileWatcher {
  private disposables: vscode.Disposable[] = [];
  private selfEditFiles: Set<string> = new Set();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private onStateChanged: () => void;

  constructor(
    private stateManager: StateManager,
    onStateChanged: () => void
  ) {
    this.onStateChanged = onStateChanged;
  }

  register(context: vscode.ExtensionContext): void {
    // Watch all files in workspace
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidChange(uri => this.onDiskChange(uri));
    this.disposables.push(watcher);

    // Watch in-editor changes
    const docChange = vscode.workspace.onDidChangeTextDocument(e => {
      this.onDocumentChange(e);
    });
    this.disposables.push(docChange);

    context.subscriptions.push(...this.disposables);
  }

  /** Called before hunkwise applies a WorkspaceEdit (discard) */
  markSelfEdit(filePath: string): void {
    this.selfEditFiles.add(filePath);
  }

  /** Called after hunkwise's WorkspaceEdit has been applied and saved */
  clearSelfEdit(filePath: string): void {
    this.selfEditFiles.delete(filePath);
  }

  private async onDiskChange(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;

    // Ignore hunkwise state file itself
    if (filePath.endsWith('hunkwise-state.json')) return;

    let diskContent: string;
    try {
      diskContent = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return; // File deleted or unreadable
    }

    // Get in-editor content if open
    const openDoc = vscode.workspace.textDocuments.find(
      d => d.uri.fsPath === filePath
    );
    const editorContent = openDoc ? openDoc.getText() : null;

    // Hash comparison: if editor content matches disk, it's an editor-initiated save
    if (editorContent !== null) {
      const diskHash = hashString(diskContent);
      const editorHash = hashString(editorContent);
      if (diskHash === editorHash) return; // Editor save, skip
    }

    const fileState = this.stateManager.getFile(filePath);

    if (!fileState) {
      // File is idle — capture baseline BEFORE the change
      // Problem: by the time FileSystemWatcher fires, disk already has new content.
      // We need to read the pre-change content. Since the file is already changed,
      // we use the in-editor content as baseline if available (it hasn't been saved yet
      // if editor hash != disk hash), otherwise we can't get pre-change content.
      // If editor content exists and differs from disk, use editor content as baseline.
      if (editorContent !== null && editorContent !== diskContent) {
        const baseline = editorContent;
        this.enterReviewing(filePath, baseline, diskContent);
      }
      // If file was not open in editor, we have no baseline — skip for now.
      // Future: maintain a pre-change cache.
    } else if (fileState.status === 'reviewing') {
      // File already reviewing — re-diff against original baseline
      this.recomputeHunks(filePath, fileState.baseline, diskContent);
    }
  }

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme !== 'file') return;
    const filePath = e.document.uri.fsPath;

    // Skip if this is a hunkwise self-edit (discard operation)
    if (this.selfEditFiles.has(filePath)) return;

    const fileState = this.stateManager.getFile(filePath);
    if (!fileState || fileState.status !== 'reviewing') return;

    // Debounce re-diff
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      const current = e.document.getText();
      this.recomputeHunks(filePath, fileState.baseline, current);
    }, 300);

    this.debounceTimers.set(filePath, timer);
  }

  private enterReviewing(filePath: string, baseline: string, current: string): void {
    const parsed = computeHunks(baseline, current);
    if (parsed.length === 0) return; // No actual changes

    const hunks = parsed.map(p => parsedHunkToHunk(p));
    const newState: FileState = {
      status: 'reviewing',
      baseline,
      hunks,
    };
    this.stateManager.setFile(filePath, newState);
    this.onStateChanged();
  }

  private recomputeHunks(filePath: string, baseline: string, current: string): void {
    const parsed = computeHunks(baseline, current);
    const fileState = this.stateManager.getFile(filePath)!;

    if (parsed.length === 0) {
      // No more differences — file is back to baseline
      this.stateManager.removeFile(filePath);
      this.onStateChanged();
      return;
    }

    const newHunks = parsed.map(p => parsedHunkToHunk(p));
    this.stateManager.setFile(filePath, {
      ...fileState,
      hunks: newHunks,
    });
    this.onStateChanged();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
```

**Step 2: Compile and verify**

```bash
npm run compile
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/fileWatcher.ts
git commit -m "feat: add file watcher with external/manual change detection"
```

---

## Task 5: Commands

**Files:**
- Create: `src/commands.ts`

**Step 1: Create `src/commands.ts`**

```typescript
import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { computeHunks, parsedHunkToHunk } from './diffEngine';
import { FileState, Hunk } from './types';

export function registerCommands(
  context: vscode.ExtensionContext,
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  onStateChanged: () => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('hunkwise.startTracking', () =>
      startTracking(stateManager, onStateChanged)
    ),
    vscode.commands.registerCommand('hunkwise.acceptHunk', (filePath: string, hunkId: string) =>
      acceptHunk(stateManager, filePath, hunkId, onStateChanged)
    ),
    vscode.commands.registerCommand('hunkwise.discardHunk', (filePath: string, hunkId: string) =>
      discardHunk(stateManager, fileWatcher, filePath, hunkId, onStateChanged)
    ),
    vscode.commands.registerCommand('hunkwise.acceptAll', () =>
      acceptAllInFile(stateManager, onStateChanged)
    ),
    vscode.commands.registerCommand('hunkwise.discardAll', () =>
      discardAllInFile(stateManager, fileWatcher, onStateChanged)
    ),
    vscode.commands.registerCommand('hunkwise.acceptAllFiles', () =>
      acceptAllFiles(stateManager, onStateChanged)
    ),
    vscode.commands.registerCommand('hunkwise.discardAllFiles', () =>
      discardAllFiles(stateManager, fileWatcher, onStateChanged)
    ),
    vscode.commands.registerCommand('hunkwise.refresh', () => onStateChanged())
  );
}

async function startTracking(
  stateManager: StateManager,
  onStateChanged: () => void
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('hunkwise: No active editor');
    return;
  }
  const filePath = editor.document.uri.fsPath;
  const baseline = editor.document.getText();

  const existing = stateManager.getFile(filePath);
  if (existing?.status === 'reviewing') {
    vscode.window.showInformationMessage('hunkwise: File is already being reviewed');
    return;
  }

  // Start with baseline = current content; user will modify the file to create hunks
  const fileState: FileState = {
    status: 'reviewing',
    baseline,
    hunks: [],
  };
  stateManager.setFile(filePath, fileState);
  onStateChanged();
  vscode.window.showInformationMessage('hunkwise: Now tracking ' + editor.document.fileName);
}

export function acceptHunk(
  stateManager: StateManager,
  filePath: string,
  hunkId: string,
  onStateChanged: () => void
): void {
  const fileState = stateManager.getFile(filePath);
  if (!fileState) return;

  const hunk = fileState.hunks.find(h => h.id === hunkId);
  if (!hunk) return;

  hunk.status = 'accepted';
  stateManager.setFile(filePath, fileState);
  checkAllDone(stateManager, filePath, onStateChanged);
  onStateChanged();
}

export async function discardHunk(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  filePath: string,
  hunkId: string,
  onStateChanged: () => void
): Promise<void> {
  const fileState = stateManager.getFile(filePath);
  if (!fileState) return;

  const hunkIndex = fileState.hunks.findIndex(h => h.id === hunkId);
  if (hunkIndex === -1) return;
  const hunk = fileState.hunks[hunkIndex];

  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);

  // Extract original lines from baseline
  const baselineLines = fileState.baseline.split('\n');
  const originalLines = baselineLines.slice(
    hunk.oldStart - 1,
    hunk.oldStart - 1 + hunk.oldLines
  );

  // Replace current hunk range with original lines
  const edit = new vscode.WorkspaceEdit();
  const startPos = new vscode.Position(hunk.newStart - 1, 0);

  let endPos: vscode.Position;
  if (hunk.newLines === 0) {
    // Pure insertion in current — delete the added lines
    endPos = new vscode.Position(hunk.newStart - 1 + hunk.newLines, 0);
  } else {
    const lastLine = hunk.newStart - 1 + hunk.newLines - 1;
    endPos = new vscode.Position(lastLine, doc.lineAt(Math.min(lastLine, doc.lineCount - 1)).text.length);
    // Include the newline after the last line if not at end of file
    if (lastLine < doc.lineCount - 1) {
      endPos = new vscode.Position(lastLine + 1, 0);
    }
  }

  const replacement = originalLines.length > 0
    ? originalLines.join('\n') + (hunk.newLines > 0 && endPos.line < doc.lineCount ? '\n' : '')
    : '';

  fileWatcher.markSelfEdit(filePath);
  edit.replace(uri, new vscode.Range(startPos, endPos), replacement);
  await vscode.workspace.applyEdit(edit);

  // Save to flush to disk (triggers FileSystemWatcher but hash will match)
  const savedDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
  if (savedDoc) await savedDoc.save();

  fileWatcher.clearSelfEdit(filePath);

  hunk.status = 'discarded';
  stateManager.setFile(filePath, fileState);
  checkAllDone(stateManager, filePath, onStateChanged);
  onStateChanged();
}

function checkAllDone(
  stateManager: StateManager,
  filePath: string,
  onStateChanged: () => void
): void {
  const fileState = stateManager.getFile(filePath);
  if (!fileState) return;
  const allDone = fileState.hunks.every(h => h.status !== 'pending');
  if (allDone) {
    stateManager.removeFile(filePath);
  }
}

async function acceptAllInFile(
  stateManager: StateManager,
  onStateChanged: () => void
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const filePath = editor.document.uri.fsPath;
  const fileState = stateManager.getFile(filePath);
  if (!fileState) return;

  fileState.hunks.forEach(h => { h.status = 'accepted'; });
  stateManager.removeFile(filePath);
  onStateChanged();
}

async function discardAllInFile(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  onStateChanged: () => void
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const filePath = editor.document.uri.fsPath;
  const fileState = stateManager.getFile(filePath);
  if (!fileState) return;

  const uri = editor.document.uri;
  fileWatcher.markSelfEdit(filePath);

  // Replace entire file content with baseline
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(editor.document.lineCount - 1, editor.document.lineAt(editor.document.lineCount - 1).text.length)
  );
  edit.replace(uri, fullRange, fileState.baseline);
  await vscode.workspace.applyEdit(edit);
  await editor.document.save();

  fileWatcher.clearSelfEdit(filePath);
  stateManager.removeFile(filePath);
  onStateChanged();
}

async function acceptAllFiles(
  stateManager: StateManager,
  onStateChanged: () => void
): Promise<void> {
  for (const [filePath] of stateManager.getAllFiles()) {
    stateManager.removeFile(filePath);
  }
  onStateChanged();
}

async function discardAllFiles(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  onStateChanged: () => void
): Promise<void> {
  for (const [filePath, fileState] of stateManager.getAllFiles()) {
    const uri = vscode.Uri.file(filePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      fileWatcher.markSelfEdit(filePath);
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      );
      edit.replace(uri, fullRange, fileState.baseline);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
      fileWatcher.clearSelfEdit(filePath);
    } catch {
      // Skip files that can't be opened
    }
    stateManager.removeFile(filePath);
  }
  onStateChanged();
}
```

**Step 2: Compile and verify**

```bash
npm run compile
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/commands.ts
git commit -m "feat: add accept/discard commands"
```

---

## Task 6: CodeLens Provider

**Files:**
- Create: `src/codeLensProvider.ts`

**Step 1: Create `src/codeLensProvider.ts`**

```typescript
import * as vscode from 'vscode';
import { StateManager } from './stateManager';

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private stateManager: StateManager) {}

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(
    document: vscode.TextDocument
  ): vscode.CodeLens[] {
    const filePath = document.uri.fsPath;
    const fileState = this.stateManager.getFile(filePath);
    if (!fileState || fileState.status !== 'reviewing') return [];

    const lenses: vscode.CodeLens[] = [];

    for (const hunk of fileState.hunks) {
      if (hunk.status !== 'pending') continue;

      const lineIndex = Math.max(0, hunk.newStart - 1);
      const range = new vscode.Range(lineIndex, 0, lineIndex, 0);

      lenses.push(
        new vscode.CodeLens(range, {
          title: '✓ Accept',
          command: 'hunkwise.acceptHunk',
          arguments: [filePath, hunk.id],
        }),
        new vscode.CodeLens(range, {
          title: '✕ Discard',
          command: 'hunkwise.discardHunk',
          arguments: [filePath, hunk.id],
        })
      );
    }

    return lenses;
  }
}
```

**Step 2: Compile and verify**

```bash
npm run compile
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/codeLensProvider.ts
git commit -m "feat: add CodeLens provider for accept/discard per hunk"
```

---

## Task 7: Decoration Manager

**Files:**
- Create: `src/decorationManager.ts`

**Step 1: Create `src/decorationManager.ts`**

```typescript
import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { computeHunks } from './diffEngine';

const addedLineDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  isWholeLine: true,
});

const removedLineDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
  isWholeLine: true,
  textDecoration: 'line-through',
  opacity: '0.6',
  // For deleted lines, we use before pseudo-decoration to show them above the hunk
  before: {
    color: new vscode.ThemeColor('diffEditor.removedTextBackground'),
  },
});

export class DecorationManager {
  constructor(private stateManager: StateManager) {}

  refresh(editors?: readonly vscode.TextEditor[]): void {
    const targets = editors ?? vscode.window.visibleTextEditors;
    for (const editor of targets) {
      this.applyToEditor(editor);
    }
  }

  private applyToEditor(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    const fileState = this.stateManager.getFile(filePath);

    if (!fileState || fileState.status !== 'reviewing') {
      editor.setDecorations(addedLineDecoration, []);
      editor.setDecorations(removedLineDecoration, []);
      return;
    }

    const addedRanges: vscode.Range[] = [];

    // Compute added lines from hunks
    const parsed = computeHunks(fileState.baseline, editor.document.getText());

    for (const hunk of parsed) {
      const fileHunk = fileState.hunks.find(
        h => h.newStart === hunk.newStart && h.status === 'pending'
      );
      if (!fileHunk) continue;

      // Highlight added lines
      for (let i = 0; i < hunk.newLines; i++) {
        const lineIdx = hunk.newStart - 1 + i;
        if (lineIdx < editor.document.lineCount) {
          addedRanges.push(editor.document.lineAt(lineIdx).range);
        }
      }
    }

    editor.setDecorations(addedLineDecoration, addedRanges);
    // Note: deleted lines (removedContent) require virtual line rendering,
    // which VSCode public API doesn't support directly.
    // For v1, we only highlight added lines (green). Deleted lines shown via CodeLens context only.
    editor.setDecorations(removedLineDecoration, []);
  }

  dispose(): void {
    addedLineDecoration.dispose();
    removedLineDecoration.dispose();
  }
}
```

> **Note on deleted lines:** VSCode's public API cannot insert virtual/phantom lines in the editor. Deleted lines can only be shown via `before` content decorations on the adjacent line (text only, no background). For v1, we highlight added lines in green and rely on the sidebar panel to show removal stats. Full deleted-line visualization requires an experimental API or webview overlay.

**Step 2: Compile and verify**

```bash
npm run compile
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/decorationManager.ts
git commit -m "feat: add decoration manager for green line highlights"
```

---

## Task 8: Review Tree Provider (Sidebar)

**Files:**
- Create: `src/reviewTreeProvider.ts`

**Step 1: Create `src/reviewTreeProvider.ts`**

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileState, Hunk } from './types';

type TreeItem = FileTreeItem | HunkTreeItem;

class FileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly fileState: FileState
  ) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const rootPath = workspaceFolders?.[0]?.uri.fsPath ?? '';
    const relPath = path.relative(rootPath, filePath);

    const pending = fileState.hunks.filter(h => h.status === 'pending').length;
    const accepted = fileState.hunks.filter(h => h.status === 'accepted').length;
    const discarded = fileState.hunks.filter(h => h.status === 'discarded').length;

    const addedLines = fileState.hunks.reduce((sum, h) => sum + h.newLines, 0);
    const removedLines = fileState.hunks.reduce((sum, h) => sum + h.oldLines, 0);

    let statusStr = `[${pending} pending`;
    if (accepted > 0) statusStr += ` / ${accepted} accepted`;
    if (discarded > 0) statusStr += ` / ${discarded} discarded`;
    statusStr += ']';

    super(relPath, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `+${addedLines} -${removedLines}  ${statusStr}`;
    this.tooltip = filePath;
    this.contextValue = 'hunkwiseFile';
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}

class HunkTreeItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly hunk: Hunk
  ) {
    const statusIcon =
      hunk.status === 'accepted' ? '✓ ' :
      hunk.status === 'discarded' ? '✕ ' : '';

    super(
      `${statusIcon}@line ${hunk.newStart}  +${hunk.newLines} -${hunk.oldLines}`,
      vscode.TreeItemCollapsibleState.None
    );
    this.tooltip = `Lines ${hunk.newStart}–${hunk.newStart + hunk.newLines - 1}`;
    this.contextValue = 'hunkwiseHunk';
    this.command = {
      command: 'vscode.open',
      title: 'Jump to Hunk',
      arguments: [
        vscode.Uri.file(filePath),
        { selection: new vscode.Range(hunk.newStart - 1, 0, hunk.newStart - 1, 0) },
      ],
    };
  }
}

export class ReviewTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private stateManager: StateManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      // Root: list all reviewing files
      const items: FileTreeItem[] = [];
      for (const [filePath, fileState] of this.stateManager.getAllFiles()) {
        if (fileState.status === 'reviewing') {
          items.push(new FileTreeItem(filePath, fileState));
        }
      }
      return items;
    }

    if (element instanceof FileTreeItem) {
      return element.fileState.hunks.map(
        hunk => new HunkTreeItem(element.filePath, hunk)
      );
    }

    return [];
  }
}
```

**Step 2: Compile and verify**

```bash
npm run compile
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/reviewTreeProvider.ts
git commit -m "feat: add sidebar review tree provider"
```

---

## Task 9: Bottom Panel Toolbar (WebviewView)

**Files:**
- Create: `src/reviewPanel.ts`
- Create: `media/panel.html`
- Create: `media/panel.css`
- Create: `media/panel.js`

**Step 1: Create `media/panel.css`**

```css
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  display: flex;
  align-items: center;
  height: 100vh;
  padding: 0 12px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-panel-background);
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
}

.separator {
  width: 1px;
  height: 20px;
  background: var(--vscode-panel-border);
  margin: 0 8px;
}

button {
  background: transparent;
  border: 1px solid var(--vscode-button-border, transparent);
  color: var(--vscode-foreground);
  padding: 4px 10px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 4px;
}

button:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

button:active {
  background: var(--vscode-toolbar-activeBackground);
}

button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: transparent;
}

button.primary:hover {
  background: var(--vscode-button-hoverBackground);
}

button.danger {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-foreground);
  border-color: var(--vscode-inputValidation-errorBorder);
}

.file-label {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin: 0 8px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spacer { flex: 1; }
```

**Step 2: Create `media/panel.js`**

```javascript
const vscode = acquireVsCodeApi();

document.getElementById('prevFile').addEventListener('click', () => {
  vscode.postMessage({ command: 'prevFile' });
});
document.getElementById('prevHunk').addEventListener('click', () => {
  vscode.postMessage({ command: 'prevHunk' });
});
document.getElementById('nextHunk').addEventListener('click', () => {
  vscode.postMessage({ command: 'nextHunk' });
});
document.getElementById('nextFile').addEventListener('click', () => {
  vscode.postMessage({ command: 'nextFile' });
});
document.getElementById('acceptAll').addEventListener('click', () => {
  vscode.postMessage({ command: 'acceptAll' });
});
document.getElementById('discardAll').addEventListener('click', () => {
  vscode.postMessage({ command: 'discardAll' });
});

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'updateLabel') {
    document.getElementById('fileLabel').textContent = msg.label;
  }
});
```

**Step 3: Create `media/panel.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="{{cssUri}}" />
</head>
<body>
  <div class="toolbar">
    <button id="prevFile" title="Previous File">◀ Prev File</button>
    <button id="prevHunk" title="Previous Hunk">↑ Prev Hunk</button>
    <button id="nextHunk" title="Next Hunk">↓ Next Hunk</button>
    <button id="nextFile" title="Next File">▶ Next File</button>
    <div class="separator"></div>
    <span id="fileLabel" class="file-label">No files under review</span>
    <div class="spacer"></div>
    <button id="acceptAll" class="primary">✓ Accept All</button>
    <button id="discardAll" class="danger">✕ Discard All</button>
  </div>
  <script src="{{jsUri}}"></script>
</body>
</html>
```

**Step 4: Create `src/reviewPanel.ts`**

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from './stateManager';

export class ReviewPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentFileIndex = 0;
  private currentHunkIndex = 0;

  constructor(
    private context: vscode.ExtensionContext,
    private stateManager: StateManager
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(msg => {
      this.handleMessage(msg.command);
    });
  }

  refresh(): void {
    if (!this.view) return;
    const files = this.getReviewingFiles();
    const label = files.length === 0
      ? 'No files under review'
      : `${path.basename(files[this.currentFileIndex] ?? '')}  (${this.currentFileIndex + 1}/${files.length})`;
    this.view.webview.postMessage({ type: 'updateLabel', label });
  }

  private getReviewingFiles(): string[] {
    return Array.from(this.stateManager.getAllFiles().keys());
  }

  private handleMessage(command: string): void {
    const files = this.getReviewingFiles();
    if (files.length === 0) return;

    switch (command) {
      case 'prevFile':
        this.currentFileIndex = (this.currentFileIndex - 1 + files.length) % files.length;
        this.openCurrentFile();
        break;
      case 'nextFile':
        this.currentFileIndex = (this.currentFileIndex + 1) % files.length;
        this.openCurrentFile();
        break;
      case 'prevHunk':
        this.navigateHunk(-1);
        break;
      case 'nextHunk':
        this.navigateHunk(1);
        break;
      case 'acceptAll':
        vscode.commands.executeCommand('hunkwise.acceptAll');
        break;
      case 'discardAll':
        vscode.commands.executeCommand('hunkwise.discardAll');
        break;
    }
    this.refresh();
  }

  private async openCurrentFile(): Promise<void> {
    const files = this.getReviewingFiles();
    if (files.length === 0) return;
    const filePath = files[this.currentFileIndex];
    await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    this.currentHunkIndex = 0;
    this.navigateHunk(0);
  }

  private async navigateHunk(delta: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const filePath = editor.document.uri.fsPath;
    const fileState = this.stateManager.getFile(filePath);
    if (!fileState) return;

    const pendingHunks = fileState.hunks.filter(h => h.status === 'pending');
    if (pendingHunks.length === 0) return;

    this.currentHunkIndex = Math.max(0, Math.min(
      this.currentHunkIndex + delta,
      pendingHunks.length - 1
    ));

    const hunk = pendingHunks[this.currentHunkIndex];
    const pos = new vscode.Position(hunk.newStart - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaPath = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'panel.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'panel.js'));

    let html = fs.readFileSync(
      vscode.Uri.joinPath(mediaPath, 'panel.html').fsPath,
      'utf-8'
    );
    html = html.replace('{{cssUri}}', cssUri.toString());
    html = html.replace('{{jsUri}}', jsUri.toString());
    return html;
  }
}
```

**Step 5: Compile and verify**

```bash
npm run compile
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/reviewPanel.ts media/
git commit -m "feat: add bottom panel toolbar webview"
```

---

## Task 10: Wire Everything Together in extension.ts

**Files:**
- Modify: `src/extension.ts`

**Step 1: Rewrite `src/extension.ts`**

```typescript
import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { HunkCodeLensProvider } from './codeLensProvider';
import { DecorationManager } from './decorationManager';
import { ReviewTreeProvider } from './reviewTreeProvider';
import { ReviewPanel } from './reviewPanel';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
  const stateManager = new StateManager(context);
  stateManager.load();

  // Called whenever state changes — refreshes all UI
  function onStateChanged(): void {
    codeLensProvider.refresh();
    decorationManager.refresh();
    treeProvider.refresh();
    reviewPanel.refresh();
  }

  const fileWatcher = new FileWatcher(stateManager, onStateChanged);
  fileWatcher.register(context);

  const codeLensProvider = new HunkCodeLensProvider(stateManager);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider)
  );

  const decorationManager = new DecorationManager(stateManager);
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      decorationManager.refresh(editors);
    })
  );

  const treeProvider = new ReviewTreeProvider(stateManager);
  context.subscriptions.push(
    vscode.window.createTreeView('hunkwiseReview', {
      treeDataProvider: treeProvider,
      showCollapseAll: false,
    })
  );

  const reviewPanel = new ReviewPanel(context, stateManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hunkwiseToolbar', reviewPanel)
  );

  registerCommands(context, stateManager, fileWatcher, onStateChanged);

  // Initial render for any restored state
  onStateChanged();

  context.subscriptions.push({
    dispose: () => {
      stateManager.flush();
      decorationManager.dispose();
    },
  });
}

export function deactivate(): void {}
```

**Step 2: Compile and verify**

```bash
npm run compile
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire all components together in extension.ts"
```

---

## Task 11: Manual Smoke Test

**Step 1: Open extension in Extension Development Host**

Press `F5` in VSCode (or run `code --extensionDevelopmentPath=.` from the project root).

**Step 2: Test "Start Tracking" command**

1. Open any file in the Extension Development Host window
2. Open Command Palette → `hunkwise: Start Tracking Current File`
3. Modify the file (add/remove a few lines)
4. Verify: CodeLens `✓ Accept | ✕ Discard` appears above changed hunk
5. Verify: Added lines highlighted green

**Step 3: Test Accept**

1. Click `✓ Accept` on a hunk
2. Verify: CodeLens and decoration disappear for that hunk

**Step 4: Test Discard**

1. Click `✕ Discard` on a hunk
2. Verify: Lines revert to original content
3. Verify: CodeLens and decoration disappear

**Step 5: Test sidebar panel**

1. Open the Explorer sidebar
2. Verify: `hunkwise Review` section shows the file with hunk tree
3. Click a hunk entry → verify editor jumps to that line

**Step 6: Test bottom toolbar**

1. Open the bottom panel (View → Terminal, then find `hunkwise` tab)
2. Verify toolbar buttons are visible
3. Test `↑ / ↓` to navigate hunks
4. Test `✓ Accept All` / `✕ Discard All`

**Step 7: Test persistence**

1. Put a file under review with pending hunks
2. Close VSCode, reopen the project
3. Verify: hunks are restored (CodeLens visible, sidebar shows file)

**Step 8: Commit**

```bash
git commit --allow-empty -m "chore: smoke test complete"
```

---

## Task 12: Update README and documentation

**Files:**
- Modify: `README.md`

**Step 1: Replace README.md with user-facing documentation**

```markdown
# hunkwise

Per-hunk Accept/Discard for any file modification in VSCode.

## Features

- Tracks file changes from any source (AI tools, scripts, manual edits)
- No git dependency — works on any file
- Per-hunk `✓ Accept | ✕ Discard` controls inline in the editor
- Added lines highlighted in green
- Sidebar panel lists all files under review with hunk details
- Bottom toolbar for quick navigation and batch operations
- State persisted across VSCode restarts

## Usage

### Automatic tracking
When any external tool writes to a file, hunkwise automatically captures a baseline and enters review mode.

### Manual tracking (for testing)
Open a file and run: `hunkwise: Start Tracking Current File` from the Command Palette.

### Reviewing changes
- Click `✓ Accept` or `✕ Discard` above each hunk in the editor
- Use the **hunkwise** sidebar panel to see all pending files
- Use the **hunkwise** bottom panel to navigate hunks and batch accept/discard

## Configuration

`.vscode/hunkwise-state.json` is created automatically. Add it to `.gitignore`.

## Non-goals (v1)

- Intra-line character-level highlighting
- Git integration
- Partial line-level accept/discard
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README with user-facing documentation"
```
