import type { WorkspaceLayout } from '@renderer/lib/workspace/layout';
import type { CommandDockState } from '@renderer/lib/transfer';

/**
 * Bridges the session sidebar and the window-level session IPC to the live
 * workspaces, which are mounted deeper in the tree and (for the sidebar) outside
 * the dragged session's layout provider.
 *
 * Three registries:
 * - **Layouts** - every open session publishes a getter for its current layout,
 *   so the sidebar can read any session's tabs/splits when tearing it off (even
 *   one that isn't the active view). A session not listed here was never opened,
 *   so it has no in-memory layout and is torn off fresh.
 * - **Bottom panel** - likewise, every open session's bottom panel publishes a
 *   getter for its view state (open + selection + open terminals), so a tear-off
 *   restores it verbatim in the new window.
 * - **Host** - `WorkspaceHost` registers a controller so the `session:removed`
 *   IPC (a session moved to another window) can release it here.
 */

const layouts = new Map<string, () => WorkspaceLayout>();

export function registerSessionLayout(
  sessionId: string,
  getLayout: () => WorkspaceLayout,
): () => void {
  layouts.set(sessionId, getLayout);
  return () => {
    if (layouts.get(sessionId) === getLayout) layouts.delete(sessionId);
  };
}

/** The session's current layout, or null if it isn't open in this window. */
export function getSessionLayout(sessionId: string): WorkspaceLayout | null {
  return layouts.get(sessionId)?.() ?? null;
}

let restoredLayouts: ((sessionId: string) => WorkspaceLayout | undefined) | null = null;

/** `WorkspaceHost` publishes the layouts persisted by the previous run - what
 * a session not opened yet this run will mount with, its live shells included
 * (a daemon keeps them across a restart). Returns an unregister. */
export function registerRestoredLayouts(
  get: (sessionId: string) => WorkspaceLayout | undefined,
): () => void {
  restoredLayouts = get;
  return () => {
    if (restoredLayouts === get) restoredLayouts = null;
  };
}

/** The session's live layout, else the one it will be restored with, else null. */
export function getKnownSessionLayout(sessionId: string): WorkspaceLayout | null {
  return getSessionLayout(sessionId) ?? restoredLayouts?.(sessionId) ?? null;
}

const commandDocks = new Map<string, () => CommandDockState>();

export function registerCommandDockState(
  sessionId: string,
  getState: () => CommandDockState,
): () => void {
  commandDocks.set(sessionId, getState);
  return () => {
    if (commandDocks.get(sessionId) === getState) commandDocks.delete(sessionId);
  };
}

/** The session's current Commands-dock view state, or null if it isn't open here. */
export function getCommandDockState(sessionId: string): CommandDockState | null {
  return commandDocks.get(sessionId)?.() ?? null;
}

export type SessionHostController = {
  /** A session moved to another window: drop it here, keeping its shells alive. */
  releaseSession: (sessionId: string) => void;
  /** A session's window closed: take it back, reconstructing its (synced) layout. */
  returnSession: (sessionId: string, layout: WorkspaceLayout) => void;
  /** A whole project moved to its own window: release every session of it held here. */
  releaseProject: (projectId: string) => void;
  /**
   * A project's window closed: take its sessions back - the ones that window
   * opened come with their synced layout and remount, the rest just stop
   * reading as external (their shells never left this window).
   */
  returnProject: (
    projectId: string,
    sessions: Array<{ sessionId: string; layout: WorkspaceLayout }>,
  ) => void;
  /**
   * A project window asked this (main) window to show a project - null = its
   * New project dialog, with the machine `hostId` preselected when given.
   */
  showProject: (projectId: string | null, hostId?: string | null) => void;
};

let host: SessionHostController | null = null;

export function setSessionHost(controller: SessionHostController | null): void {
  host = controller;
}

export function getSessionHost(): SessionHostController | null {
  return host;
}
