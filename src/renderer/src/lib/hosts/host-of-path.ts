import { projectsCollection } from '@renderer/lib/collections';
import { isWithin, trimSeparators } from '@renderer/lib/path-within';

/**
 * Which machine a path lives on, as the renderer sees it
 * (a private plan › 1.3, 12): the longest remote project
 * root that holds it, else null = this machine. The renderer's twin of main's
 * `hosts/host-of-path.ts` - a session's worktree and every file it opens lie
 * under its project, so the projects table is enough.
 */
export type RemoteRoot = { hostId: string; path: string };

/** The remote roots among project rows (a row without a host is local). */
export function remoteRootsOf(
  rows: Iterable<{ path: string | null; hostId?: string | null }>,
): RemoteRoot[] {
  const out: RemoteRoot[] = [];
  for (const row of rows) {
    if (row.hostId && row.path) out.push({ hostId: row.hostId, path: trimSeparators(row.path) });
  }
  return out;
}

/** The host of `path` by longest prefix over `roots`; null = local. */
export function hostOfPath(path: string | null | undefined, roots: RemoteRoot[]): string | null {
  if (!path) return null;
  let best: RemoteRoot | null = null;
  for (const root of roots) {
    if (!isWithin(path, root.path)) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  return best?.hostId ?? null;
}

/** The host of `path` now, read off the projects collection (null = local). */
export function currentHostOfPath(path: string | null | undefined): string | null {
  if (!path) return null;
  let rows: Iterable<{ path: string | null; hostId?: string | null }> = [];
  try {
    rows = projectsCollection.toArray;
  } catch {
    // No collection in this context (a bare test) - everything is local.
  }
  return hostOfPath(path, remoteRootsOf(rows));
}
