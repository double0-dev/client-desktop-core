/**
 * Window-wide registry of which sessions have unsaved editor changes. Each
 * mounted `WorkspaceLayoutProvider` publishes its session's dirty state here
 * (and clears it on unmount), so components outside that provider - the
 * sidebar's delete flow - can check for unsaved work before tearing a session
 * down. Per-renderer by nature: a session torn off into its own window tracks
 * its dirty state in that window, not here.
 */

const dirtySessions = new Set<string>();

export function setSessionDirty(sessionId: string, dirty: boolean): void {
  if (dirty) dirtySessions.add(sessionId);
  else dirtySessions.delete(sessionId);
}

export function isSessionDirty(sessionId: string): boolean {
  return dirtySessions.has(sessionId);
}
