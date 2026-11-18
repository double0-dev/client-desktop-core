import { agentSessionsCollection } from '@renderer/lib/collections';

/**
 * Whether the user is looking at a session - the one fact behind two
 * behaviours: an alert is skipped for the session already on screen (see
 * the extension's alerts), and a session that stopped while the user was away
 * is marked 'finished' until they open it, when it reads as plain 'idle'
 * again (`markSessionSeen`). "On screen" is per window: each window shows at
 * most one session, and only a focused window counts as being looked at.
 */

/** The session on screen in THIS window (null = none, e.g. a project's session-less view). */
let focusedSessionId: string | null = null;
let windowFocusWired = false;

/**
 * Record which session this window shows. Opening a finished session counts
 * as seeing it; so does coming back to a focused window that shows one, hence
 * the window focus listener (wired once, on first use).
 */
export function setFocusedSession(sessionId: string | null): void {
  focusedSessionId = sessionId;
  if (!windowFocusWired && typeof window !== 'undefined') {
    windowFocusWired = true;
    window.addEventListener('focus', () => {
      if (focusedSessionId) markSessionSeen(focusedSessionId);
    });
  }
  if (sessionId) markSessionSeen(sessionId);
}

export function getFocusedSession(): string | null {
  return focusedSessionId;
}

/** On screen in this window, and the window has focus - the user sees it. */
export function isSessionWatched(sessionId: string): boolean {
  return focusedSessionId === sessionId && document.hasFocus();
}

/**
 * The user has looked at a session: a 'finished' (stopped while away) mark
 * drops back to 'idle'. Nothing else changes - this is not activity, so no
 * alert, no unarchive, no timestamp bump. A no-op unless the session is
 * actually watched right now and actually marked finished.
 */
export function markSessionSeen(sessionId: string): void {
  if (!isSessionWatched(sessionId)) return;
  const current = agentSessionsCollection.get(sessionId);
  if (current?.status !== 'finished') return;
  agentSessionsCollection.update(sessionId, (draft) => {
    draft.status = 'idle';
  });
}
