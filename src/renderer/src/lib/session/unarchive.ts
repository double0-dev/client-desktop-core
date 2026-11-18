import { agentSessionsCollection } from '@renderer/lib/collections';

/**
 * Bring a session out of the archive because the user is working in it again.
 * The archive is for parked work; a session someone is opening terminals in
 * isn't parked. Resets it to a neutral 'idle' (exactly what the manual
 * unarchive does) - its live status re-derives from terminal activity from
 * there. No-op unless archived.
 *
 * Called only from explicit user actions - opening a new terminal in the
 * session, or a commit keystroke typed into one of its terminals (see
 * session/status.ts). Terminal output alone never unarchives: merely viewing an
 * archived session mounts its tabs, and their agent resuming / repainting is
 * not the user picking the session back up.
 * Returns whether the session was actually unarchived.
 */
export function unarchiveSession(sessionId: string): boolean {
  const current = agentSessionsCollection.get(sessionId);
  if (!current || current.status !== 'archived') return false;
  agentSessionsCollection.update(sessionId, (draft) => {
    draft.status = 'idle';
  });
  return true;
}
