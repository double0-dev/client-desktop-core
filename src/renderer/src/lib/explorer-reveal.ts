/**
 * Bridges "Show in file explorer" (a tab's context menu) to the FileExplorer,
 * which lives in a different subtree (the WorkspaceSurface sidebar) and isn't
 * mounted at all while the sidebar is closed. Mirrors search-workspace-bridge:
 * a reveal fired before an explorer registers is held and delivered when one
 * mounts. Listeners key on the project root so a reveal only lands in the
 * explorer(s) showing that project - mounted-hidden sibling sessions with a
 * different root stay untouched. Openers are window-level: the host flips the
 * sidebar visible so the explorer can mount and take the pending reveal.
 */

import { currentHostOfPath } from '@renderer/lib/hosts/host-of-path';

type Listener = { rootPath: string; fn: (filePath: string) => void };

/**
 * One project root on one machine: the same path string on two hosts is two
 * explorers (a private plan › 12).
 */
const sameRoot = (a: string, b: string): boolean =>
  a === b && currentHostOfPath(a) === currentHostOfPath(b);

const listeners = new Set<Listener>();
const openers = new Set<() => void>();
let pending: { rootPath: string; filePath: string } | null = null;

/** Surface the explorer sidebar and point it at `filePath` (inside `rootPath`). */
export function revealInExplorer(rootPath: string, filePath: string): void {
  for (const open of openers) open();
  let delivered = false;
  for (const listener of listeners) {
    if (sameRoot(listener.rootPath, rootPath)) {
      listener.fn(filePath);
      delivered = true;
    }
  }
  if (!delivered) pending = { rootPath, filePath };
}

/** A mounted FileExplorer subscribes for its root's reveals; takes any held one. */
export function registerExplorerReveal(
  rootPath: string,
  fn: (filePath: string) => void,
): () => void {
  const listener = { rootPath, fn };
  listeners.add(listener);
  if (pending && sameRoot(pending.rootPath, rootPath)) {
    const held = pending;
    pending = null;
    // Deliver after the current commit, not synchronously: under StrictMode a
    // mount runs its effects twice (mount → cleanup → mount), and the second
    // pass of the explorer's hydrate effect resets the tree state - clobbering
    // a reveal applied during the first. Re-routing through revealInExplorer
    // hits whichever listener is current by then (or re-holds if none is).
    queueMicrotask(() => revealInExplorer(held.rootPath, held.filePath));
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The window's chrome subscribes to make the explorer sidebar visible. */
export function registerExplorerOpener(fn: () => void): () => void {
  openers.add(fn);
  return () => {
    openers.delete(fn);
  };
}
