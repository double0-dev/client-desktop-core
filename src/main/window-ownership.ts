/**
 * Which window owns what (a private plan): the pure half of
 * main's window registry, kept out of index.ts so it can be unit-tested
 * without Electron.
 *
 * Four kinds of window. The main window (created without a payload) hosts
 * every project and session nobody else does. A project window hosts ONE
 * project: all of its sessions, except the ones torn off into a session window
 * of their own. A session window hosts one session; a tab window hosts loose
 * terminals and owns no session. Ownership is never guessed renderer-side -
 * each window asks main what is "external to me" (`externalFor`) and mounts
 * nothing it does not own, so two windows can never adopt one shell.
 */

export type WindowRecord =
  | { kind: 'main' }
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; sessionId: string; projectId: string | null }
  | { kind: 'tab' };

/** Live windows by webContents id. Main keeps it current in createWindow / closed. */
export type WindowTable = ReadonlyMap<number, WindowRecord>;

/** What a window must treat as living elsewhere. */
export type ExternalWindows = {
  /** Sessions hosted by a session window (other than the asking window's own). */
  sessionIds: string[];
  /** Projects hosted by a project window other than the asking window. */
  projectIds: string[];
};

export function mainWindowId(table: WindowTable): number | null {
  for (const [wcId, record] of table) if (record.kind === 'main') return wcId;
  return null;
}

export function projectWindowId(table: WindowTable, projectId: string): number | null {
  for (const [wcId, record] of table) {
    if (record.kind === 'project' && record.projectId === projectId) return wcId;
  }
  return null;
}

/**
 * The windows that may show a session, most likely first: its own window,
 * then every project window, then the main window (an extension asks them in
 * turn for an agent that has no terminal to follow).
 */
export function sessionWindowsInOrder(table: WindowTable, sessionId: string): number[] {
  const own = sessionWindowId(table, sessionId);
  const projects = [...table].filter(([, r]) => r.kind === 'project').map(([id]) => id);
  const main = mainWindowId(table);
  return [own, ...projects, main].filter(
    (id, i, all): id is number => id !== null && all.indexOf(id) === i,
  );
}

export function sessionWindowId(table: WindowTable, sessionId: string): number | null {
  for (const [wcId, record] of table) {
    if (record.kind === 'session' && record.sessionId === sessionId) return wcId;
  }
  return null;
}

/**
 * The sessions and projects window `wcId` must not mount: every torn-off
 * session (its own excluded) and every project in another project window. The
 * renderer expands the project list to that project's sessions itself - main
 * never needs to know which session belongs to which project for this.
 */
export function externalFor(table: WindowTable, wcId: number): ExternalWindows {
  const sessionIds: string[] = [];
  const projectIds: string[] = [];
  for (const [id, record] of table) {
    if (id === wcId) continue;
    if (record.kind === 'session') sessionIds.push(record.sessionId);
    else if (record.kind === 'project') projectIds.push(record.projectId);
  }
  return { sessionIds, projectIds };
}

/**
 * Where a closing session window hands its session: the window hosting the
 * session's project if there is one (a session torn off from a project window
 * goes back there), else the main window; null when neither exists (the
 * shells then die with the window, as before project windows).
 */
export function sessionReturnTarget(table: WindowTable, projectId: string | null): number | null {
  if (projectId != null) {
    const projectWin = projectWindowId(table, projectId);
    if (projectWin != null) return projectWin;
  }
  return mainWindowId(table);
}

/** Where a closing project window hands its project: always the main window. */
export function projectReturnTarget(table: WindowTable): number | null {
  return mainWindowId(table);
}

/**
 * Whether `senderWcId` may bring back or destroy the window hosting
 * `sessionId`: the session's own window, the main window, or the project
 * window hosting the session's project (its sidebar lists the session and
 * offers the same menu the main window does).
 */
export function maySettleSession(
  table: WindowTable,
  senderWcId: number,
  sessionId: string,
): boolean {
  const own = sessionWindowId(table, sessionId);
  if (own == null) return false;
  if (senderWcId === own) return true;
  const sender = table.get(senderWcId);
  if (!sender) return false;
  if (sender.kind === 'main') return true;
  const hosted = table.get(own);
  return (
    sender.kind === 'project' &&
    hosted?.kind === 'session' &&
    hosted.projectId != null &&
    hosted.projectId === sender.projectId
  );
}

/** Whether `senderWcId` may bring back or destroy the window hosting `projectId`. */
export function maySettleProject(
  table: WindowTable,
  senderWcId: number,
  projectId: string,
): boolean {
  const own = projectWindowId(table, projectId);
  if (own == null) return false;
  if (senderWcId === own) return true;
  return table.get(senderWcId)?.kind === 'main';
}

/**
 * The session-cleanup sweep (auto-archive + auto-delete, which removes
 * worktrees) runs in exactly one window: the lease belongs to the main window
 * and nothing else is ever granted it. Two full-chrome windows sweeping at
 * once would both delete the same worktree.
 */
export function holdsSweepLease(table: WindowTable, wcId: number): boolean {
  return table.get(wcId)?.kind === 'main';
}
