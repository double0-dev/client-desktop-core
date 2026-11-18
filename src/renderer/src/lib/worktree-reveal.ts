/**
 * One-shot bridge from the sidebar's worktree icon to the target session's git
 * state. Clicking the icon opens the Changes overlay and asks for that
 * worktree's checked-out branch to be selected in the graph; the request is
 * consumed by the session's GitProvider once it is the active one with the
 * overlay up - for another row that's only after navigation lands. Module-level
 * (like search-workspace-bridge.ts) because the request has to outlive the
 * click's render pass and a possible navigation.
 */

/** Unconsumed requests expire - a navigation that never lands must not fire a
 * reveal on some later overlay open. */
const REQUEST_TTL_MS = 15_000;

let pending: { root: string; at: number } | null = null;
const listeners = new Set<() => void>();

/** File a request for the session running in `root` (its worktree/subfolder). */
export function requestWorktreeReveal(root: string): void {
  pending = { root, at: Date.now() };
  for (const notify of listeners) notify();
}

/** GitProviders listen so a freshly filed request re-runs their consume effect
 * even when nothing else re-renders (icon clicked while Changes is already
 * open on the same session). */
export function onWorktreeRevealRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Claim the pending request if it targets `root` and hasn't expired. */
export function takeWorktreeReveal(root: string): boolean {
  if (!pending) return false;
  if (Date.now() - pending.at > REQUEST_TTL_MS) {
    pending = null;
    return false;
  }
  if (pending.root !== root) return false;
  pending = null;
  return true;
}
