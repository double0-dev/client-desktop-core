/**
 * Where the user last was, persisted to localStorage: the last-viewed session
 * per project, plus the last project itself. The workspace host records both as
 * it shows a workspace; the rail's project switcher (and the session-less view's
 * auto-swap) read the session back, so returning to a project lands on the one
 * the user left it on instead of always its top session, and app startup reads
 * both to reopen that workspace (see lib/startup-target.ts). Callers fall back
 * to the top project/session when the remembered one is gone, so a stale entry
 * is harmless.
 */
const STORAGE_KEY = 'double0-last-project-session';
const LAST_PROJECT_KEY = 'double0-last-project';

function readMap(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '');
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
  } catch {
    // Missing or corrupt entry - every project just opens on its top session.
    return {};
  }
}

/** Record `sessionId` as the last one viewed in its project. */
export function rememberProjectSession(projectId: string, sessionId: string): void {
  const map = readMap();
  if (map[projectId] === sessionId) return;
  map[projectId] = sessionId;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures - the choice just won't persist.
  }
}

/** The last session viewed in `projectId`, or null if none was recorded. */
export function lastProjectSession(projectId: string): string | null {
  return readMap()[projectId] ?? null;
}

/** Record `projectId` as the project whose workspace is on screen. */
export function rememberLastProject(projectId: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // Ignore storage failures - the app just opens on the top project next time.
  }
}

/** The project whose workspace was open last, or null if none was recorded. */
export function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}
