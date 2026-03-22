# hunkwise

Per-hunk Accept/Discard for any file change in VSCode.

## Features

- Tracks file changes from any source (AI tools, scripts, manual edits)
- Per-hunk `✓ Accept | ↺ Discard` controls inline in the editor
- Added lines highlighted in green, removed lines highlighted in red
- Sidebar panel lists all pending files with hunk details and batch actions
- New files and deleted files are tracked and displayed
- State persisted across VSCode restarts via a lightweight internal git repo
- Respects `.gitignore` and custom ignore patterns

## Installation

hunkwise uses a [proposed VSCode API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api) (`editorInsets`) and cannot be installed from the marketplace.

### With Claude Code (recommended)

Install the `install-hunkwise` skill, which handles compiling, packaging, and configuring VSCode automatically:

```bash
npx skills add https://github.com/molon/hunkwise --skill install-hunkwise -g -y
```

Then ask Claude Code to install it:

> install hunkwise

## Usage

### Enable hunkwise

Click **Enable** in the hunkwise sidebar panel. hunkwise will snapshot all current workspace files as baselines.

### Automatic tracking

Once enabled, any external tool (AI assistant, script, etc.) that writes to a file will automatically trigger review mode for that file.

### Reviewing changes

- Click `✓` or `↺` above each hunk in the editor
- Use the **hunkwise** sidebar panel to:
  - See all files with pending changes
  - Accept or discard individual hunks
  - Accept or discard all changes in a file
  - Accept or discard all changes across all files
- Click a file name in the panel to open it
- Deleted files show a diff view with the original content

### Disable hunkwise

Click **Disable** in the panel. All tracked state is cleared.

## Commands

| Command | Description |
| ------- | ----------- |
| `hunkwise: Enable` | Enable hunkwise and snapshot the workspace |
| `hunkwise: Disable` | Disable hunkwise and clear all state |
| `hunkwise: Settings` | Open the settings panel |

## Settings

Settings are stored in `.vscode/hunkwise/settings.json` and can be changed via the settings panel:

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `ignorePatterns` | `[".git"]` | Glob patterns to exclude from tracking |
| `respectGitignore` | `true` | Whether to honor `.gitignore` rules |

## .gitignore

When enabled, hunkwise automatically adds `.vscode/hunkwise/` to your `.gitignore`.

## Development

```bash
npm run compile   # compile TypeScript
npm run watch     # watch mode
npm test          # run unit tests
```

Tests cover `diffEngine`, `hunkwiseGit`, and `gitignoreManager`. They run with Node's built-in test runner (`node:test`) and require no additional dependencies.
