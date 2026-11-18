import type { ResizeKind } from './protocol';

/**
 * Who sets a terminal's grid when several apps show it
 * (a private plan › 14). Pure - daemon-server.ts asks
 * it before resizing a pty and broadcasts what it applied.
 *
 * - A `claim` (the user typed, clicked, dragged a divider with the terminal
 *   focused) is applied at once and remembered as `{ by, at }`.
 * - A `passive` intent (a window shown, a panel toggled, a reconcile, a
 *   reconnect) is applied only when no OTHER client claimed the terminal
 *   within the last `holdMs`: a laptop whose window merely came back must
 *   not take the screen from the one being typed into.
 * - A claimant that goes leaves no claim behind: the remaining client's next
 *   intent applies.
 */
export const CLAIM_HOLD_MS = 30_000;

type Claim = { by: number; at: number };

export class ResizeArbiter {
  private readonly claims = new Map<string, Claim>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly holdMs: number = CLAIM_HOLD_MS,
  ) {}

  /** Whether the intent of connection `by` for terminal `id` resizes the pty. */
  intent(id: string, by: number, kind: ResizeKind): boolean {
    const at = this.now();
    if (kind === 'claim') {
      this.claims.set(id, { by, at });
      return true;
    }
    const claim = this.claims.get(id);
    if (!claim || claim.by === by || at - claim.at >= this.holdMs) return true;
    return false;
  }

  /** The connection holding a live claim on `id`, or null. */
  claimant(id: string): number | null {
    const claim = this.claims.get(id);
    if (!claim || this.now() - claim.at >= this.holdMs) return null;
    return claim.by;
  }

  /** The terminal is gone. */
  forget(id: string): void {
    this.claims.delete(id);
  }

  /** A client detached: its claims go with it. */
  connectionGone(by: number): void {
    for (const [id, claim] of [...this.claims]) if (claim.by === by) this.claims.delete(id);
  }
}
