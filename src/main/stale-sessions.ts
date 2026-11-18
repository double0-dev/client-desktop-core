import { sessionShellPrefix } from './session-shells';
/**
 * The crash-recovery sweep's selection (a private plan):
 * which sessions the database still calls busy although no terminal of
 * theirs is alive. Pure - crash-recovery.ts reads the rows and writes the
 * resets.
 *
 * A session's terminals are the pty ids of its persisted layout's tabs, its
 * eager shells (`conversation:<id>`, `setup:<id>`) and its shells outside
 * the layout (`sessionShellPrefix`). With the daemon, a busy session normally finds
 * at least one of them live after a restart and keeps its status - the
 * renderer settles it from the real state. Only one whose terminals are all
 * gone (a crash before the daemon, a daemon that died, the pre-daemon quit)
 * is stuck: nothing will ever report it idle.
 *
 * Runtime sessions (`runtime` set) are left out: their main tab has no pty,
 * and the extension settles them from its own agents - resetting
 * them here first would hide the "finished while you were away" change
 * (review, 2026-10-06).
 */
export const BUSY_STATUSES = new Set(['active', 'needs-input']);

export type SessionRow = {
  id: string;
  status: string;
  runtime?: string | null;
  projectId?: string | null;
};

/**
 * Which machine's sweep this is (a private plan › 15):
 * only the sessions of projects on `hostId` (null = this machine) are judged.
 * A remote host's terminals are listed by that host's daemon alone, so the
 * local sweep at boot must never reset a remote session whose host has not
 * answered yet - its statuses stand until it does.
 */
export type HostFilter = {
  hostId: string | null;
  /** A project's host, null = this machine (the projects table's `hostId`). */
  hostOfProject: (projectId: string) => string | null;
};
export type LayoutRow = { sessionId: string; layout: unknown };

/** The pty ids a persisted layout names (renderer shape: `{ tabs: { [tabId]: { ptyId } } }`). */
export function layoutPtyIds(layout: unknown): string[] {
  if (typeof layout !== 'object' || layout === null) return [];
  const tabs = (layout as { tabs?: unknown }).tabs;
  if (typeof tabs !== 'object' || tabs === null) return [];
  const out: string[] = [];
  for (const tab of Object.values(tabs as Record<string, unknown>)) {
    const ptyId = (tab as { ptyId?: unknown } | null)?.ptyId;
    if (typeof ptyId === 'string' && ptyId.length > 0) out.push(ptyId);
  }
  return out;
}

/** Busy sessions none of whose terminals is in `liveTerminalIds` (on the filter's host). */
export function staleBusySessionIds(
  sessions: SessionRow[],
  layouts: LayoutRow[],
  liveTerminalIds: Iterable<string>,
  host?: HostFilter,
): string[] {
  const live = new Set(liveTerminalIds);
  const layoutOf = new Map<string, unknown>();
  for (const row of layouts) layoutOf.set(row.sessionId, row.layout);
  const stale: string[] = [];
  for (const session of sessions) {
    if (!BUSY_STATUSES.has(session.status) || session.runtime != null) continue;
    if (host) {
      const own = session.projectId ? host.hostOfProject(session.projectId) : null;
      if (own !== host.hostId) continue;
    }
    const own = [
      ...layoutPtyIds(layoutOf.get(session.id)),
      `conversation:${session.id}`,
      `setup:${session.id}`,
    ];
    const shellPrefix = sessionShellPrefix(session.id);
    let alive = own.some((id) => live.has(id));
    if (!alive) for (const id of live) if (id.startsWith(shellPrefix)) alive = true;
    if (!alive) stale.push(session.id);
  }
  return stale;
}
