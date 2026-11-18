import { useEffect, useSyncExternalStore } from 'react';
import type { IMarker, Terminal } from '@xterm/xterm';
import { setTerminalCwd } from '@renderer/lib/terminal/file-links';
import type { InputEntry } from '../../../../main/terminal-inputs';
import { suppressTerminalActivity } from '@renderer/lib/terminal/activity-gate';
import { holdFrame } from '@renderer/lib/terminal/frame-hold';
import {
  canWalkAgentView,
  findPromptRow,
  isPromptRow,
  messageArea,
  promptEchoHeight,
  promptNeedle,
  promptOnScreen,
  scrollClaudeFromTop,
  scrollClaudeTo,
} from '@renderer/lib/terminal/input-jump';

export type { InputEntry } from '../../../../main/terminal-inputs';

/**
 * The renderer half of the Inputs list (a private plan): a
 * mirror of each pty's input log in main (main/terminal-inputs.ts), and the
 * xterm markers that say where each input sits in the terminal.
 *
 * - Entries: asked for once per pty (`terminal:inputList`), then kept current
 *   by main's pushes. Main holds the durable copy, so a reload or a tear-off
 *   gets the whole list back even when the replay ring is long past it.
 * - Positions: main splices `6791;at;<seq>` / `6791;end;<seq>` tags into the
 *   stream behind each mark; the xterm OSC handler registers a marker at the
 *   cursor when it parses one. A fresh xterm replaying the ring rebuilds the
 *   markers of what is still in it. xterm moves markers as output scrolls
 *   and disposes them with the lines they sit on.
 * - Lines: a program that reports nothing (a REPL, a shell without the
 *   integration) gets its line read off the screen at Enter - the screen,
 *   never the keystrokes: those miss history recall and completion, and
 *   would capture a password typed at a prompt that does not echo.
 */

type Positions = { start: IMarker; end?: IMarker };

type PtyInputs = {
  entries: InputEntry[];
  /** `terminal:inputList` answered (or is on its way). */
  asked: boolean;
  markers: Map<number, Positions>;
  /** Lines reported to main, waiting for the entry that names their `ref`. */
  pendingLines: Map<number, IMarker>;
  /** What the shell integration last said: at its prompt, or running a command. */
  shell: 'unknown' | 'prompt' | 'running';
  /** An agent speaking the status protocol owns the terminal (6790 seen, not ended). */
  agent: boolean;
  /** This xterm parsed a status verb itself - main's seed of `agent` then stays out. */
  agentHeard: boolean;
  /** The program reads mouse reports in the SGR encoding (DECSET 1006). */
  sgrMouse: boolean;
  /** The text left of the cursor when typing on the current line began. */
  typedFrom: string | null;
  term: Terminal | null;
  /**
   * Prompts a walk proved the agent's view no longer holds (a long session's
   * full-screen view keeps only its later part): listed as scrolled out.
   */
  unreachable: Set<number>;
};

const ptys = new Map<string, PtyInputs>();
const listeners = new Set<() => void>();
let lineRef = 0;

function state(ptyId: string): PtyInputs {
  let s = ptys.get(ptyId);
  if (!s) {
    s = {
      entries: [],
      asked: false,
      markers: new Map(),
      pendingLines: new Map(),
      shell: 'unknown',
      agent: false,
      agentHeard: false,
      sgrMouse: false,
      typedFrom: null,
      term: null,
      unreachable: new Set(),
    };
    ptys.set(ptyId, s);
  }
  return s;
}

function emit(): void {
  for (const l of listeners) l();
}

/** Upsert entries by seq, keeping the list in seq order. */
function merge(ptyId: string, incoming: InputEntry[]): void {
  const s = state(ptyId);
  const bySeq = new Map(s.entries.map((e) => [e.seq, e]));
  for (const e of incoming) {
    bySeq.set(e.seq, e);
    // A line this window reported: its marker was placed at Enter.
    if (e.ref !== null && s.pendingLines.has(e.ref)) {
      s.markers.set(e.seq, { start: s.pendingLines.get(e.ref)! });
      s.pendingLines.delete(e.ref);
    }
  }
  s.entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  emit();
}

let connected = false;
/** Listen for main's pushes - once, on first use (no-op without the bridge). */
function connect(): void {
  if (connected || typeof window === 'undefined' || !window.api?.terminal?.onInputs) return;
  connected = true;
  window.api.terminal.onInputs((id, entries) => merge(id, entries));
}

/** Ask main for a pty's list once (a window seeing the terminal for the first time). */
export function ensureInputs(ptyId: string): void {
  connect();
  const s = state(ptyId);
  if (s.asked) return;
  s.asked = true;
  const ask = window.api?.terminal?.inputList?.(ptyId);
  if (!ask) return;
  void ask.catch(() => [] as InputEntry[]).then((entries) => merge(ptyId, entries));
}

/** A pty's entries, oldest first - asked for on first use. */
export function useTerminalInputs(ptyId: string | null): InputEntry[] {
  useEffect(() => {
    if (ptyId) ensureInputs(ptyId);
  }, [ptyId]);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (ptyId ? (ptys.get(ptyId)?.entries ?? NONE) : NONE),
  );
}
const NONE: InputEntry[] = [];

/** The tab closed or moved to another window: nothing here speaks for it now. */
export function forgetInputs(ptyId: string): void {
  if (ptys.delete(ptyId)) emit();
}

// --- the xterm side -----------------------------------------------------------

function onInputOsc(s: PtyInputs, term: Terminal, data: string): void {
  const sep = data.indexOf(';');
  const verb = sep === -1 ? data : data.slice(0, sep);
  const arg = sep === -1 ? '' : data.slice(sep + 1);
  switch (verb) {
    case 'ps':
      s.shell = 'prompt';
      return;
    case 'cmd':
      s.shell = 'running';
      return;
    case 'at':
    case 'end': {
      const seq = Number.parseInt(arg, 10);
      // The alternate screen has no scrollback: a mark made there (a
      // full-screen Claude's prompt) has no place to scroll back to.
      if (!Number.isSafeInteger(seq) || term.buffer.active.type !== 'normal') return;
      const marker = term.registerMarker(0);
      if (!marker) return;
      const cur = s.markers.get(seq);
      if (verb === 'at') {
        cur?.start.dispose();
        cur?.end?.dispose();
        s.markers.set(seq, { start: marker });
      } else if (cur) {
        cur.end?.dispose();
        cur.end = marker;
      } else {
        marker.dispose();
      }
      emit();
      return;
    }
    default:
  }
}

/**
 * Wire a NEW xterm for a pty: the tags become markers, and the agent status
 * verbs say whether an agent owns the terminal (its prompts come from the
 * hooks, so Enter there is not a line to read). Markers of an earlier xterm
 * went with it; a replay into this one rebuilds what the ring still holds.
 */
/** A base64 UTF-8 path from the shell, or null when it is not one. */
function decodeBase64Path(b64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const path = new TextDecoder().decode(bytes);
    return path.startsWith('/') && !path.includes('\0') ? path : null;
  } catch {
    return null;
  }
}

export function attachInputTracking(ptyId: string, term: Terminal): void {
  connect();
  const s = state(ptyId);
  for (const p of s.markers.values()) {
    p.start.dispose();
    p.end?.dispose();
  }
  s.markers.clear();
  s.pendingLines.clear();
  s.shell = 'unknown';
  s.agent = false;
  s.agentHeard = false;
  s.sgrMouse = false;
  s.typedFrom = null;
  s.term = term;
  term.parser.registerOscHandler(6791, (data) => {
    // The shell's folder (zsh integration): file links resolve against it.
    if (data.startsWith('cwd;')) {
      const path = decodeBase64Path(data.slice(4));
      if (path) setTerminalCwd(ptyId, path);
      return true;
    }
    onInputOsc(s, term, data);
    return true;
  });
  term.parser.registerOscHandler(6790, (data) => {
    s.agent = !data.startsWith('ended');
    s.agentHeard = true;
    // Not ours to consume - xterm ignores it either way.
    return false;
  });
  // A fresh xterm on a live pty (a reload, a revisit after eviction, a
  // tear-off) hears the agent only from a verb still in the replay ring - and
  // a full-screen Claude rewrites every cell of every frame, so an idle one's
  // last verb left the 256 KB ring minutes ago: every prompt read as
  // `scrolled out` until the next turn. Main read the whole stream; its
  // verdict fills that gap and never overrides a verb this xterm parsed.
  void window.api?.terminal
    ?.markerDriven?.([ptyId])
    .then((ids) => {
      if (s.term === term && !s.agentHeard) s.agent = ids.includes(ptyId);
    })
    .catch(() => {});
  // Watched, never consumed: a jump clicks only in the encoding the program
  // asked for (the adopt replay's mode preamble sets it again).
  for (const final of ['h', 'l'] as const) {
    term.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
      if (params.includes(1006)) s.sgrMouse = final === 'h';
      return false;
    });
  }
}

/** The rows of a logical line (its soft-wrapped continuations) around `row`. */
function logicalLine(term: Terminal, row: number): { start: number; text: string } {
  const buf = term.buffer.active;
  let start = row;
  while (start > 0 && buf.getLine(start)?.isWrapped) start -= 1;
  let end = row;
  while (buf.getLine(end + 1)?.isWrapped) end += 1;
  let text = '';
  for (let r = start; r <= end; r++) text += buf.getLine(r)?.translateToString(r === end) ?? '';
  return { start, text };
}

function cursorRow(term: Terminal): number {
  return term.buffer.active.baseY + term.buffer.active.cursorY;
}

/**
 * Keystrokes on their way to a pty (terminal-view's onData). The first key
 * on a line notes what stands left of the cursor - the program's prompt -
 * and Enter reads the line, minus that prompt, as an input when nothing else
 * reports it: not at an integrated shell's prompt (the shell reports its
 * command), not while an agent with hooks owns the terminal, not on the
 * alternate screen (a full-screen program has no lines to return to), and
 * not for a paste (it arrives as one chunk, never a lone `\r`).
 */
export function noteInputKeys(ptyId: string, term: Terminal, data: string): void {
  const s = ptys.get(ptyId);
  if (!s || s.term !== term) return;
  const buf = term.buffer.active;
  if (data !== '\r') {
    if (s.typedFrom === null && buf.type === 'normal') {
      const line = buf.getLine(cursorRow(term))?.translateToString(false) ?? '';
      s.typedFrom = line.slice(0, buf.cursorX);
    }
    return;
  }
  const typedFrom = s.typedFrom;
  s.typedFrom = null;
  if (typedFrom === null || buf.type !== 'normal' || s.agent || s.shell === 'prompt') return;
  const row = cursorRow(term);
  const { start, text } = logicalLine(term, row);
  const input = (text.startsWith(typedFrom) ? text.slice(typedFrom.length) : text).trim();
  // Nothing visible was typed (a password prompt, a bare Enter).
  if (!input || input === typedFrom.trim()) return;
  const marker = term.registerMarker(start - row);
  const ref = ++lineRef;
  if (marker) s.pendingLines.set(ref, marker);
  window.api?.terminal?.noteInput?.(ptyId, input, ref);
}

// --- reach and jump -------------------------------------------------------------

/** Where an input can be shown: on screen now, one jump away, or nowhere. */
export type InputReach = 'screen' | 'jump' | 'out';

/** Visible rows of the active buffer, top to bottom. */
function screenRows(term: Terminal): string[] {
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let r = 0; r < term.rows; r++) {
    rows.push(buf.getLine(buf.viewportY + r)?.translateToString(true) ?? '');
  }
  return rows;
}

/**
 * The rows of the normal buffer (scrollback included) that could echo a
 * prompt (`❯ ` / `> ` after the indent), top to bottom: their buffer index
 * and their text with the indent trimmed. Read once per pass - a long
 * session's scrollback is thousands of rows and the list hundreds of
 * entries, and searching every row for every entry froze the list on each
 * pick.
 */
type PromptRows = { rows: number[]; texts: string[] };

function promptRows(term: Terminal): PromptRows {
  const buf = term.buffer.normal;
  const rows: number[] = [];
  const texts: string[] = [];
  for (let r = 0; r < buf.length; r++) {
    const text = (buf.getLine(r)?.translateToString(true) ?? '').trimStart();
    if (!text.startsWith('❯ ') && !text.startsWith('> ')) continue;
    rows.push(r);
    texts.push(text);
  }
  return { rows, texts };
}

/** The prompts sent after this one in the same agent run, newest first. */
function laterInRun(entries: InputEntry[], entry: InputEntry): string[] {
  return entries
    .filter((e) => e.kind === 'prompt' && e.seq > entry.seq && e.run === entry.run)
    .sort((a, b) => b.seq - a.seq)
    .map((e) => promptNeedle(e.text));
}

/** Later prompts whose first line matches this one's - the rows below it in the scrollback. */
function laterTwins(entries: InputEntry[], entry: InputEntry): number {
  const needle = promptNeedle(entry.text);
  return entries.filter(
    (e) => e.kind === 'prompt' && e.seq > entry.seq && promptNeedle(e.text) === needle,
  ).length;
}

/** `laterTwins` of every prompt at once, by seq - one pass instead of one per entry. */
function laterTwinsBySeq(entries: InputEntry[]): Map<number, number> {
  const out = new Map<number, number>();
  const seen = new Map<string, number>();
  const prompts = entries.filter((e) => e.kind === 'prompt').sort((a, b) => b.seq - a.seq);
  for (const e of prompts) {
    const needle = promptNeedle(e.text);
    const n = seen.get(needle) ?? 0;
    out.set(e.seq, n);
    seen.set(needle, n + 1);
  }
  return out;
}

/**
 * A full-screen agent still showing this prompt in its own scrolling view.
 * Whether that view can be WALKED is the program's (`canWalkAgentView`):
 * only Claude Code's is; another agent's prompt is on screen or out, and
 * never sent a key.
 */
function inAgentView(s: PtyInputs, term: Terminal, entry: InputEntry): boolean {
  return (
    entry.kind === 'prompt' && !entry.gone && s.agent && term.buffer.active.type === 'alternate'
  );
}

/** Rows of context kept above an input the view jumps to. */
const JUMP_CONTEXT_ROWS = 1;
/** How long a jumped-to input stays highlighted. */
const FLASH_MS = 1200;
/** Tallest highlight - a long command wraps, a prompt block can run on. */
const FLASH_MAX_ROWS = 8;

/** Where an input sits in the normal buffer: its first row, and how many rows to flash. */
type Place = { row: number; height: number };

/**
 * Where an input shows in the normal buffer, or null. A command or a line
 * sits at its marker. A Claude prompt sits at its echo, which is NOT where
 * its marker is: the hook marks the input box below it (promptRowAbove), and
 * flashing the marker lit up whatever the answer later wrote there. So the
 * marker only anchors a search upwards; without a marker (the tag left the
 * replay ring) the echo is looked for in the whole buffer. A marked prompt
 * whose echo is gone is still scrolled to, unflashed. `all` reads every row
 * of the buffer, once.
 */
function placeInBuffer(
  s: PtyInputs,
  term: Terminal,
  entry: InputEntry,
  twins: () => number,
  scan: () => PromptRows,
): Place | null {
  const buf = term.buffer.active;
  if (buf.type !== 'normal') return null;
  const pos = s.markers.get(entry.seq);
  const at = pos && !pos.start.isDisposed && pos.start.line >= 0 ? pos.start.line : -1;
  if (entry.kind !== 'prompt') {
    if (!pos || at === -1) return null;
    const end = pos.end && !pos.end.isDisposed ? pos.end.line : at + 1;
    return { row: at, height: end - at };
  }
  const needle = promptNeedle(entry.text);
  const row = (i: number): string => buf.getLine(i)?.translateToString(true) ?? '';
  // Up to the echo: the prompt's own rows (more when long lines wrapped) and
  // the live area between it and the input box - spinner, tips, a todo list.
  const { rows, texts } = scan();
  let echo = -1;
  if (at !== -1) {
    // promptRowAbove over the prompt rows only: the nearest at or above the mark.
    const span = entry.lines + 2 * term.rows;
    for (let i = rows.length - 1; i >= 0 && rows[i] >= at - span; i--) {
      if (rows[i] > at) continue;
      if (needle && isPromptRow(texts[i], needle)) {
        echo = rows[i];
        break;
      }
    }
  }
  if (echo === -1) {
    const i = findPromptRow(texts, needle, twins());
    if (i !== -1) echo = rows[i];
  }
  if (echo !== -1) {
    return { row: echo, height: promptEchoHeight(row, echo, entry.lines, FLASH_MAX_ROWS) };
  }
  return at === -1 ? null : { row: at, height: 0 };
}

/**
 * Where each entry can be shown, keyed by seq. Read once when the list opens
 * and after a jump - it scans the buffer for agent prompts, too costly per
 * render.
 */
export function inputReach(ptyId: string, entries: InputEntry[]): Map<number, InputReach> {
  const out = new Map<number, InputReach>();
  const s = ptys.get(ptyId);
  const term = s?.term;
  if (!s || !term) {
    for (const e of entries) out.set(e.seq, 'out');
    return out;
  }
  const top = term.buffer.active.viewportY;
  const bottom = top + term.rows;
  let screen: string[] | null = null;
  let message: string[] | null = null;
  let scanned: PromptRows | null = null;
  const scan = (): PromptRows => (scanned ??= promptRows(term));
  let twins: Map<number, number> | null = null;
  const twinsOf = (seq: number): number => (twins ??= laterTwinsBySeq(entries)).get(seq) ?? 0;
  for (const e of entries) {
    if (inAgentView(s, term, e)) {
      screen ??= screenRows(term);
      if (!message) {
        // promptOnClaudeScreen, with the message area worked out once.
        const { from, to } = messageArea(screen);
        message = screen.slice(from, to);
      }
      const needle = promptNeedle(e.text);
      const reach: InputReach = canWalkAgentView(e.program)
        ? findPromptRow(message, needle) !== -1
          ? 'screen'
          : 'jump'
        : // A view the walk cannot read: on screen or nowhere, never a jump.
          promptOnScreen(screen, needle)
          ? 'screen'
          : 'out';
      // On screen wins over an earlier miss (and clears it); a walk that
      // proved the view no longer holds it says so instead of trying again.
      if (reach === 'screen') s.unreachable.delete(e.seq);
      out.set(e.seq, reach === 'jump' && s.unreachable.has(e.seq) ? 'out' : reach);
      continue;
    }
    const place = placeInBuffer(s, term, e, () => twinsOf(e.seq), scan);
    out.set(
      e.seq,
      place === null ? 'out' : place.row >= top && place.row < bottom ? 'screen' : 'jump',
    );
  }
  return out;
}

/** Scroll the normal buffer to `row` and flash `height` rows from it (none for 0). */
function showRow(term: Terminal, row: number, height: number): void {
  term.scrollToLine(Math.max(0, row - JUMP_CONTEXT_ROWS));
  if (height <= 0) return;
  const marker = term.registerMarker(row - cursorRow(term));
  if (!marker) return;
  // The flash is a nicety: a terminal that cannot decorate still scrolled.
  let deco: ReturnType<Terminal['registerDecoration']>;
  try {
    deco = term.registerDecoration({
      marker,
      width: term.cols,
      height: Math.max(1, Math.min(height, FLASH_MAX_ROWS)),
      layer: 'top',
    });
    deco?.onRender((el) => el.classList.add('terminal-input-flash'));
  } catch {
    deco = undefined;
  }
  setTimeout(() => {
    deco?.dispose();
    marker.dispose();
  }, FLASH_MS);
}

/**
 * A full-screen agent's answer to a key: Claude Code draws a frame within a
 * few ms of the key and often a second one ~15 ms later (the pinned row
 * catching up), so the answer is complete once output paused for longer than
 * that gap. A key that changes nothing draws nothing at all.
 */
const FRAME_QUIET_MS = 40;
/** No output this long after a key: it drew nothing. */
const FRAME_IDLE_MS = 200;
/** Output that never pauses (an agent streaming) is read as it stands by then. */
const FRAME_CAP_MS = 600;

/** Resolves once the program has answered the last input (see FRAME_QUIET_MS). */
function settle(term: Terminal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(quiet);
      clearTimeout(cap);
      sub.dispose();
      resolve();
    };
    let quiet = setTimeout(done, FRAME_IDLE_MS);
    const cap = setTimeout(done, FRAME_CAP_MS);
    const sub = term.onWriteParsed(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, FRAME_QUIET_MS);
    });
  });
}

/**
 * Prompts in a run before an old one is walked to from the view's top: a
 * short conversation's view is a few pages either way.
 */
const TOP_WALK_FROM = 6;

/** Per pty: the jump in progress - a newer one makes an older walk stop. */
const jumps = new Map<string, number>();
let jumpN = 0;

/**
 * Bring an input into view: scroll the xterm to its marker (or, for an agent
 * prompt without one, the row that echoes it), or scroll a full-screen
 * agent's own view to it - Claude Code's only; another program's view is
 * never sent keys (`canWalkAgentView`). False when it cannot be shown.
 */
export async function jumpToInput(ptyId: string, entry: InputEntry): Promise<boolean> {
  const s = ptys.get(ptyId);
  const term = s?.term;
  if (!s || !term) return false;
  const jump = ++jumpN;
  jumps.set(ptyId, jump);
  const place = placeInBuffer(
    s,
    term,
    entry,
    () => laterTwins(s.entries, entry),
    () => promptRows(term),
  );
  if (place) {
    showRow(term, place.row, place.height);
    return true;
  }
  if (inAgentView(s, term, entry) && canWalkAgentView(entry.program)) {
    const send = (data: string): void => {
      // The repaint our input causes is not the agent working.
      suppressTerminalActivity(ptyId);
      window.api?.terminal?.write(ptyId, data);
    };
    const hold = holdFrame(term);
    const io = {
      screen: () => screenRows(term),
      write: send,
      // A press + release in the SGR encoding, 1-based.
      click:
        s.sgrMouse && term.modes.mouseTrackingMode !== 'none'
          ? (row: number, col: number) =>
              send(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`)
          : undefined,
      settle: async () => {
        await settle(term);
        hold.keep();
      },
      cancelled: () => jumps.get(ptyId) !== jump,
    };
    try {
      // An old prompt is nearer the view's top: walk down from there - only
      // for a first line no other prompt shares (twins are counted from the
      // bottom, where the view is complete).
      const needle = promptNeedle(entry.text);
      const run = s.entries.filter((e) => e.kind === 'prompt' && e.run === entry.run);
      const index = run.findIndex((e) => e.seq === entry.seq);
      const unique = run.filter((e) => promptNeedle(e.text) === needle).length === 1;
      const fromTop =
        unique && run.length >= TOP_WALK_FROM && index !== -1 && index < run.length / 2;
      let shown = fromTop ? await scrollClaudeFromTop(io, needle) : false;
      // A miss from the top (a CLI without Ctrl+Home, a frame mid-redraw) is
      // no proof: the walk from the bottom has the last word.
      if (!shown && jumps.get(ptyId) === jump) {
        shown = await scrollClaudeTo(io, needle, laterInRun(s.entries, entry));
      }
      // Walked the whole way without it (and not superseded): the view no
      // longer holds it - say so in the list instead of failing quietly.
      if (!shown && jumps.get(ptyId) === jump) s.unreachable.add(entry.seq);
      return shown;
    } finally {
      hold.release();
    }
  }
  return false;
}
