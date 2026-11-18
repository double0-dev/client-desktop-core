/**
 * Where the agent hook files, shims and plugin are written (launch-materialize.ts).
 *
 * macOS gives every user a `TMPDIR` of their own, and Windows a per-user
 * temp folder. Linux's `/tmp` is shared: a fixed `/tmp/double0-…` path could
 * be created first by another local user, who could then swap the shims
 * double0 puts on a terminal's PATH (review, 2026-10-06). There the files go
 * into `/tmp/double0-<uid>`, created 0700 and refused unless it is a real
 * directory this user owns that nobody else can enter.
 */
import { lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Whether `dir` is a private directory of user `uid` (created if missing). */
export function ensurePrivateDir(dir: string, uid: number): boolean {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** The folder for the agent files, or null when no safe one exists. */
export function agentFilesRoot(
  platform: NodeJS.Platform = process.platform,
  base: string = tmpdir(),
): string | null {
  if (typeof process.getuid !== 'function') return base;
  // A Mac's TMPDIR is the user's own - unless nothing set it: a remote
  // daemon on a Mac host is started over ssh, and a session there may have
  // no TMPDIR, so node falls back to the shared `/tmp` (M3). Then it is
  // Linux's case.
  const sharedTmp = platform === 'linux' || (platform === 'darwin' && isSharedTmp(base));
  if (!sharedTmp) return base;
  const uid = process.getuid();
  const dir = join(base, `double0-${uid}`);
  return ensurePrivateDir(dir, uid) ? dir : null;
}

/** `/tmp` (or macOS's real `/private/tmp`), with or without a trailing slash. */
export function isSharedTmp(dir: string): boolean {
  const d = dir.replace(/\/+$/, '');
  return d === '/tmp' || d === '/private/tmp' || d === '/var/tmp' || d === '/private/var/tmp';
}
