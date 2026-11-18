/**
 * An invisible copy of each Claude terminal's screen, kept where session
 * status and an extension's view over the tab read it: Claude's permission
 * mode, its plan dialog and the dialogs no hook reports (claude-screen.ts) -
 * here, not in a window's xterm, so every client (another window, a phone
 * later) gets the same reading.
 *
 * Fed by the terminal plumbing (terminal.ts): the snapshot a window's adopt
 * hands back (the replay ring + the mode preamble - a whole screen), every
 * live chunk after it, and every resize. Only terminals that speak the status
 * markers (claude-status-hooks.ts) are mirrored - a headless xterm parses
 * everything it is fed, and a plain shell's output is none of its business. Until a terminal shows a marker, its recent output is kept as
 * raw text (capped) to seed the mirror from once one appears.
 */
import * as xtermHeadless from '@xterm/headless';
import { STATUS_OSC } from '../claude-status-hooks';

// `@xterm/headless` is CommonJS: Node's ESM loader (the built main and the
// daemon) gives it no named exports, only `default` - a named import passes
// the tests and kills main at launch. Read it both ways.
const { Terminal } =
  (xtermHeadless as unknown as { default?: typeof xtermHeadless }).default ?? xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

/** Raw output kept per terminal (the pty host's replay budget). */
const TAIL_CAP = 256 * 1024;
const MARKER = `\u001b]${STATUS_OSC};`;

/**
 * Parse `data` into `term` now, in the caller's stack. xterm's public write
 * parses on its own timer, where a parser fault escapes as an uncaught
 * exception (crash report 157343098, v0.6.3: `print` reading a buffer row that was
 * not there) and leaves the write queue stuck for good - the mirror froze
 * and `settled` never resolved. The core's sync write throws to us instead.
 */
function parseNow(term: Terminal, data: string): void {
  const core = coreOf(term);
  if (core?.writeSync) core.writeSync(data);
  else term.write(data);
}

function coreOf(term: Terminal): { writeSync?: (data: string) => void } | undefined {
  return (term as unknown as { _core?: { writeSync?: (data: string) => void } })._core;
}

/** Parsed in the caller's stack: nothing is ever queued. */
function hasSyncWrite(term: Terminal): boolean {
  return typeof coreOf(term)?.writeSync === 'function';
}

type Entry = {
  cols: number;
  rows: number;
  /**
   * Raw output since the last snapshot (chunks, oldest first, bounded): what
   * a mirror starts from once a marker shows, and is rebuilt from after a
   * parser fault.
   */
  tail: string[];
  tailLength: number;
  term: Terminal | null;
  /** Mirrored once: a later adopt snapshot rebuilds the mirror whatever it holds. */
  mirrored: boolean;
};

export class ScreenMirrors {
  private readonly entries = new Map<string, Entry>();

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { cols: 80, rows: 24, tail: [], tailLength: 0, term: null, mirrored: false };
      this.entries.set(id, e);
    }
    return e;
  }

  /** A window adopted the terminal: its snapshot is the whole screen so far. */
  snapshot(id: string, data: string, cols: number, rows: number): void {
    const e = this.entry(id);
    e.cols = cols;
    e.rows = rows;
    e.term?.dispose();
    e.term = null;
    e.tail = [];
    e.tailLength = 0;
    // A Claude this mirrored before: rebuild from the snapshot even when its
    // ring no longer holds a marker (a few seconds of full repaints push them
    // out) - a waiting dialog sends none, and a view could not answer it.
    if (e.mirrored) {
      this.remember(e, data);
      this.start(e);
    } else this.feed(e, data);
  }

  /**
   * A view starts following the tab: mirror it from `snapshot` (the host's
   * ring + preamble) if it is not mirrored yet - a Claude whose markers left
   * the ring long ago is still a Claude.
   */
  follow(id: string, snapshot: { data: string; cols: number; rows: number }): void {
    const e = this.entry(id);
    // Mirrored at another size (started before the size was known): what
    // it parsed is garbled - start over from the snapshot.
    if (e.term && e.cols === snapshot.cols && e.rows === snapshot.rows) return;
    e.cols = snapshot.cols;
    e.rows = snapshot.rows;
    e.tail = [];
    e.tailLength = 0;
    this.remember(e, snapshot.data);
    this.start(e);
  }

  /**
   * A view starts following a terminal this holds no snapshot source for
   * (in-process): mirror it from its tail - the adopt snapshot and the
   * output since - if it is not mirrored yet.
   */
  followTail(id: string): void {
    const e = this.entries.get(id);
    if (!e || e.term) return;
    this.start(e);
  }

  data(id: string, data: string): void {
    this.feed(this.entry(id), data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (!(cols > 0 && rows > 0)) return;
    const e = this.entry(id);
    if (e.cols === cols && e.rows === rows) return;
    e.cols = cols;
    e.rows = rows;
    e.term?.resize(cols, rows);
  }

  forget(id: string): void {
    this.entries.get(id)?.term?.dispose();
    this.entries.delete(id);
  }

  /** The visible screen's lines (bottom screen, not scrollback); null when not mirrored. */
  lines(id: string): string[] | null {
    const term = this.entries.get(id)?.term;
    if (!term) return null;
    const buf = term.buffer.active;
    const out: string[] = [];
    for (let y = buf.baseY; y < buf.baseY + term.rows; y++) {
      out.push(buf.getLine(y)?.translateToString(true) ?? '');
    }
    return out;
  }

  /**
   * Resolves once everything fed so far is on the screen - at once: every
   * chunk is parsed in the caller's stack (`parseNow`). Never through xterm's
   * queued `write('', cb)`: its sync write drains the same queue, stops at
   * the falsy '' and leaves the callback to be cleared unrun - a prompt sent
   * awaiting it hung while the agent repainted, and the chunk behind it was
   * never parsed.
   */
  settled(id: string): Promise<void> {
    const term = this.entries.get(id)?.term;
    if (!term || hasSyncWrite(term)) return Promise.resolve();
    return new Promise((resolve) => term.write('', resolve));
  }

  private feed(e: Entry, data: string): void {
    // Look for the marker in the new data plus the end of the old (a marker
    // split across chunks) - never rescan the whole tail: busy shell output
    // would copy it on every chunk.
    const last = e.tail.at(-1) ?? '';
    this.remember(e, data);
    if (e.term) this.parse(e, data);
    else if ((last.slice(-(MARKER.length - 1)) + data).includes(MARKER)) this.start(e);
  }

  private remember(e: Entry, data: string): void {
    e.tail.push(data);
    e.tailLength += data.length;
    // Trimmed by whole chunks, and only once well past the cap.
    while (e.tailLength > TAIL_CAP * 2 && e.tail.length > 1) {
      e.tailLength -= e.tail.shift()!.length;
    }
  }

  /** Mirror a terminal (it speaks the markers) from its tail. */
  private start(e: Entry): void {
    e.term?.dispose();
    // logLevel off: the sync write warns on first use.
    e.term = new Terminal({
      cols: e.cols,
      rows: e.rows,
      scrollback: 0,
      allowProposedApi: true,
      logLevel: 'off',
    });
    e.mirrored = true;
    this.parse(e, e.tail.join(''), true);
  }

  /**
   * A parser fault costs the copy, never main: rebuild it from the tail, and
   * if the tail itself faults, go without one until the next snapshot or
   * marker (the tail is dropped so the same bytes are not parsed again).
   */
  private parse(e: Entry, data: string, seeding = false): void {
    try {
      parseNow(e.term!, data);
    } catch (err) {
      console.warn(`screen mirror: parser fault${seeding ? ' while seeding' : ''}:`, err);
      e.term?.dispose();
      e.term = null;
      if (seeding) {
        e.tail = [];
        e.tailLength = 0;
      } else this.start(e);
    }
  }
}
