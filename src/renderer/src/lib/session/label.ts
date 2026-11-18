/** Longest label the sessions table stores (agent_sessions.label varchar). */
export const LABEL_MAX = 64;

/**
 * Fit a launch name into the label column. The New Session dialog caps what
 * can be typed, but a task card's title or a ticket's `KEY summary` is as
 * long as it was written there, and the collection schema rejects an over-long
 * label outright - the insert throws, so the launch dies with nothing to show
 * for it (or, with a worktree, after the branch was already cut). Every
 * launcher funnels through launchSession, which clamps here first.
 */
export function clampLabel(name: string): string {
  return name.trim().slice(0, LABEL_MAX).trim();
}
