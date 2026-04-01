/**
 * Normalize a filesystem path for consistent Map/Set key usage.
 *
 * On macOS, `fs.readdir` preserves the original Unicode form of filenames.
 * Files created with NFD characters (e.g. が = か + ◌゙) are returned as NFD.
 * However, `git ls-tree` (with core.precomposeUnicode=true, the macOS default)
 * always outputs NFC paths. This causes Set/Map key mismatches when comparing
 * paths from git with paths from the filesystem. On macOS APFS, the filesystem
 * is normalization-insensitive, so opening a file with an NFC path works even
 * if the file was created with NFD.
 *
 * On Linux (and other non-macOS platforms), NFC and NFD can be distinct
 * filenames on normalization-sensitive filesystems. Normalizing unconditionally
 * would conflate different paths into the same Map/Set key, so this function
 * is a no-op on non-macOS platforms.
 */
export function normalizePath(p: string): string {
  // Only normalize on macOS where APFS is normalization-insensitive and
  // git (core.precomposeUnicode=true) outputs NFC while fs.readdir may
  // return NFD. On Linux, NFC and NFD can be distinct filenames —
  // normalizing unconditionally would conflate different paths.
  if (process.platform === 'darwin') {
    return p.normalize('NFC');
  }
  return p;
}
