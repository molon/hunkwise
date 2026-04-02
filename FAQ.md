# FAQ

## Why doesn't a file dragged from Finder always show as "New"?

When you drag a file from Finder into the VSCode explorer, VSCode may auto-open (preview) the file. If the file is opened before hunkwise processes the create event, the editor buffer matches the disk content, causing hunkwise to treat it as a user-created file (silently snapshotted as baseline) instead of an external new file.

This is a known timing-dependent behavior. There is no reliable VSCode API to distinguish "user created a new file in the editor" from "user dragged an external file into the explorer" — `onWillCreateFiles` fires for both.

When this happens, the file is silently snapshotted as a baseline in hunkwise git (content matches disk), so it won't appear as "New" even after clicking refresh. There is currently no automatic workaround — the file is treated as if it was always part of the project.

## Extension doesn't work on VS Code stable (Linux)

hunkwise relies on the proposed `editorInsets` API. On macOS and Windows, this API works in VS Code stable builds when `argv.json` is configured with `"enable-proposed-api": ["molon.hunkwise"]`.

However, on some Linux distributions (e.g. CachyOS), the proposed API may not be available in the stable build. If hunkwise fails to activate on your Linux system, try switching to [VS Code Insiders](https://code.visualstudio.com/insiders/).

See [issue #20](https://github.com/molon/hunkwise/issues/20) for details. If you can help investigate or fix this, PRs are welcome!
