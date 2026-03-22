---
name: install-hunkwise
description: Install the hunkwise VSCode extension from source. Use this skill whenever the user asks to install, build, package, or reinstall hunkwise, or when they want to load the latest changes into VSCode.
disable-model-invocation: true
---

# Install hunkwise

hunkwise is a VSCode extension that uses a proposed (private) API — `editorInsets` — so it cannot be installed from the marketplace and requires a special setup.

## Prerequisites

- Node.js (>=18) and npm available
- git available
- `code` CLI resolvable (see Step 3 for platform-specific paths)

## Steps

### Step 1: Clone the repository

Clone into a uniquely named temp directory to avoid conflicts:

```bash
HUNKWISE_TMP=$(mktemp -d /tmp/hunkwise-XXXXXX)
git clone https://github.com/molon/hunkwise.git "$HUNKWISE_TMP"
cd "$HUNKWISE_TMP"
```

On Windows, use a timestamp-based name:

```bat
set HUNKWISE_TMP=%TEMP%\hunkwise-%DATE:~-4%%DATE:~3,2%%DATE:~0,2%-%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%
git clone https://github.com/molon/hunkwise.git %HUNKWISE_TMP%
cd %HUNKWISE_TMP%
```

Remember the directory path — you'll need it for cleanup in Step 6.

### Step 2: Install dependencies and compile

```bash
npm install
npm run compile
```

If compilation fails, stop and surface the TypeScript errors to the user.

### Step 3: Package with vsce

```bash
npx @vscode/vsce package --allow-missing-repository
```

This produces `hunkwise-<version>.vsix` in the project root. Do NOT use `--no-dependencies` — runtime dependencies (`ignore`, `diff`) must be bundled.

### Step 4: Install the .vsix

Find the `code` CLI for the installed VSCode build and run:

```bash
<code-cli> --install-extension hunkwise-*.vsix --force
```

If multiple `.vsix` files exist, use the most recently modified one.

**Locating the `code` CLI by platform and build:**

| Platform | Build | CLI path |
|----------|-------|----------|
| macOS | Stable | `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code` |
| macOS | Insiders | `/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code` |
| Windows | Stable | `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd` |
| Windows | Insiders | `%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd` |
| Linux | either | `code` or `code-insiders` (usually in PATH) |

If unsure which build the user has, check what's installed or ask.

### Step 5: Configure proposed API (one-time setup)

Because hunkwise uses a proposed API, VSCode must be told to enable it via `argv.json` in the **user config directory** (not the app data directory). This is a one-time setup — skip if `"molon.hunkwise"` is already present.

**`argv.json` locations:**

| Platform | Build | Path |
|----------|-------|------|
| macOS | Stable | `~/.vscode/argv.json` |
| macOS | Insiders | `~/.vscode-insiders/argv.json` |
| Windows | Stable | `%USERPROFILE%\.vscode\argv.json` |
| Windows | Insiders | `%USERPROFILE%\.vscode-insiders\argv.json` |
| Linux | Stable | `~/.vscode/argv.json` |
| Linux | Insiders | `~/.vscode-insiders/argv.json` |

Read the existing file, then add or merge the key — do not overwrite other fields:

```json
{
  "enable-proposed-api": ["molon.hunkwise"]
}
```

If the key already exists with other values, append `"molon.hunkwise"` rather than replacing the array.

### Step 6: Clean up

Delete the cloned directory:

```bash
rm -rf "$HUNKWISE_TMP"
```

On Windows: `rmdir /s /q %HUNKWISE_TMP%`

### Step 7: Restart VSCode

Tell the user to **fully quit and reopen VSCode** (not just close the window) for the extension and proposed API setting to take effect.

## Notes

- The `enabledApiProposals: ["editorInsets"]` field in `package.json` enables `vscode.window.createWebviewTextEditorInset`, used to embed per-hunk Accept/Discard buttons inline in the editor. Without this, the buttons will not appear.
- Settings are stored in `.vscode/hunkwise/settings.json` within the workspace, not in VSCode global settings.
- If the extension fails to activate, check the exthost log:
  - macOS: `~/Library/Application Support/Code[-Insiders]/logs/<timestamp>/window1/exthost/exthost.log`
  - Windows: `%APPDATA%\Code[-Insiders]\logs\<timestamp>\window1\exthost\exthost.log`
