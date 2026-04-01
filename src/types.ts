export type FileStatus = 'idle' | 'reviewing';

export interface FileState {
  status: FileStatus;
  /** null = file did not exist before (new file); '' = file existed but was empty; string = file content */
  baseline: string | null;
}
