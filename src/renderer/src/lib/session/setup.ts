/**
 * One-shot wiring for worktree session setup commands. Two in-memory registries
 * (never persisted) so a setup command runs exactly ONCE - at creation - and
 * never re-runs on an app restart:
 *
 * - `pendingSessionSetup`: a freshly-created worktree session's setup command,
 *   consumed once when its workspace first mounts (which then spawns a dedicated
 *   "setup" terminal tab for it).
 * - `oneShotByPty`: that setup tab's command, consumed when its PTY first spawns
 *   and passed as the terminal's `initialCommand`. The tab itself persists as a
 *   plain shell with no startup command, so a later relaunch is just an empty
 *   terminal in the worktree.
 */

const pendingSessionSetup = new Map<string, string>();
const oneShotByPty = new Map<string, string>();

/**
 * Deterministic PTY id for a session's one-time setup shell. Stable (like
 * `conversationPtyId`) so launch can spawn the shell eagerly - running the setup
 * command before any workspace mounts - and the setup tab added on first mount
 * adopts that live shell instead of spawning a second one.
 */
export function setupPtyId(sessionId: string): string {
  return `setup:${sessionId}`;
}

export function setPendingSessionSetup(sessionId: string, command: string): void {
  pendingSessionSetup.set(sessionId, command);
}

/** Read-and-delete the setup command for a session - StrictMode-safe, so only
 * the first caller of a double-invoked mount effect gets it. */
export function takePendingSessionSetup(sessionId: string): string | undefined {
  const cmd = pendingSessionSetup.get(sessionId);
  if (cmd !== undefined) pendingSessionSetup.delete(sessionId);
  return cmd;
}

export function setOneShotCommand(ptyId: string, command: string): void {
  oneShotByPty.set(ptyId, command);
}

/** Read-and-delete a PTY's one-shot command, so it runs only on its first spawn. */
export function takeOneShotCommand(ptyId: string): string | undefined {
  const cmd = oneShotByPty.get(ptyId);
  if (cmd !== undefined) oneShotByPty.delete(ptyId);
  return cmd;
}

/**
 * Sessions launched to open on an extension's view over their agent CLI
 * (`NewSessionLaunch.openInView`): read by the
 * workspace's first layout (peek - StrictMode inits twice), dropped once that
 * layout is saved (take).
 */
const viewLaunches = new Set<string>();

export function setViewLaunch(sessionId: string): void {
  viewLaunches.add(sessionId);
}

export function isViewLaunch(sessionId: string): boolean {
  return viewLaunches.has(sessionId);
}

export function takeViewLaunch(sessionId: string): boolean {
  return viewLaunches.delete(sessionId);
}
