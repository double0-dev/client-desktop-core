import type { TabDescriptor } from '@renderer/lib/transfer';

/**
 * Bridges the window-level tab IPC (set up once in main.tsx) to the workspace
 * surfaces mounted in this window. Mirrors `session-bridge.ts`: a registry of
 * EVERY mounted workspace's controller, keyed by session id, plus a marker for
 * the one currently visible.
 *
 * Two routing modes:
 * - **Active only** - inserting a tab arriving from another window (and drawing
 *   its drop preview). A drop can only land on the surface the user can see.
 * - **Search all** - removing a tab whose shell moved to another window
 *   (`tab:removed`). The user may have switched sessions between the drop and
 *   the IPC arriving, so the removal must reach hidden workspaces too - or the
 *   old window keeps a tab wired to a PTY another window now owns.
 */
export type WorkspaceController = {
  /**
   * Insert a tab arriving from another window, at a window-client point.
   * Returns whether the tab was inserted (drives the transfer ack to main).
   */
  insertExternalTab: (descriptor: TabDescriptor, clientX: number, clientY: number) => boolean;
  /**
   * Drop a tab that moved out to another window - keep its shell alive.
   * Returns whether this workspace held (and removed) the tab.
   */
  removeTabByPtyId: (ptyId: string) => boolean;
  /**
   * Show a live drop indicator for a tab being dragged in from another window,
   * at the given window-client point (the same placeholder an in-window split or
   * reorder shows). Cleared by `clearExternalDropPreview`.
   */
  previewExternalDrop: (clientX: number, clientY: number) => void;
  /** Clear the cross-window drop indicator. */
  clearExternalDropPreview: () => void;
};

const controllers = new Map<string, WorkspaceController>();
let activeId: string | null = null;

/** Register a mounted workspace's controller. Returns the unregister cleanup. */
export function registerWorkspaceController(
  id: string,
  controller: WorkspaceController,
): () => void {
  controllers.set(id, controller);
  return () => {
    if (controllers.get(id) === controller) controllers.delete(id);
  };
}

/** Mark which mounted workspace is the visible one. Returns the unset cleanup. */
export function setActiveWorkspace(id: string): () => void {
  activeId = id;
  return () => {
    if (activeId === id) activeId = null;
  };
}

/** The visible workspace's controller, or null when none is showing (no project yet). */
export function getActiveWorkspaceController(): WorkspaceController | null {
  return (activeId !== null && controllers.get(activeId)) || null;
}

/** Every mounted workspace's controller (visible and hidden), for searches. */
export function getWorkspaceControllers(): WorkspaceController[] {
  return [...controllers.values()];
}
