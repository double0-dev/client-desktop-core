import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The daemon's log file writer (a private plan): one line
 * per attach / detach / failure, appended synchronously - the daemon has no
 * stdio, this is the only trace it leaves. Capped: past `maxBytes` the file
 * is rotated to `<path>.1` (replacing the previous one) and writing goes on
 * in a fresh file, so a daemon that lives for months, or one stuck in a
 * reconnect loop, never fills the disk. Pure node; daemon-main.ts wires it.
 */
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

export type DaemonLog = (message: string) => void;

export function createDaemonLog(
  path: string | null,
  opts: { maxBytes?: number; now?: () => Date } = {},
): DaemonLog {
  if (!path) return () => {};
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const now = opts.now ?? (() => new Date());
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Unwritable - every append below fails quietly too.
  }
  const sizeNow = (): number => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };
  return (message) => {
    const line = `${now().toISOString()} [${process.pid}] ${message}\n`;
    // Read the size each time rather than counting: two daemons of one build
    // can append to the same file, and a rotation by one was invisible to the
    // other's counter (review, 2026-10-06). Lines are rare - a stat is cheap.
    const bytes = sizeNow();
    if (bytes > 0 && bytes + Buffer.byteLength(line) > maxBytes) {
      try {
        renameSync(path, `${path}.1`);
      } catch {
        // Cannot rotate: keep appending rather than lose the line.
      }
    }
    try {
      appendFileSync(path, line);
    } catch {
      // Best effort.
    }
  };
}
