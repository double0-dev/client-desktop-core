import type { CommandId } from '@renderer/lib/settings/keyboard-shortcuts';
import type { CommandRunRequest } from '@renderer/lib/search/run-request';

/**
 * Bridges the global Search Everywhere palette - mounted app-level, outside any
 * session's `WorkspaceLayoutProvider` - to the ACTIVE session's workspace
 * actions. Mirrors `session-bridge.ts`: only the active `WorkspaceView`
 * registers here, so "open file" / "run command" from the palette always targets
 * the session the user is looking at.
 *
 * Ops dispatched while no session is active (e.g. from a project's session-less view) are queued
 * and flushed when one registers - the palette navigates to a session first, and
 * the open/command then lands once that workspace mounts.
 */

export type WorkspaceActions = {
  /** Open a file (absolute path) in an editor tab in the active pane; `hostId`
   * for a host's file outside every project root (an editor jump, read-only). */
  openFile: (filePath: string, opts?: { hostId?: string }) => void;
  /** Run a workspace keyboard command (same dispatch as the global handler). */
  runCommand: (id: CommandId) => void;
  /** Open this session's folder (worktree or project dir) in an installed IDE. */
  openInEditor: (editorId: string) => void;
  /** Open a page in a browser tab (a private plan). */
  openUrl: (url: string) => void;
  /** Size the focused browser tab to a device preset (null = Responsive). */
  browserDevice: (deviceId: string | null) => void;
  /** Run a saved or detected command in the bottom panel, opening the panel. */
  runShellCommand: (req: CommandRunRequest) => void;
  /** Where this session's commands come from: its project (saved ones) and
   * its folder (detected ones). */
  commandScope: () => CommandScope;
};

export type CommandScope = { projectId: string | null; cwd: string | null };

let active: WorkspaceActions | null = null;
let pending: Array<(a: WorkspaceActions) => void> = [];

/** The active session publishes its actions here; flushes anything queued while
 * no session was active. */
export function setActiveWorkspaceActions(actions: WorkspaceActions): void {
  active = actions;
  if (pending.length > 0) {
    const queued = pending;
    pending = [];
    for (const op of queued) op(actions);
  }
}

/** Clear only if `actions` is still the registered set - so a fast active-session
 * switch (new registers before old cleans up) can't wipe the newcomer. */
export function clearActiveWorkspaceActions(actions: WorkspaceActions): void {
  if (active === actions) active = null;
}

/**
 * Run `op` against the active workspace, or queue it until one becomes active.
 * Returns true if it ran immediately, false if it was queued (the caller should
 * then navigate to a session so a workspace registers and the queue flushes).
 */
export function withActiveWorkspace(op: (a: WorkspaceActions) => void): boolean {
  if (active) {
    op(active);
    return true;
  }
  pending.push(op);
  return false;
}

/** The active session's command scope, or null when no session is active. */
export function activeCommandScope(): CommandScope | null {
  return active ? active.commandScope() : null;
}

export function hasActiveWorkspace(): boolean {
  return active !== null;
}
