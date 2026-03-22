---
name: install-hunkwise
description: Install the hunkwise VSCode extension from source. Use this skill whenever the user asks to install, build, package, or reinstall hunkwise, or when they want to load the latest changes into VSCode.
disable-model-invocation: true
---

# Install hunkwise

hunkwise is a VSCode extension that uses a proposed (private) API — `editorInsets` — so it cannot be installed from the marketplace and requires a special setup.

## Prerequisites

- Node.js and npm available
- `code` CLI available in PATH (VSCode Insiders: use the full path `/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code`)
- Working directory: the hunkwise project root
- **One-time setup:** `~/.vscode-insiders/argv.json` must contain `"enable-proposed-api": ["molon.hunkwise"]` (already configured)

## Steps

### Step 1: Compile

```bash
npm run compile
```

If compilation fails, stop and surface the TypeScript errors to the user.

### Step 2: Package with vsce

```bash
npx @vscode/vsce package --allow-missing-repository
```

This produces `hunkwise-<version>.vsix` in the project root. Do NOT use `--no-dependencies` — runtime dependencies (`ignore`, `diff`) must be bundled.

### Step 3: Install the .vsix

```bash
"/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" --install-extension hunkwise-*.vsix --force
```

If multiple `.vsix` files exist, use the most recently modified one.

### Step 4: Restart VSCode

Tell the user to **fully quit and reopen VSCode Insiders** (Cmd+Q, not just close window) for the new extension to take effect.

## Notes

- The `enabledApiProposals: ["editorInsets"]` field is declared in `package.json`. This proposed API provides `vscode.window.createWebviewTextEditorInset`, used to embed per-hunk Accept/Discard buttons inline in the editor.
- Without the proposed API enabled, the inline Accept/Discard buttons will not appear (the rest of the extension may still load but the core feature won't work).
- Settings are stored in `.vscode/hunkwise/settings.json` within the workspace, not in VSCode global settings.
- If the extension fails to activate, check the exthost log: `~/Library/Application Support/Code - Insiders/logs/<latest>/window1/exthost/exthost.log`
