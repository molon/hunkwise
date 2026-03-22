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

### Step 4: Detect installed VSCode builds and install the .vsix

First, detect which VSCode builds are installed, then install into **all** of them.

**Known CLI paths by platform:**

| Platform | Build | CLI path |
|----------|-------|----------|
| macOS | Stable | `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code` |
| macOS | Insiders | `/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code` |
| Windows | Stable | `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd` |
| Windows | Insiders | `%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd` |
| Linux | Stable | `code` (in PATH) |
| Linux | Insiders | `code-insiders` (in PATH) |

**macOS/Linux — detect and install into all present builds:**

```bash
VSIX=$(ls -t hunkwise-*.vsix | head -1)
for CLI in \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
  "$(command -v code 2>/dev/null)" \
  "$(command -v code-insiders 2>/dev/null)"; do
  [ -x "$CLI" ] && "$CLI" --install-extension "$VSIX" --force
done
```

**Windows — detect and install into all present builds:**

```bat
set VSIX=hunkwise-0.0.1.vsix
set STABLE=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd
set INSIDERS=%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd
if exist "%STABLE%" "%STABLE%" --install-extension %VSIX% --force
if exist "%INSIDERS%" "%INSIDERS%" --install-extension %VSIX% --force
```

Replace `hunkwise-0.0.1.vsix` with the actual filename produced by vsce.

### Step 5: Configure proposed API (one-time setup per build)

Because hunkwise uses a proposed API, each installed VSCode build must be told to enable it via its own `argv.json` in the **user config directory**. Apply to every build detected in Step 4 — skip any build where `"molon.hunkwise"` is already present.

**`argv.json` locations (same builds as Step 4):**

| Platform | Build | Path |
|----------|-------|------|
| macOS/Linux | Stable | `~/.vscode/argv.json` |
| macOS/Linux | Insiders | `~/.vscode-insiders/argv.json` |
| Windows | Stable | `%USERPROFILE%\.vscode\argv.json` |
| Windows | Insiders | `%USERPROFILE%\.vscode-insiders\argv.json` |

For each relevant `argv.json`: read the existing file, then add or merge `"enable-proposed-api"` — do not overwrite other fields:

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
