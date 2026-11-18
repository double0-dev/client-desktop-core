/**
 * Mouse reports for a program that asked for the mouse (DECSET 9 / 1000 /
 * 1002 / 1003, SGR encoding with 1006) - the Ghostty engine sends none of its
 * own: on the alternate screen it turns the wheel into arrow keys (which in
 * Claude Code's full-screen view walk the prompt history instead of scrolling
 * the conversation) and a click only ever starts a selection.
 */

export type WheelDirection = 'up' | 'down';

type Modifiers = { shift: boolean; alt: boolean; ctrl: boolean };

export type WheelReport = Modifiers & {
  direction: WheelDirection;
  /** 0-based cell under the pointer. */
  col: number;
  row: number;
  /** DECSET 1006: the SGR encoding; otherwise the legacy X10 bytes. */
  sgr: boolean;
};

/** 0 left, 1 middle, 2 right - `MouseEvent.button` order differs (1 is middle there too). */
export type MouseButton = 0 | 1 | 2;

export type MouseReport = Modifiers & {
  /** `move` with no button held is plain motion (DECSET 1003). */
  action: 'press' | 'release' | 'move';
  button: MouseButton | null;
  col: number;
  row: number;
  sgr: boolean;
};

/** The program's mouse mode, strongest first - what xterm reports for each. */
export type MouseMode = 'any' | 'drag' | 'click' | 'press' | 'none';

/** Which events a mode reports. */
export function reports(mode: MouseMode, report: Pick<MouseReport, 'action' | 'button'>): boolean {
  switch (mode) {
    case 'none':
      return false;
    case 'press': // X10 (DECSET 9): presses only
      return report.action === 'press';
    case 'click':
      return report.action !== 'move';
    case 'drag':
      return report.action !== 'move' || report.button !== null;
    case 'any':
      return true;
  }
}

function encode(code: number, col: number, row: number, sgr: boolean, release: boolean): string {
  const c = Math.max(0, col) + 1;
  const r = Math.max(0, row) + 1;
  if (sgr) return `\x1b[<${code};${c};${r}${release ? 'm' : 'M'}`;
  // X10 carries each value + 32 in one byte: past column / row 223 it cannot
  // say where - clamp, as terminals do.
  const byte = (n: number): string => String.fromCharCode(Math.min(255, n + 32));
  return `\x1b[M${byte(code)}${byte(c)}${byte(r)}`;
}

function modifierBits(m: Modifiers): number {
  return (m.shift ? 4 : 0) + (m.alt ? 8 : 0) + (m.ctrl ? 16 : 0);
}

/** A press, release or motion, encoded the way xterm.js reports it. */
export function encodeMouse(r: MouseReport): string {
  let code: number;
  if (r.action === 'release') {
    // SGR names the released button; X10 has one "released" code for all.
    code = r.sgr && r.button !== null ? r.button : 3;
  } else if (r.action === 'move') {
    code = (r.button ?? 3) + 32;
  } else code = r.button ?? 0;
  return encode(code + modifierBits(r), r.col, r.row, r.sgr, r.action === 'release');
}

/** One wheel notch, encoded the way xterm.js reports it. */
export function encodeWheel(r: WheelReport): string {
  const code = (r.direction === 'up' ? 64 : 65) + modifierBits(r);
  return encode(code, r.col, r.row, r.sgr, false);
}

/**
 * Turns wheel events into whole notches. A trackpad sends many small pixel
 * deltas; the remainder carries to the next event so a slow scroll still
 * moves, and one event never sends more than `MAX_STEPS` reports.
 */
export class WheelAccumulator {
  private rest = 0;

  static readonly MAX_STEPS = 10;

  /** Lines (signed: negative = up) to report for this event. */
  take(
    deltaY: number,
    deltaMode: number,
    cellHeight: number,
    rows: number,
    sensitivity: number,
  ): number {
    let lines: number;
    if (deltaMode === 1) lines = deltaY;
    else if (deltaMode === 2) lines = deltaY * rows;
    else lines = deltaY / Math.max(1, cellHeight);
    this.rest += lines * Math.max(0.1, sensitivity);
    const steps = Math.trunc(this.rest);
    this.rest -= steps;
    const max = WheelAccumulator.MAX_STEPS;
    return Math.max(-max, Math.min(max, steps));
  }

  reset(): void {
    this.rest = 0;
  }
}
