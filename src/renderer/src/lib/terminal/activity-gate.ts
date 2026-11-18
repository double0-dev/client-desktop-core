/**
 * A tiny cross-module gate telling session-status which terminal output is the app
 * redrawing a TUI, not the agent working.
 *
 * Revealing / focusing / resizing a terminal makes a full-screen program (Claude
 * Code, vim, …) repaint: a SIGWINCH from a refit, or a focus report (`ESC[I`) it
 * answers with a redraw. That output is real, but it's a consequence of OUR UI
 * interaction - so counting it as activity flips an idle/waiting session to
 * 'active' the moment you click it (the classic "clicking a session marks it
 * running" bug). The terminal view marks a short window around every resize/focus
 * it triggers; the status observer ignores output that lands inside it.
 *
 * Deliberately standalone (no xterm/collection imports) so both the view layer and
 * the status deriver can depend on it without a cycle.
 */

/** ptyId → epoch ms until which its output is app-induced (a redraw we caused). */
const suppressUntil = new Map<string, number>();

/**
 * How long after a resize/focus a TUI's repaint can still be arriving. Long enough
 * to cover a redraw settling, short enough that genuine work starting right after a
 * click is still seen as 'active'. Only gates status derivation - the display and
 * flow-control paths are untouched.
 */
const SUPPRESS_MS = 800;

/** Open (or extend) the ignore-output-for-status window for a terminal. */
export function suppressTerminalActivity(ptyId: string, ms: number = SUPPRESS_MS): void {
  suppressUntil.set(ptyId, Date.now() + ms);
}

/** Whether a terminal's output right now is a redraw we induced (see above). */
export function isTerminalActivitySuppressed(ptyId: string): boolean {
  const until = suppressUntil.get(ptyId);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    suppressUntil.delete(ptyId);
    return false;
  }
  return true;
}

// --- Commit keystrokes -------------------------------------------------------
//
// A needs-input session must STAY needs-input until the user actually acts: a
// blocked TUI repaints on all sorts of non-answers (focus reports, mouse-hover
// tracking, arrow-key navigation through a dialog's options), and none of that
// output means the agent resumed. What DOES mean "the user answered" is a
// commit keystroke - Enter, a digit quick-select, y/n, or Esc (cancel) - typed
// into the terminal. The view layer feeds every user input chunk through
// `noteTerminalUserInput`; session-status subscribes and clears a needs-input
// verdict the moment one lands. An event, not a timer - no correlation windows.

const ESC = String.fromCharCode(27);
// Legacy X10 mouse report: ESC [ M + 3 payload bytes (may contain digit chars -
// must go before the generic CSI strip, which would leave its payload behind).
const LEGACY_MOUSE_RE = new RegExp(`${ESC}\\[M[\\s\\S]{3}`, 'g');
// Any CSI sequence: covers SGR mouse (…M/m), focus reports (I/O), bracketed
// paste markers (200~/201~), and arrow/nav keys - their params contain digits
// that must not read as digit keys.
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?<=>]*[@-~]`, 'g');
// SS3-encoded keys (ESC O A - arrows/function keys in application mode).
const SS3_RE = new RegExp(`${ESC}O[@-~]`, 'g');
const COMMIT_CHAR_RE = /[\r\n0-9yYnN]/;

/**
 * Whether an input chunk contains a commit keystroke once terminal report/nav
 * sequences are stripped. A remaining bare ESC is the Esc key itself (cancel).
 * Pure, for tests.
 */
export function containsCommitKey(data: string): boolean {
  const stripped = data.replace(LEGACY_MOUSE_RE, '').replace(CSI_RE, '').replace(SS3_RE, '');
  return COMMIT_CHAR_RE.test(stripped) || stripped.includes(ESC);
}

type CommitKeyListener = (ptyId: string) => void;
const commitKeyListeners = new Set<CommitKeyListener>();

/** Be told whenever any terminal receives a commit keystroke. Returns unsubscribe. */
export function subscribeTerminalCommitKey(listener: CommitKeyListener): () => void {
  commitKeyListeners.add(listener);
  return () => commitKeyListeners.delete(listener);
}

// --- Interrupt keystrokes ----------------------------------------------------
//
// Esc or Ctrl+C stops a Claude Code turn, and no hook says so (Stop does not
// fire on an interrupt): without this a cancelled prompt left its session
// "Working…" for good. Esc is also a commit key - commit listeners run first,
// so a cancelled dialog lifts needs-input and then stops. Main's twin is
// `containsInterruptKey` in main/terminal-modes.ts.

const CTRL_C = String.fromCharCode(3);
// The Esc key itself: an ESC ending the chunk or followed by another (Esc Esc).
// ESC + a character is Alt+that key (meta), not a cancel.
const BARE_ESC_RE = new RegExp(`${ESC}(?=${ESC}|$)`);

/** Whether an input chunk carries Esc or Ctrl+C once report/nav sequences
 * are stripped. Pure, for tests. */
export function containsInterruptKey(data: string): boolean {
  const stripped = data.replace(LEGACY_MOUSE_RE, '').replace(CSI_RE, '').replace(SS3_RE, '');
  return BARE_ESC_RE.test(stripped) || stripped.includes(CTRL_C);
}

const interruptKeyListeners = new Set<CommitKeyListener>();

/** Be told whenever any terminal receives Esc or Ctrl+C. Returns unsubscribe. */
export function subscribeTerminalInterruptKey(listener: CommitKeyListener): () => void {
  interruptKeyListeners.add(listener);
  return () => interruptKeyListeners.delete(listener);
}

/** Record a user-input chunk for a terminal (called by the view's input path). */
export function noteTerminalUserInput(ptyId: string, data: string): void {
  if (containsCommitKey(data)) commitKeyListeners.forEach((l) => l(ptyId));
  if (containsInterruptKey(data)) interruptKeyListeners.forEach((l) => l(ptyId));
}
