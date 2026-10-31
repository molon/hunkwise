import { spawn } from 'child_process';

/**
 * Safety valve for pathological repositories: the parsed baselines are held as
 * strings until the caller consumes them, so an absurd payload aborts the read and
 * falls back to per-file calls instead of exhausting the extension host.
 */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

const LF = 10;

export interface BatchReadOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBytes?: number;
}

/**
 * Read the git index entries for `relPaths` through a single `git cat-file --batch`
 * child process.
 *
 * Returns one entry per input path in input order, `undefined` where git reports the
 * path as missing. Returns `undefined` for the whole call when the stream cannot be
 * trusted (spawn failure, non-zero exit, truncated or desynchronised output, size
 * guard tripped) — callers fall back to per-file reads in that case.
 *
 * The stream is parsed incrementally: only one entry is buffered at a time, so the
 * peak cost is the parsed results themselves rather than a second copy of the output.
 */
export function readIndexBlobs(
  relPaths: string[],
  options: BatchReadOptions,
): Promise<(string | undefined)[] | undefined> {
  if (relPaths.length === 0) return Promise.resolve([]);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise(resolve => {
    let settled = false;
    const finish = (value: (string | undefined)[] | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['-c', 'core.quotepath=false', 'cat-file', '--batch'], {
        cwd: options.cwd,
        env: options.env,
      });
    } catch {
      finish(undefined);
      return;
    }

    // One entry at a time: 'header' → 'body' → 'lf'
    let state: 'header' | 'body' | 'lf' = 'header';
    let headerParts: Buffer[] = [];
    let bodyParts: Buffer[] = [];
    let remaining = 0;
    let total = 0;
    const results: (string | undefined)[] = [];

    const consume = (chunk: Buffer) => {
      let pos = 0;
      while (pos < chunk.length && results.length < relPaths.length) {
        if (state === 'header') {
          const nl = chunk.indexOf(LF, pos);
          if (nl === -1) {
            headerParts.push(chunk.subarray(pos));
            return;
          }
          headerParts.push(chunk.subarray(pos, nl));
          const header = Buffer.concat(headerParts).toString('utf8');
          headerParts = [];
          pos = nl + 1;

          // "<oid> <type> <size>" for a hit, "<name> missing"/"<name> ambiguous" otherwise
          const fields = header.split(' ');
          const size = Number(fields[2]);
          if (fields.length === 3 && Number.isFinite(size) && size >= 0) {
            remaining = size;
            bodyParts = [];
            state = 'body';
          } else {
            results.push(undefined);
          }
          continue;
        }

        if (state === 'body') {
          if (remaining === 0) {
            state = 'lf';
            continue;
          }
          const take = Math.min(remaining, chunk.length - pos);
          bodyParts.push(chunk.subarray(pos, pos + take));
          pos += take;
          remaining -= take;
          continue;
        }

        // 'lf': the single newline git writes after the content
        pos += 1;
        results.push(Buffer.concat(bodyParts).toString('utf8'));
        bodyParts = [];
        state = 'header';
      }
    };

    child.stdout!.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        child.kill();
        finish(undefined);
        return;
      }
      consume(chunk);
    });
    // Drain stderr: an unread pipe would block the child
    child.stderr!.on('data', () => {});
    // The child may exit before we finish writing (e.g. destroyed repo)
    child.stdin!.on('error', () => {});
    child.on('error', () => finish(undefined));
    child.on('close', code => {
      if (code !== 0 || state !== 'header' || results.length !== relPaths.length) {
        finish(undefined);
        return;
      }
      finish(results);
    });

    for (const rel of relPaths) {
      child.stdin!.write(`:${rel}\n`);
    }
    child.stdin!.end();
  });
}
