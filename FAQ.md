# FAQ

## Why doesn't a file dragged from Finder always show as "New"?

When you drag a file from Finder into the VSCode explorer, VSCode may auto-open (preview) the file. If the file is opened before hunkwise processes the create event, the editor buffer matches the disk content, causing hunkwise to treat it as a user-created file (silently snapshotted as baseline) instead of an external new file.

This is a known timing-dependent behavior. There is no reliable VSCode API to distinguish "user created a new file in the editor" from "user dragged an external file into the explorer" — `onWillCreateFiles` fires for both.

**Workaround:** Click the refresh button in the hunkwise panel. The file will be detected as untracked (not in hunkwise git) and re-appear as a new file for review.
