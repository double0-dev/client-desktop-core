/**
 * Terminal private-mode tracking for adoption replays.
 *
 * A fresh xterm adopting a live shell gets the ring buffer's tail replayed into
 * it (see terminal.ts) - but the DECSET sequences that configured the terminal
 * were sent ONCE, at program startup, and for any long-running TUI they were
 * trimmed out of the ring long ago. The replayed screen then lands in a
 * terminal with every private mode at its default: no alternate screen (the
 * TUI's absolutely-positioned repaints scatter into the normal buffer and
 * scroll), no bracketed paste (a paste arrives as raw keystrokes), no mouse
 * reporting (the wheel scrolls the viewport instead of reaching the program),
 * no focus reporting (a focus-tracking TUI is stuck believing the terminal is
 * unfocused - Claude Code then shows its hollow "unfocused" cursor forever).
 * The adopt-repaint jiggle can't heal any of this: a SIGWINCH makes the
 * program repaint its FRAME, but no program re-asserts modes it knows it
 * already set.
 *
 * So main tracks the modes as they stream by, and `preamble()` reconstructs
 * the terminal's true mode state for the adopter. It is APPENDED to the
 * replay: the ring's own tail re-applies whatever mode changes it still
 * contains and the appended assertions then correct anything whose setup
 * predates the ring. Modes xterm.js doesn't implement are re-emitted all the
 * same - they were ignored the first time, so re-emitting them preserves
 * exact behavior parity.
 *
 * Deliberately NOT restored: DEC 2026 (synchronized output) - it is toggled
 * around every frame, so asserting a mid-frame `h` would hold rendering
 * hostage until the program's next frame; the pairing is transient state, not
 * terminal configuration.
 */

import { INPUT_OSC, STATUS_OSC } from './claude-status-hooks';
import type { InputMark } from './terminal-inputs';

/**
 * Private (DECSET) modes worth restoring: cursor/keypad behavior (1, 6, 5, 7,
 * 12, 25, 66), the alternate-screen family (47, 1047, 1048, 1049), mouse
 * protocols and encodings (9, 1000, 1002, 1003, 1005, 1006, 1015, 1016),
 * focus reporting (1004), bracketed paste (2004), and the modern extensions
 * (2027 grapheme clustering, 2048 in-band resize).
 */
const TRACKED_MODES = new Set([
  1, 5, 6, 7, 9, 12, 25, 47, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1048, 1049,
  2004, 2027, 2048,
]);

/** Modes a fresh terminal starts with ON: autowrap (7) and cursor visible (25). */
const DEFAULT_ON = [7, 25];

/**
 * DECSET 2031: colour-scheme change notifications. A program that enables it
 * (Claude Code under theme "auto" does, at startup) wants the terminal to push
 * `CSI ? 997 ; 1|2 n` whenever the light/dark tone changes, and re-detects the
 * tone (an OSC 11 query) each time it gets one. xterm.js never emits that push,
 * so a terminal-theme flip is invisible to such a program until we send it
 * ourselves - `reportsColorScheme` tells terminal.ts which ptys to send it to
 * (the tone push on adopt / on `terminal:setTone`). Tracked apart from the
 * DECSET modes above because it is NOT re-asserted in the preamble: it is the
 * PROGRAM's request TO the terminal, not terminal state to restore into a fresh
 * xterm, and xterm ignores it anyway.
 */
const COLOR_SCHEME_MODE = 2031;

/** Parser states - a minimal VT500-style machine, just enough to never misread. */
const enum State {
  /** Plain text; skip to the next ESC in bulk. */
  Ground,
  /** After ESC, deciding the sequence kind. */
  Escape,
  /** Collecting CSI params/intermediates until the final byte. */
  Csi,
  /** Inside an OSC/DCS/SOS/PM/APC string; content is opaque. */
  Str,
  /** ESC seen inside a string: `\` completes ST, anything else aborts the string. */
  StrEscape,
}

/** Params/intermediates longer than any sequence we care about - skip dispatch. */
const CSI_COLLECT_MAX = 32;

/** OSC payloads past this are no title (nor anything else we read) - discard. */
const OSC_COLLECT_MAX = 512;

/**
 * Our own status marker is read whole up to this: a tool marker's base64
 * payload (three lines of up to 300 chars) runs past OSC_COLLECT_MAX, and its
 * LAST line is the subagent tag the agent status needs. Matches the renderer's
 * carry cap (CARRY_MAX in session/status.ts), which a 6000-char question fits.
 */
const MARKER_COLLECT_MAX = 8_192;

const MARKER_PREFIX = `${STATUS_OSC};`;

/** Input marks (terminal-inputs.ts) - a prompt's payload is long, like a tool marker's. */
const INPUT_PREFIX = `${INPUT_OSC};`;

/**
 * What an agent's markers say it is doing - the per-pty half of the verbs'
 * meaning (session/status.ts `applyMarker` is the renderer's full reading).
 * Kept in main, which sees every chunk of every pty for its whole life, so a
 * renderer that starts observing mid-turn (a reload, a tear-off) can learn a
 * state no further marker will announce: an agent parked while a background
 * subagent works emits nothing until the subagent reports back.
 */
export type AgentStatus = 'running' | 'needs-input' | 'idle';

/** Whether a tool marker's payload (base64 of `<tool>\n<arg>[\n<agent>]`) was
 * tagged by a subagent - see claude-status-hooks.ts. */
function isSubagentTool(payload: string | undefined): boolean {
  if (!payload) return false;
  const third = Buffer.from(payload, 'base64').toString('utf8').split('\n')[2];
  return (third ?? '').trim() !== '';
}

const ESC = '\x1b';
// Input the terminal sends on its own or for a non-cancel key - mouse reports
// (the legacy X10 form carries 3 raw payload bytes), focus reports, bracketed
// paste brackets, arrows (CSI and SS3) - all begin with ESC, but none is the
// Esc key. Strip them first.
const LEGACY_MOUSE_RE = new RegExp(`${ESC}\\[M[\\s\\S]{3}`, 'g');
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?<=>]*[@-~]`, 'g');
const SS3_RE = new RegExp(`${ESC}O[@-~]`, 'g');
const CTRL_C = String.fromCharCode(3);
// The Esc key itself: an ESC ending the chunk or followed by another (Esc Esc).
// ESC + a character is Alt+that key (meta), not a cancel.
const BARE_ESC_RE = new RegExp(`${ESC}(?=${ESC}|$)`);

/**
 * Whether a chunk of user input carries a key that stops Claude Code's turn:
 * Esc or Ctrl+C. The renderer's twin is `containsInterruptKey`
 * (lib/terminal/activity-gate.ts). Pure.
 */
export function containsInterruptKey(data: string): boolean {
  const stripped = data.replace(LEGACY_MOUSE_RE, '').replace(CSI_RE, '').replace(SS3_RE, '');
  return BARE_ESC_RE.test(stripped) || stripped.includes(CTRL_C);
}

/**
 * One marker applied to a pty's agent status. A turn opening, a tool or an
 * answered question is work; a permission prompt or question is a wait; a
 * stop, a (re)launch or an exit is idle. A subagent's tool never lifts a wait -
 * a background agent works on while the main one sits at its dialog (the
 * renderer's rule). Unknown verbs (a newer hook set) change nothing. Pure.
 */
export function nextAgentStatus(
  current: AgentStatus,
  verb: string,
  payload: string | undefined,
): AgentStatus {
  switch (verb) {
    case 'running':
    case 'question-done':
      return 'running';
    case 'tool-start':
    case 'tool-done':
      return current === 'needs-input' && isSubagentTool(payload) ? current : 'running';
    case 'needs-input':
    case 'question':
      return 'needs-input';
    case 'ready':
    case 'finished':
    case 'ended':
      return 'idle';
    default:
      return current;
  }
}

/**
 * Incremental tracker for one PTY's terminal-mode state. Feed it every output
 * chunk (state carries across chunk boundaries, so split escape sequences are
 * handled); ask it for the restoration `preamble()` at adoption time.
 */
export class TerminalModeTracker {
  private state = State.Ground;
  /**
   * Tracked modes currently ON, in last-enabled order. Order matters for the
   * mouse-protocol family (9/1000/1002/1003): a terminal holds ONE active
   * protocol - the last `h` wins - so restoration must re-enable them in the
   * order the program did, not numerically.
   */
  private on = new Set<number>(DEFAULT_ON);
  /** True while the current string sequence is an OSC (the only kind we read). */
  private strIsOsc = false;
  /** OSC payload collected so far (capped; overlong strings are discarded). */
  private oscBuf = '';
  private oscOverflow = false;
  /**
   * Latest window title from an OSC 0/2 (`ESC ] 0;title BEL`), waiting to be
   * collected with `takeTitle()`. Programs report what they're doing through
   * this (Claude Code sets it to a summary of the current task), and the
   * session auto-namer follows it - parsed here because this tracker is the one
   * place that already walks every chunk with split-safe sequence state.
   */
  private pendingTitle: string | null = null;
  /**
   * What the stream says about the status-marker protocol: true once a 6790
   * marker (claude-status-hooks.ts) has gone by - the program runs our hooks,
   * whatever command launched it - false again after its 'ended' (SessionEnd:
   * the agent is gone, a plain shell prompt remains), null until either. The
   * launch-time flag only knows what the adapter rewrote; a Claude reached
   * through a wrapper (claude-shim.ts) is only known here, and a renderer
   * observing the pty afresh (a reload, a tear-off) asks main.
   */
  private markerMode: boolean | null = null;
  /** Whether the program has DECSET 2031 (colour-scheme notifications) enabled. */
  private colorScheme = false;
  /**
   * Input marks (and the agent-run verbs the input log needs) completed in
   * the chunk being fed, with where each ends in it - collected with
   * `takeInputMarks()` right after `feed`, so the indices are that chunk's.
   */
  private inputMarks: InputMark[] = [];
  /** The agent's live status as its markers describe it (see AgentStatus). */
  private agent: AgentStatus = 'idle';
  /** CSI param bytes collected so far (after the `?`, if private). */
  private params = '';
  /** CSI intermediate bytes (0x20–0x2F) collected so far. */
  private intermediates = '';
  /** True while the current CSI starts with the DEC private marker `?`. */
  private isPrivate = false;
  /** Current CSI grew past CSI_COLLECT_MAX - consume it but don't dispatch. */
  private overlong = false;
  /** Application keypad (ESC `=` / ESC `>`), off (numeric) by default. */
  private keypadApplication = false;
  /** Last DECSCUSR (`CSI Ps SP q`) seen verbatim, re-emitted as-is. */
  private cursorStyle: string | null = null;

  feed(chunk: string): void {
    const len = chunk.length;
    let i = 0;
    while (i < len) {
      const ch = chunk.charCodeAt(i);
      switch (this.state) {
        case State.Ground: {
          const esc = chunk.indexOf('\x1b', i);
          if (esc === -1) return;
          i = esc;
          this.state = State.Escape;
          break;
        }
        case State.Escape:
          switch (ch) {
            case 0x5b: // [
              this.state = State.Csi;
              this.params = '';
              this.intermediates = '';
              this.isPrivate = false;
              this.overlong = false;
              break;
            case 0x5d: // ] OSC
              this.state = State.Str;
              this.strIsOsc = true;
              this.oscBuf = '';
              this.oscOverflow = false;
              break;
            case 0x50: // P DCS
            case 0x58: // X SOS
            case 0x5e: // ^ PM
            case 0x5f: // _ APC
              this.state = State.Str;
              this.strIsOsc = false;
              break;
            case 0x3d: // = application keypad
              this.keypadApplication = true;
              this.state = State.Ground;
              break;
            case 0x3e: // > numeric keypad
              this.keypadApplication = false;
              this.state = State.Ground;
              break;
            case 0x1b: // ESC ESC - stay, decide on the next byte
              break;
            default:
              // Any other two-byte escape - not ours.
              this.state = State.Ground;
          }
          break;
        case State.Csi:
          if (ch === 0x1b) {
            // ESC aborts an unfinished CSI and starts a new sequence (this is
            // also how a replay tail cut mid-sequence stays harmless).
            this.state = State.Escape;
          } else if (ch === 0x18 || ch === 0x1a) {
            // CAN / SUB abort outright.
            this.state = State.Ground;
          } else if (ch >= 0x30 && ch <= 0x3f) {
            // Param bytes: digits ; : and the private markers < = > ?
            if (this.intermediates.length > 0)
              this.overlong = true; // malformed - ignore
            else if (ch === 0x3f && this.params.length === 0) this.isPrivate = true;
            else if (this.params.length < CSI_COLLECT_MAX) this.params += chunk[i];
            else this.overlong = true;
          } else if (ch >= 0x20 && ch <= 0x2f) {
            if (this.intermediates.length < 4) this.intermediates += chunk[i];
            else this.overlong = true;
          } else if (ch >= 0x40 && ch <= 0x7e) {
            if (!this.overlong) this.dispatchCsi(String.fromCharCode(ch));
            this.state = State.Ground;
          }
          // C0 controls other than CAN/SUB/ESC are "execute and continue" - skip.
          i += 1;
          continue;
        case State.Str:
          if (ch === 0x07) {
            // BEL terminates (OSC habit).
            this.finishOscString(i + 1);
            this.state = State.Ground;
          } else if (ch === 0x1b) this.state = State.StrEscape;
          else if (this.strIsOsc) {
            if (
              this.oscBuf.length < OSC_COLLECT_MAX ||
              (this.oscBuf.length < MARKER_COLLECT_MAX &&
                (this.oscBuf.startsWith(MARKER_PREFIX) || this.oscBuf.startsWith(INPUT_PREFIX)))
            )
              this.oscBuf += chunk[i];
            else this.oscOverflow = true;
          }
          break;
        case State.StrEscape:
          if (ch === 0x5c) {
            // \ - the ESC was the start of ST; string done.
            this.finishOscString(i + 1);
            this.state = State.Ground;
          } else {
            // Any other byte: the ESC aborted the string and starts a real
            // escape sequence - reprocess this byte in Escape state.
            this.strIsOsc = false;
            this.state = State.Escape;
            continue;
          }
          break;
      }
      i += 1;
    }
  }

  /**
   * A completed OSC string: keep its payload when it's a title report (code 0 =
   * icon+title, 2 = title). Everything else - including our own status marker
   * (6790, see terminal.ts) and code 1 (icon only) - is not a title. Overlong
   * strings were truncated mid-way, so a partial payload is discarded rather
   * than adopted as a garbage title. `end` is the index just past the
   * terminator in the current chunk (where an input mark's tag goes).
   */
  private finishOscString(end: number): void {
    if (!this.strIsOsc) return;
    this.strIsOsc = false;
    const s = this.oscBuf;
    this.oscBuf = '';
    const overflow = this.oscOverflow;
    this.oscOverflow = false;
    // Our own status marker. The verb sits at the front, so an overlong
    // payload (truncated here) still proves the protocol and still moves the
    // agent status.
    if (s.startsWith(MARKER_PREFIX)) {
      const rest = s.slice(MARKER_PREFIX.length);
      const sep = rest.indexOf(';');
      const verb = sep === -1 ? rest : rest.slice(0, sep);
      this.markerMode = verb !== 'ended';
      this.agent = nextAgentStatus(this.agent, verb, sep === -1 ? undefined : rest.slice(sep + 1));
      if (verb === 'ready' || verb === 'ended')
        this.inputMarks.push({ code: STATUS_OSC, verb, end });
      return;
    }
    // An input mark (terminal-inputs.ts). A truncated one lost its payload's
    // tail - still worth its verb (a `done`, a `ps`), never a garbled text.
    if (s.startsWith(INPUT_PREFIX)) {
      const rest = s.slice(INPUT_PREFIX.length);
      const sep = rest.indexOf(';');
      const verb = sep === -1 ? rest : rest.slice(0, sep);
      const payload = sep === -1 || overflow ? undefined : rest.slice(sep + 1);
      this.inputMarks.push({ code: INPUT_OSC, verb, payload, end });
      return;
    }
    if (overflow) return;
    const sep = s.indexOf(';');
    if (sep === -1) return;
    const code = s.slice(0, sep);
    if (code === '0' || code === '2') this.pendingTitle = s.slice(sep + 1);
  }

  /** Whether the stream has shown the marker protocol (see `markerMode`). */
  get markerDriven(): boolean | null {
    return this.markerMode;
  }

  /**
   * Whether the program wants colour-scheme change notifications (DECSET 2031).
   * terminal.ts sends such a program the `CSI ? 997 ; 1|2 n` push - which xterm
   * never emits - so a terminal-theme flip reaches it (see `COLOR_SCHEME_MODE`).
   */
  get reportsColorScheme(): boolean {
    return this.colorScheme;
  }

  /** What the markers so far say the agent is doing - 'idle' before any. */
  get agentStatus(): AgentStatus {
    return this.agent;
  }

  /**
   * User input written to the pty. Esc or Ctrl+C stops a Claude Code turn -
   * the prompt, a permission dialog, a question - and no hook reports that:
   * Stop does not fire on an interrupt, so the turn's `running` stood for
   * good and the session read "Working…" over a finished screen (a prompt
   * cancelled before the first reply, 2026-09-23). The keystroke is the only
   * event there is. A false stop (an Esc that only closed a menu mid-turn)
   * heals on the agent's next marker.
   */
  noteInput(data: string): void {
    if (this.markerMode && this.agent !== 'idle' && containsInterruptKey(data)) this.agent = 'idle';
  }

  /**
   * The input marks the last `feed` completed, with their end index in that
   * chunk; reading clears them. Call right after `feed`.
   */
  takeInputMarks(): InputMark[] {
    const marks = this.inputMarks;
    this.inputMarks = [];
    return marks;
  }

  /**
   * Whether the stream sits between sequences - text inserted now cannot land
   * inside a program's escape sequence (terminal.ts places a line's tag).
   */
  get atGround(): boolean {
    return this.state === State.Ground;
  }

  /** The latest title reported since the last call, or null; reading clears it. */
  takeTitle(): string | null {
    const t = this.pendingTitle;
    this.pendingTitle = null;
    return t;
  }

  private dispatchCsi(final: string): void {
    if (this.isPrivate && this.intermediates === '' && (final === 'h' || final === 'l')) {
      for (const p of this.params.split(';')) {
        const mode = Number.parseInt(p, 10);
        if (mode === COLOR_SCHEME_MODE) this.colorScheme = final === 'h';
        if (!TRACKED_MODES.has(mode)) continue;
        // Delete-then-add keeps `on` ordered by LAST enable (see its doc).
        this.on.delete(mode);
        if (final === 'h') this.on.add(mode);
      }
    } else if (!this.isPrivate && this.intermediates === ' ' && final === 'q') {
      this.cursorStyle = `\x1b[${this.params} q`;
    }
  }

  /**
   * The sequence that brings a fresh (all-defaults) terminal to this PTY's
   * current mode state; empty when nothing differs from the defaults. Starts
   * with ST to close any string sequence the replayed ring may have been cut
   * inside of (a dangling OSC would otherwise swallow the assertions; in
   * ground state a lone ST is a no-op).
   */
  preamble(): string {
    const parts: string[] = [];
    for (const mode of this.on) {
      if (!DEFAULT_ON.includes(mode)) parts.push(`\x1b[?${mode}h`);
    }
    for (const mode of DEFAULT_ON) {
      if (!this.on.has(mode)) parts.push(`\x1b[?${mode}l`);
    }
    if (this.keypadApplication) parts.push('\x1b=');
    if (this.cursorStyle) parts.push(this.cursorStyle);
    if (parts.length === 0) return '';
    return `\x1b\\${parts.join('')}`;
  }
}
