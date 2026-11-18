import type { Terminal } from '@xterm/xterm';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

/** Holds on each xterm's frame (an input jump, a resize) - counted, so they nest. */
const holds = new WeakMap<Terminal, number>();

/**
 * Keep the frame on screen while the program redraws behind it: the
 * synchronized-output mode, set on the xterm only (never sent to the pty),
 * holds rendering while the buffer keeps parsing. An input jump (inputs.ts)
 * shows where the user was, then the prompt, and none of the scrolling
 * between; a resize (terminal-view.tsx) shows the old screen, then the
 * program's repaint for the new size, and never the clear in between. xterm
 * lets a hold lapse after a second (its safety timeout), so a long walk
 * re-arms it with `keep`. A hold the program set itself is left alone.
 */
export function holdFrame(term: Terminal): {
  keep: () => void;
  /** Lift the hold; `onLifted` runs once xterm has parsed the lift (or at once when another hold remains). */
  release: (onLifted?: () => void) => void;
} {
  const held = holds.get(term) ?? 0;
  if (held === 0 && term.modes.synchronizedOutputMode) {
    return { keep: () => {}, release: (onLifted) => onLifted?.() };
  }
  holds.set(term, held + 1);
  const keep = (): void => {
    if (!term.modes.synchronizedOutputMode) term.write(SYNC_START);
  };
  keep();
  return {
    keep,
    release: (onLifted) => {
      const left = (holds.get(term) ?? 1) - 1;
      if (left > 0) {
        holds.set(term, left);
        onLifted?.();
        return;
      }
      holds.delete(term);
      term.write(SYNC_END, onLifted);
    },
  };
}

/**
 * A program's answer to a resize: a full-screen TUI redraws within a few ms of
 * the SIGWINCH, sometimes in two writes, so the repaint is complete once its
 * output pauses this long.
 */
const REPAINT_QUIET_MS = 40;
/** No output this long after the resize: the program drew nothing for it. */
const REPAINT_IDLE_MS = 250;
/** A program that never pauses (an agent streaming) is shown as it stands by then. */
const REPAINT_CAP_MS = 500;

/** Resolves once the program has (most likely) finished repainting. */
export function awaitRepaint(term: Terminal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(quiet);
      clearTimeout(cap);
      sub.dispose();
      resolve();
    };
    let quiet = setTimeout(done, REPAINT_IDLE_MS);
    const cap = setTimeout(done, REPAINT_CAP_MS);
    const sub = term.onWriteParsed(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, REPAINT_QUIET_MS);
    });
  });
}
