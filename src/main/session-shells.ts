/**
 * Shells a session owns outside its layout - a session's commands, run beside
 * its tabs (`<prefix><sessionId>:<key>`). The ids live in running daemons and
 * in the renderer's dock state, so the literal never changes.
 */
export const SESSION_SHELL_PREFIX = 'commands:';

/** The id prefix of `sessionId`'s own shells outside its layout. */
export function sessionShellPrefix(sessionId: string): string {
  return `${SESSION_SHELL_PREFIX}${sessionId}:`;
}

/** Whether a terminal id is a session's shell outside its layout. */
export function isSessionShell(id: string): boolean {
  return id.startsWith(SESSION_SHELL_PREFIX);
}
