export type FileStatus = 'idle' | 'reviewing';

export interface FileState {
  status: FileStatus;
  baseline: string;
}
