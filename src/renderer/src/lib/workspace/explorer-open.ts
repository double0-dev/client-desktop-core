/**
 * Which workspaces have the file explorer open - remembered per session, so
 * opening it in one session leaves every other session (and project) as it
 * was. Persisted as a JSON array of workspace keys under
 * `double0-workspace-explorer-sessions`: a session id, or `project:<id>` for a
 * project's session-less workspace. Machine-local session memory, like the
 * last-viewed session per project - not a setting that travels or resets.
 */
export const EXPLORER_SESSIONS_KEY = 'double0-workspace-explorer-sessions';

/** Entries kept at most - the oldest opened fall off first. */
export const MAX_EXPLORER_ENTRIES = 200;

/** The key a workspace's explorer state is stored under. */
export function explorerKey(sessionId: string | null, projectId: string | null): string | null {
  if (sessionId) return sessionId;
  return projectId ? `project:${projectId}` : null;
}

/** Stored string → the open set; corrupt or absent → nothing open. */
export function decodeExplorerOpen(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * The open set with `key` opened or closed. Returns `open` itself when nothing
 * changes, so a React state setter skips the render and the write. A newly
 * opened key goes to the end; past the cap the oldest entries are dropped.
 */
export function setExplorerOpenFor(open: string[], key: string, value: boolean): string[] {
  const has = open.includes(key);
  if (has === value) return open;
  if (!value) return open.filter((k) => k !== key);
  const next = [...open, key];
  return next.length > MAX_EXPLORER_ENTRIES ? next.slice(next.length - MAX_EXPLORER_ENTRIES) : next;
}

/**
 * The open set without the sessions that no longer exist. Project keys are
 * kept - a project's session-less view is only ever reached through a live
 * project. Returns `open` itself when nothing was dropped.
 */
export function pruneExplorerOpen(open: string[], liveSessionIds: ReadonlySet<string>): string[] {
  const next = open.filter((k) => k.startsWith('project:') || liveSessionIds.has(k));
  return next.length === open.length ? open : next;
}
