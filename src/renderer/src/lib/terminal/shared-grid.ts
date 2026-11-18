/**
 * A terminal two computers show at once (a remote host several apps attach
 * to, a private plan › 14): the computer the user is
 * working at sets the grid, the other follows it.
 *
 * - Every pty resize says whether the user asked for it: `claim` within
 *   CLAIM_AFTER_INPUT_MS of typing, pasting or clicking into that terminal,
 *   `passive` otherwise (a window shown, a panel toggled, a reconcile, a
 *   reconnect). Main hands the kind to the host's daemon, which applies a
 *   claim at once and a passive refit only when no other computer claimed
 *   within the last 30 s (daemon/resize-intents.ts). Locally the kind is
 *   ignored.
 * - When the other computer's claim set the grid, main says so
 *   (`terminal:grid`, `own: false`): this window fits its xterm to that grid
 *   - the pane shows the terminal letterboxed - and never resizes the pty
 *   back, so the pool's invariant "xterm grid = pty grid" holds from the
 *   xterm's side.
 * - The moment the user types or clicks into such a terminal it is theirs
 *   again: refit to the pane, sent as a claim.
 */
import type { Terminal } from '@xterm/xterm';

export type ResizeKind = 'claim' | 'passive';

/** How long after an interaction a refit still counts as the user's. */
export const CLAIM_AFTER_INPUT_MS = 10_000;

/** Whether a refit `now` follows an interaction at `at` closely enough to claim. */
export function resizeKindFor(at: number | undefined, now: number): ResizeKind {
  return at !== undefined && now - at < CLAIM_AFTER_INPUT_MS ? 'claim' : 'passive';
}

// What xterm itself answers on the pty's behalf - focus reports, device
// attributes (DA1 `?`, DA2 `>`), cursor / status reports, window size
// reports (`8;r;c t`), keyboard-mode answers (`? … u`), colour and DCS
// replies - is not the user: a replay a joining laptop's xterm answers must
// never claim the grid.
const ESC = '\x1b';
const GENERATED = new RegExp(
  [
    `${ESC}\\[[IO]`,
    `${ESC}\\[[?>]?[\\d;]*[cRnt]`,
    `${ESC}\\[\\?[\\d;]*u`,
    `${ESC}\\][^\u0007${ESC}]*(?:\u0007|${ESC}\\\\)`,
    `${ESC}P[\\s\\S]*?${ESC}\\\\`,
  ].join('|'),
  'g',
);

/** Whether bytes xterm sends to the pty came from the user (keys, paste, mouse). */
export function isUserInput(data: string): boolean {
  // Several replies may arrive in one chunk (DA1 and a cursor report): it is
  // the user only when something is left once every reply is taken out.
  return data.replace(GENERATED, '').length > 0;
}

type Grid = { cols: number; rows: number };

const interactedAt = new Map<string, number>();
/** Terminals whose grid another computer holds, with that grid. */
const following = new Map<string, Grid>();

/** The user typed, pasted or clicked into `ptyId` - the next refit is theirs. */
export function noteTerminalInteraction(ptyId: string, now: number = Date.now()): void {
  interactedAt.set(ptyId, now);
}

/** The kind of a resize sent for `ptyId` now. */
export function resizeKindNow(ptyId: string, now: number = Date.now()): ResizeKind {
  return resizeKindFor(interactedAt.get(ptyId), now);
}

/** Resize the pty behind `ptyId`, saying whether the user asked for it. */
export function resizePty(ptyId: string, cols: number, rows: number): void {
  window.api?.terminal.resize(ptyId, cols, rows, resizeKindNow(ptyId));
}

/** The grid another computer holds for `ptyId`, or null when it is ours. */
export function followedGrid(ptyId: string): Grid | null {
  return following.get(ptyId) ?? null;
}

/**
 * Whether `ptyId` follows another computer's grid right now and the user has
 * not just interacted with it here - its pty must not be resized (nor
 * jiggled) from this window.
 */
export function followsOther(ptyId: string): boolean {
  return following.has(ptyId) && resizeKindNow(ptyId) !== 'claim';
}

/**
 * A refit nobody asked for, on a terminal another computer sizes: keep the
 * xterm on that computer's grid and send nothing - no pty resize, no
 * jiggle. True when the caller must stop there. Fitting to the pane and
 * sending a passive resize the host refuses would show a frame at the wrong
 * size for a round trip and SIGWINCH the other laptop's program (review,
 * 2026-10-31). Only a claim (the user typed / clicked here) refits.
 */
export function holdFollowedGrid(
  ptyId: string,
  term: Pick<Terminal, 'cols' | 'rows' | 'resize'>,
): boolean {
  const grid = following.get(ptyId);
  if (!grid || !followsOther(ptyId)) return false;
  if (term.cols !== grid.cols || term.rows !== grid.rows) {
    try {
      term.resize(grid.cols, grid.rows);
    } catch {
      // A disposed terminal - nothing to hold.
    }
  }
  return true;
}

/**
 * Main said which grid `ptyId` runs at. Another computer's: follow it
 * (resize the xterm only). Ours: nothing to follow any more.
 */
export function applyGrid(
  ptyId: string,
  grid: Grid & { own: boolean },
  term: Pick<Terminal, 'cols' | 'rows' | 'resize'> | undefined,
): void {
  if (grid.own) {
    following.delete(ptyId);
    return;
  }
  following.set(ptyId, { cols: grid.cols, rows: grid.rows });
  if (term && (term.cols !== grid.cols || term.rows !== grid.rows)) {
    try {
      term.resize(grid.cols, grid.rows);
    } catch {
      // A disposed terminal - nothing to fit.
    }
  }
}

/**
 * The user interacted with `ptyId` (typed, pasted, clicked). A terminal that
 * was following another computer's grid is taken back: `refit` fits it to
 * this pane and sends the size - a claim now.
 */
export function claimOnInteraction(ptyId: string, data: string | null, refit: () => void): void {
  if (data !== null && !isUserInput(data)) return;
  noteTerminalInteraction(ptyId);
  if (!following.has(ptyId)) return;
  following.delete(ptyId);
  refit();
}

/** The terminal is gone. */
export function forgetSharedGrid(ptyId: string): void {
  interactedAt.delete(ptyId);
  following.delete(ptyId);
}

let started = false;
/** Subscribe to main once per window; `termOf` finds a pooled xterm. */
export function startSharedGridFeed(
  termOf: (ptyId: string) => Pick<Terminal, 'cols' | 'rows' | 'resize'> | undefined,
): void {
  if (started || typeof window === 'undefined' || !window.api?.terminal?.onGrid) return;
  started = true;
  window.api.terminal.onGrid((g) => applyGrid(g.id, g, termOf(g.id)));
}

/** Tests. */
export function resetSharedGridForTest(): void {
  interactedAt.clear();
  following.clear();
  started = false;
}
