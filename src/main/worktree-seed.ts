import { isAbsolute } from 'node:path';
import { buildOutputOf } from './build-output';

/**
 * Pure rules for seeding a fresh git worktree with a project's ignored files
 * (Settings → Worktrees → project). `git.ts` does the listing and copying;
 * this decides which ignored paths may never be copied and which requested
 * paths are safe to copy at all. Kept free of Electron/fs imports so it stays
 * unit-testable.
 */

/** Ignored folders the app never copies, with the reason shown in the list. */
export const LOCKED_IGNORED: readonly { prefix: string; reason: string }[] = [
  // Holds every worktree of the repo - copying it would nest checkouts.
  { prefix: '.worktree/', reason: 'never copied' },
  // The app's own per-checkout folder (task images); each session gets its own.
  { prefix: '.double0/', reason: 'app folder' },
];

/** Why `path` (repo-relative, folders with a trailing slash) can't be copied, or null. */
export function lockedReason(path: string): string | null {
  const dir = path.endsWith('/') ? path : `${path}/`;
  for (const { prefix, reason } of LOCKED_IGNORED) {
    if (dir === prefix || dir.startsWith(prefix)) return reason;
  }
  return null;
}

/**
 * Split a requested copy list into the paths safe to copy from one checkout
 * into another and the ones refused. Safe = a non-empty repo-relative path that
 * stays inside the root (no `..` segment, not absolute, not the git dir) and
 * isn't locked. Non-strings are dropped, duplicates collapsed, order kept.
 */
export function partitionSeedPaths(paths: unknown): { paths: string[]; rejected: string[] } {
  const ok: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(paths) ? paths : []) {
    if (typeof raw !== 'string') continue;
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const segments = path.split(/[\\/]/);
    const escapes =
      isAbsolute(path) ||
      /^[a-zA-Z]:/.test(path) ||
      segments.includes('..') ||
      segments[0] === '.git';
    if (escapes || lockedReason(path)) rejected.push(path);
    else ok.push(path);
  }
  return { paths: ok, rejected };
}

export { BUILD_OUTPUT, buildOutputOf, crossPlatform } from './build-output';

/**
 * Split the paths a user ticked to copy from THIS computer's checkout into a
 * worktree on a host (plan 29 spec › 9.2): `partitionSeedPaths`' rules, plus
 * build output refused when the two machines differ (`crossOs`) - it was
 * built for this computer's OS and would not run there. Refused paths carry
 * the reason the result names.
 */
export function partitionLocalSeedPaths(
  paths: unknown,
  opts: { crossOs: boolean },
): { paths: string[]; rejected: { path: string; reason: string }[] } {
  const base = partitionSeedPaths(paths);
  const ok: string[] = [];
  const rejected = base.rejected.map((path) => ({
    path,
    reason: lockedReason(path) ?? 'outside the checkout',
  }));
  for (const path of base.paths) {
    const output = opts.crossOs ? buildOutputOf(path) : null;
    if (output) rejected.push({ path, reason: `${output} is built for this computer's OS` });
    else ok.push(path);
  }
  return { paths: ok, rejected };
}
