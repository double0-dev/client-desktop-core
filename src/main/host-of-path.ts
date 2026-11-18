import { isWithin } from './path-within';

/**
 * Which machine a path belongs to (a private plan ›
 * 1.3). Pure. Main keeps the remote project roots `{ hostId, path }` (read
 * from the projects table, re-read on every projects change); a path under
 * one of them is that host's, by the longest root that contains it - a
 * session's worktree and root always lie under its project - else it is
 * this machine's (null).
 *
 * A remote and a local path can be the same string (`/home/emmaw/acme` on
 * the laptop and on build-box). The resolver answers by the remote roots,
 * so the one ambiguity left - a LOCAL project under a remote root - is
 * refused when it is added (`localProjectConflict`).
 */
export type HostRoot = { hostId: string; path: string; projectId?: string; projectName?: string };

export function hostOfPath(
  path: string | null | undefined,
  roots: readonly HostRoot[],
): string | null {
  if (!path) return null;
  let best: HostRoot | null = null;
  for (const root of roots) {
    if (!root.path || !isWithin(path, root.path)) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  return best ? best.hostId : null;
}

/** The remote project roots among project rows (`hostId` set, a path). */
export function hostRootsOf(
  rows: readonly {
    id: string;
    name?: string | null;
    path: string | null;
    hostId?: string | null;
  }[],
): HostRoot[] {
  const out: HostRoot[] = [];
  for (const row of rows) {
    if (!row.hostId || !row.path) continue;
    out.push({
      hostId: row.hostId,
      path: row.path,
      projectId: row.id,
      ...(row.name ? { projectName: row.name } : {}),
    });
  }
  return out;
}

/**
 * Why a project can't be added at `path` on `hostId` (null = this machine),
 * or null when it can: a folder that already belongs to a project on a
 * DIFFERENT machine at the same path string - a local project under (or
 * over) a remote root, or the reverse - would make every path-keyed call
 * ambiguous.
 */
export function projectPathConflict(
  path: string,
  hostId: string | null,
  projects: readonly { name: string; path: string | null; hostId?: string | null }[],
  hostLabel: (hostId: string) => string,
): string | null {
  for (const p of projects) {
    if (!p.path) continue;
    const other = p.hostId ?? null;
    if (other === hostId) continue;
    if (!isWithin(path, p.path) && !isWithin(p.path, path)) continue;
    const where = other ? `${hostLabel(other)}'s` : "this machine's";
    return `That folder belongs to ${where} project ${p.name}`;
  }
  return null;
}
