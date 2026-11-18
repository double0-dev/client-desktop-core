import type { LaunchPlan } from './launch-plan';
import { TerminalModeTracker, type AgentStatus } from './terminal-modes';
import { TerminalInputLog, type InputEntry, type InputMark } from './terminal-inputs';
import { INPUT_OSC, MARKER_DIR_ENV } from './claude-status-hooks';
import { MARKER_POLL_MS, MarkerInbox } from './marker-inbox';
import { WindowsChildren } from './win-children';
import {
  CLOSE_GRACE_MS,
  CLOSE_TERM_GRACE_MS,
  FOREGROUND_LOOKUP_MS,
  systemReaper,
  type SessionReaper,
} from './session-reaper';
import {
  LAUNCH_ENV,
  LAUNCH_LINE,
  claimLaunchScript,
  LAUNCH_MARK_VERB,
  StartupTyper,
  TypedEchoHold,
  type StartupTyping,
} from './startup-typer';

/**
 * Everything a terminal is apart from its window: the pty, the replay ring,
 * the mode tracker, the input log, marker mode, the agent status and the
 * title. Pure node (no Electron) and transport-agnostic - main drives one
 * in-process through terminal-backend.ts, and the session daemon
 * (daemon/daemon-server.ts) drives the same class over a socket so terminals
 * outlive the app (a private plan).
 *
 * What stays OUT, in terminal.ts: which window owns a terminal, where its
 * output goes, the flush batching to the renderer, the launch-line adapters.
 * The host spawns exactly what it is told and reports what the stream says.
 */

/** The subset of node-pty's IPty the host drives. */
export type HostPty = {
  readonly cols: number;
  readonly rows: number;
  /** The foreground process name, as node-pty reports it. */
  readonly process: string;
  /** The shell's pid (Windows asks the OS for its children with it). */
  readonly pid?: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
};

export type PtySpawnOptions = {
  /** What node-pty sets TERM to. */
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
};

/** node-pty's `spawn`, or a fake in tests. Throws when the shell cannot start. */
export type PtySpawner = (file: string, args: string[], opts: PtySpawnOptions) => HostPty;

/** A spawn as main prepares it - the launch line is already built. */
export type HostSpawnRequest = {
  id: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** TERM. */
  name: string;
  cols: number;
  rows: number;
  /** Launched through an agent adapter with hooks in place (launch-plan.ts). */
  markerDriven: boolean;
  /** A start command, typed at the shell's first prompt (startup-typer.ts). */
  typeWhenReady?: StartupTyping;
  /**
   * A plain shell for a remote host (a private plan › M1):
   * the remote daemon picks the shell, the folder and the base env on its
   * own machine (daemon/remote-spawn.ts); `env` holds only the app's overlay.
   * Never set for a local spawn.
   */
  hostShell?: boolean;
  /**
   * A remote spawn's plan (a private plan › 7.3, 8):
   * the host's daemon materialises it on its own machine - the hook files,
   * the launch script, the resume pin - before spawning. Never set locally.
   */
  plan?: LaunchPlan;
};

/** What a client learns about a live terminal before adopting it. */
export type TerminalSummary = {
  id: string;
  cols: number;
  rows: number;
  markerDriven: boolean;
  agentStatus: AgentStatus;
  /**
   * The shell's pid, when the pty reports one (whose program listens on a
   * port, `localShellPids` in terminal.ts). Absent from an older daemon's
   * summaries.
   */
  pid?: number;
};

/** The replay a fresh xterm needs: the ring + the mode preamble, at this grid. */
export type TerminalSnapshot = { data: string; cols: number; rows: number };

export type HostEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }
  | { type: 'title'; id: string; title: string }
  | { type: 'inputs'; id: string; entries: InputEntry[] };

export type PtyHostOptions = {
  /** Replay budget per terminal, in bytes. Default 256 KB. */
  bufCap?: number;
  /** How long an adopted pty sits one row short before its size is restored. */
  adoptJiggleMs?: number;
  /** How long killed shells get on SIGHUP before `killAll` escalates to SIGKILL. */
  killGraceMs?: number;
  /** The clock (input entries are stamped with it). */
  now?: () => number;
  /**
   * Whether a shell has a program running, asked of the OS (win-children.ts):
   * Windows' pty names only the process it spawned. Defaults to the
   * PowerShell probe on Windows, none elsewhere.
   */
  shellBusy?: ((pid: number) => Promise<boolean>) | null;
  /** How often a marker folder is read (marker-inbox.ts). */
  markerPollMs?: number;
  /**
   * Ends what a closed tab left running (session-reaper.ts). Defaults to the
   * system one off Windows; null turns it off.
   */
  reaper?: SessionReaper | null;
  /** How long a closed tab's shell and foreground program get on SIGHUP. */
  closeGraceMs?: number;
  /** Then: how long what is left gets on SIGTERM before SIGKILL. */
  closeTermGraceMs?: number;
};

/** Replay budget per terminal. node-pty emits decoded strings; trim whole chunks. */
export const DEFAULT_BUF_CAP = 256 * 1024;

/**
 * How long an adopted PTY sits one row short before its size is restored. The
 * shrink+restore pair delivers two real SIGWINCHes, which makes a full-screen
 * TUI redraw every visible row - the same trick (and duration) as the
 * renderer's tone-flip jiggle (see repaintTuisOnToneFlip in pool.ts).
 */
export const ADOPT_REPAINT_JIGGLE_MS = 80;

/** How long killed shells get to exit on SIGHUP before quit escalates to SIGKILL. */
export const QUIT_KILL_GRACE_MS = 750;

/** Longest line a client may report as an input (it reads one screen line). */
export const MAX_NOTED_LINE = 4096;

// Foreground process names that mean "just an idle shell prompt" (not a running
// program). Used to tell an idle terminal from one with an agent/command running.
const SHELL_NAMES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'ash',
  'nu',
  'xonsh',
  'elvish',
  'pwsh',
  'powershell',
  'powershell.exe',
  'cmd',
  'cmd.exe',
]);

type Hosted = {
  pty: HostPty;
  /** Recent output, replayed verbatim when a fresh xterm adopts the terminal. */
  buf: string[];
  bufBytes: number;
  /**
   * Terminal private-mode state (alt screen, bracketed paste, mouse, focus
   * reporting, …), tracked across the WHOLE output history. The ring buffer
   * above only holds the tail - a TUI's mode setup is long trimmed out of it -
   * so an adoption replay appends `modes.preamble()` to re-assert the true
   * state in the adopter's fresh xterm (see terminal-modes.ts).
   */
  modes: TerminalModeTracker;
  /** Every input this pty was given, for the status bar's Inputs list. */
  inputs: TerminalInputLog;
  /**
   * Pending restore of the adopt-repaint jiggle (see scheduleAdoptRepaint) -
   * cancelled the moment a real resize arrives, whose size is authoritative
   * over the jiggle's captured one.
   */
  adoptRestore: ReturnType<typeof setTimeout> | null;
  /**
   * The grid a pending jiggle will restore to. Reported by `size` instead of
   * the live one, so a renderer checking the xterm↔PTY invariant mid-jiggle
   * doesn't read the momentary rows−1 as a divergence and "heal" a terminal
   * that is already in agreement.
   */
  restoreSize?: { cols: number; rows: number };
  /** Launched through an agent adapter: markers from the start. */
  markerDriven: boolean;
  /** The start command still waiting for the first prompt, if any. */
  typer: StartupTyper | null;
  /** The echo of a typed launch line, held off the screen (startup-typer.ts). */
  echo: TypedEchoHold | null;
  /** Windows: the folder the agent's hooks leave their markers in (marker-inbox.ts). */
  inbox: { box: MarkerInbox; timer: ReturnType<typeof setInterval>; pending: string } | null;
};

/**
 * The DECSET-2031 colour-scheme notification for the current tone. Sent as PTY
 * INPUT to a program that enabled 2031 (Claude Code under theme "auto"): it then
 * re-queries the background (OSC 11) and re-picks its light/dark palette. xterm
 * never emits this, so without it a terminal-theme flip keeps the stale palette.
 * `1` = dark, `2` = light. Claude Code ignores the push while its own colour
 * query is still unanswered (probed, v2.1.278) - see `adopt` for that case.
 */
/** The zsh integration's mark before every prompt (shell-integration.ts). */
function isPromptMark(mark: InputMark): boolean {
  return mark.code === INPUT_OSC && mark.verb === 'ps';
}

/** The zsh integration ran the tab's launch script itself (shell-integration.ts). */
function isLaunchMark(mark: InputMark): boolean {
  return mark.code === INPUT_OSC && mark.verb === LAUNCH_MARK_VERB;
}

export function colorSchemeInput(dark: boolean): string {
  return `\x1b[?997;${dark ? 1 : 2}n`;
}

export class PtyHost {
  private readonly terminals = new Map<string, Hosted>();
  private readonly listeners = new Set<(ev: HostEvent) => void>();
  /**
   * Every spawned PTY whose exit node-pty hasn't reported yet, with a promise
   * that settles when it does. `killAll` waits on these before the process
   * shuts down: node-pty delivers a shell's exit from its watcher thread into
   * JS, and one that lands while Node's environment is tearing down can't call
   * into JS - its addon then throws a C++ Napi::Error nothing catches and the
   * process aborts (crash report 149155736, "uncaught exception of type Napi::Error").
   * Kept apart from `terminals`: a kill removes a terminal from that map the
   * moment it is signalled, long before its shell is actually gone.
   */
  private readonly unexited = new Map<HostPty, Promise<void>>();
  /**
   * The terminal's current light/dark tone, as the client last reported it.
   * Only used to send a semantically-correct colour-scheme push; the tone a
   * program actually adopts comes from the OSC 11 answer its xterm gives when
   * the push makes it re-query, so an out-of-date value here only costs a
   * needless re-detect, never a wrong palette. Dark (the app default) before
   * the first report.
   */
  private toneDark = true;
  private readonly bufCap: number;
  private readonly adoptJiggleMs: number;
  private readonly killGraceMs: number;
  private readonly now: () => number;
  private readonly shellBusy: ((pid: number) => Promise<boolean>) | null;
  private readonly markerPollMs: number;
  private readonly reaper: SessionReaper | null;
  private readonly closeGraceMs: number;
  private readonly closeTermGraceMs: number;

  constructor(
    private readonly spawner: PtySpawner,
    opts: PtyHostOptions = {},
  ) {
    this.bufCap = opts.bufCap ?? DEFAULT_BUF_CAP;
    this.adoptJiggleMs = opts.adoptJiggleMs ?? ADOPT_REPAINT_JIGGLE_MS;
    this.killGraceMs = opts.killGraceMs ?? QUIT_KILL_GRACE_MS;
    this.now = opts.now ?? Date.now;
    this.markerPollMs = opts.markerPollMs ?? MARKER_POLL_MS;
    this.reaper = opts.reaper === undefined ? systemReaper() : opts.reaper;
    this.closeGraceMs = opts.closeGraceMs ?? CLOSE_GRACE_MS;
    this.closeTermGraceMs = opts.closeTermGraceMs ?? CLOSE_TERM_GRACE_MS;
    if (opts.shellBusy !== undefined) this.shellBusy = opts.shellBusy;
    else if (process.platform === 'win32') {
      const children = new WindowsChildren();
      this.shellBusy = (pid) => children.busy(pid);
    } else this.shellBusy = null;
  }

  onEvent(listener: (ev: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: HostEvent): void {
    for (const l of this.listeners) l(ev);
  }

  get count(): number {
    return this.terminals.size;
  }

  has(id: string): boolean {
    return this.terminals.has(id);
  }

  ids(): string[] {
    return [...this.terminals.keys()];
  }

  list(): TerminalSummary[] {
    return [...this.terminals].map(([id, t]) => ({
      id,
      cols: t.pty.cols,
      rows: t.pty.rows,
      markerDriven: this.isMarkerDriven(t),
      agentStatus: t.modes.agentStatus,
      ...(t.pty.pid !== undefined && t.pty.pid > 0 ? { pid: t.pty.pid } : {}),
    }));
  }

  /**
   * Spawn a terminal. False when the shell could not start (the caller
   * reports an exit) or the id is already live.
   */
  spawn(req: HostSpawnRequest): boolean {
    if (this.terminals.has(req.id)) return false;
    // A new shell starts with an empty marker folder - only here: a launch
    // that re-adopts a live terminal must keep its undrained markers.
    const markerDir = req.env[MARKER_DIR_ENV];
    const box = markerDir ? new MarkerInbox(markerDir) : null;
    box?.reset();
    let pty: HostPty;
    try {
      pty = this.spawner(req.file, req.args, {
        name: req.name,
        cols: req.cols > 0 ? req.cols : 80,
        rows: req.rows > 0 ? req.rows : 24,
        cwd: req.cwd,
        env: req.env,
      });
    } catch {
      return false;
    }
    this.unexited.set(
      pty,
      new Promise<void>((resolve) => {
        pty.onExit(() => {
          this.unexited.delete(pty);
          resolve();
        });
      }),
    );
    const t: Hosted = {
      pty,
      buf: [],
      bufBytes: 0,
      modes: new TerminalModeTracker(),
      inputs: new TerminalInputLog(),
      adoptRestore: null,
      markerDriven: req.markerDriven,
      typer: null,
      echo: null,
      inbox: null,
    };
    const output = (raw: string): void => {
      const cur = this.terminals.get(req.id);
      if (cur !== t) return;
      cur.modes.feed(raw);
      const marks = cur.modes.takeInputMarks();
      if (cur.typer && marks.some(isLaunchMark)) {
        // The shell runs the start command itself: typing it too would land
        // in the program it started.
        cur.typer.dispose();
        cur.typer = null;
      }
      cur.typer?.output(marks.some(isPromptMark));
      // Input marks the tracker just walked past become entries of the
      // Inputs list, and each gets a position tag spliced in right behind its
      // mark - the adopter's replay rebuilds the xterm markers from the ring.
      const data = this.recordInputs(req.id, cur, raw, marks);
      this.pushBuf(cur, data);
      // Title reports (OSC 0/2) the tracker just walked past - e.g. Claude Code
      // summarizing its current task. Rare and tiny; the session auto-namer
      // listens.
      const title = cur.modes.takeTitle();
      if (title !== null) this.emit({ type: 'title', id: req.id, title });
      this.emit({ type: 'data', id: req.id, data });
      // Markers that came while the program was mid-sequence go in now.
      if (cur.inbox?.pending && cur.modes.atGround) {
        const marks = cur.inbox.pending;
        cur.inbox.pending = '';
        output(marks);
      }
    };
    const typing = req.typeWhenReady;
    if (typing) {
      t.typer = new StartupTyper(typing, (text) => {
        t.typer = null;
        if (this.terminals.get(req.id) !== t) return;
        // A launch script runs once: typed only when the shell has not taken
        // it already (startup-typer.ts › claimLaunchScript).
        const script = typing.line === LAUNCH_LINE ? req.env[LAUNCH_ENV] : undefined;
        if (script && !claimLaunchScript(script)) return;
        try {
          t.pty.write(text);
        } catch {
          // Shell exited before the command could run.
          return;
        }
        // A launch script announces itself, so the echo of the line that
        // sources it can be told from the program's output and kept back.
        if (typing.line === LAUNCH_LINE) t.echo = new TypedEchoHold(output);
      });
    }
    this.terminals.set(req.id, t);
    if (box) {
      let draining = false;
      const timer = setInterval(() => {
        if (draining) return;
        draining = true;
        void box.drain().then((marks) => {
          draining = false;
          if (!marks || this.terminals.get(req.id) !== t || !t.inbox) return;
          if (t.modes.atGround && !t.inbox.pending) output(marks);
          else t.inbox.pending += marks;
        });
      }, this.markerPollMs);
      timer.unref?.();
      t.inbox = { box, timer, pending: '' };
    }

    pty.onData((raw) => {
      if (!t.echo) return output(raw);
      const shown = t.echo.take(raw);
      if (t.echo.done) t.echo = null;
      if (shown !== '') output(shown);
    });
    pty.onExit(({ exitCode }) => {
      const cur = this.terminals.get(req.id);
      if (cur !== t) return;
      this.terminals.delete(req.id);
      this.clearJiggle(cur);
      this.stopTyper(cur);
      this.stopInbox(cur);
      this.emit({ type: 'exit', id: req.id, exitCode });
    });
    return true;
  }

  /**
   * A fresh xterm attaches: unblock the pty (its previous client may have
   * left it paused), hand back the replay at the live grid, make the
   * foreground TUI repaint, and tell a tone-aware program the current tone.
   */
  /**
   * The screen so far - the replay ring plus the mode preamble, at the live
   * grid - WITHOUT what an adopt does to the terminal (no repaint jiggle, no
   * tone push): a reader, not a window attaching (a view's screen copy,
   * agent-screen/screen-mirror.ts).
   */
  peek(id: string): TerminalSnapshot | null {
    const t = this.terminals.get(id);
    if (!t) return null;
    return { data: t.buf.join('') + t.modes.preamble(), cols: t.pty.cols, rows: t.pty.rows };
  }

  adopt(id: string): TerminalSnapshot | null {
    const t = this.terminals.get(id);
    if (!t) return null;
    // The previous owner may have died while it held the PTY flow-paused; the
    // adopter starts with an empty write queue, so unblock.
    try {
      t.pty.resume();
    } catch {
      // Shell already gone - the exit handler will tell the new owner.
    }
    // The ring's tail re-applies whatever mode changes it still contains; the
    // appended preamble then corrects every tracked mode whose setup was trimmed
    // out of the ring - without it the adopter's xterm sits at mode DEFAULTS
    // (no alt screen / bracketed paste / mouse / focus reporting) while the
    // program believes they're set, which is what garbled a long-running
    // Claude Code's input box and broke paste after every re-adopt.
    //
    // A program's own terminal QUERIES in the ring are replayed too, on purpose:
    // the adopter's fresh xterm answers them into the live pty. That is the only
    // answer an eager conversation pty ever gets - launchSession spawns it before
    // its tab listens, so Claude Code's startup `OSC 11 ; ?` + DA1 reach no xterm
    // and it sits undecided on its dark fallback. It still accepts the late
    // answer and switches palette; an answer to a query it has long since settled
    // is ignored, never typed into the prompt (both probed, v2.1.278 - see
    // scripts/probe-claude-theme.py `late-light` / `unsolicited`).
    const snapshot = {
      data: t.buf.join('') + t.modes.preamble(),
      cols: t.pty.cols,
      rows: t.pty.rows,
    };
    this.scheduleAdoptRepaint(id, t);
    // A fresh xterm has just attached. If the program detects light/dark tone
    // (DECSET 2031) - Claude Code does - tell it the current tone now: one that
    // settled on the OTHER tone (a flip it missed while no xterm answered its
    // re-query, a reload across a flip) stays wrong until something makes it
    // re-check. The re-query is answered by this now-attached xterm from the live
    // theme, so the tone it lands on is right whatever `toneDark` says. A program
    // still waiting on its startup query ignores this push; the replay above
    // answers that query instead.
    this.pushColorScheme(t);
    return snapshot;
  }

  input(id: string, data: string): void {
    const t = this.terminals.get(id);
    if (!t) return;
    try {
      // Writing to a PTY whose shell has exited throws a native (Napi) error.
      t.pty.write(data);
    } catch {
      this.fail(id, t);
      return;
    }
    t.modes.noteInput(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terminals.get(id);
    if (!t || cols <= 0 || rows <= 0) return;
    // A real renderer refit supersedes a pending adopt-jiggle restore - firing
    // it after this could stomp a fitted size that happens to equal the
    // jiggled one (see scheduleAdoptRepaint).
    this.clearJiggle(t);
    try {
      t.pty.resize(cols, rows);
    } catch {
      this.fail(id, t);
    }
  }

  pause(id: string): void {
    const t = this.terminals.get(id);
    if (!t) return;
    try {
      t.pty.pause();
    } catch {
      this.fail(id, t);
    }
  }

  resume(id: string): void {
    const t = this.terminals.get(id);
    if (!t) return;
    try {
      t.pty.resume();
    } catch {
      this.fail(id, t);
    }
  }

  /** Every pty flows again - the client that paused one is gone. */
  resumeAll(): void {
    for (const id of [...this.terminals.keys()]) this.resume(id);
  }

  /**
   * Kill a terminal and forget it at once (a tab close). Its exit is not
   * reported - the caller asked for it; `killAll` still waits for it. The
   * shell gets SIGHUP once the terminal's foreground group is known (at most
   * FOREGROUND_LOOKUP_MS later), and what is still there once the grace
   * period has passed is ended (`reapClosed`).
   */
  kill(id: string): void {
    const t = this.terminals.get(id);
    if (!t) return;
    this.terminals.delete(id);
    this.clearJiggle(t);
    this.stopTyper(t);
    this.stopInbox(t);
    const { pty } = t;
    let hungUp = false;
    const hangUp = (): boolean => {
      if (hungUp) return false;
      hungUp = true;
      try {
        pty.kill();
      } catch {
        // Process may already be gone.
      }
      return true;
    };
    const reaper = this.reaper;
    const sid = pty.pid;
    if (!reaper || !sid) {
      hangUp();
      return;
    }
    // Read before the hangup: afterwards the OS no longer says which group
    // was in the foreground (session-reaper.ts).
    const cap = setTimeout(hangUp, FOREGROUND_LOOKUP_MS);
    void reaper
      .foregroundGroup(sid)
      .catch(() => null)
      .then((pgid) => {
        clearTimeout(cap);
        // A lookup slower than the cap read the group after the hangup: unusable.
        const group = hangUp() && pgid !== sid ? pgid : null;
        this.reapClosed(pty, reaper, group);
      });
  }

  /**
   * After `closeGraceMs`: SIGKILL a shell that ignored the SIGHUP, and SIGTERM
   * the terminal's foreground group if anything of it is still alive (the
   * agent that did not leave on the hangup, its stuck hooks);
   * `closeTermGraceMs` later SIGKILL that group if it ignored the TERM too.
   * Each signal first checks the group is still the closed shell's
   * (`stillOurs`): its id may have been handed on once its members left.
   * The timers never hold a process open.
   */
  private reapClosed(pty: HostPty, reaper: SessionReaper, pgid: number | null): void {
    const sid = pty.pid;
    if (!sid) return;
    const later = (ms: number, fn: () => void) => setTimeout(fn, ms).unref?.();
    later(this.closeGraceMs, () => {
      if (this.unexited.has(pty)) {
        try {
          pty.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
      if (pgid === null) return;
      void reaper.stillOurs(pgid, sid).then((ours) => {
        if (!ours) return;
        reaper.signalGroup(pgid, 'SIGTERM');
        later(this.closeTermGraceMs, () => {
          void reaper.stillOurs(pgid, sid).then((still) => {
            if (still) reaper.signalGroup(pgid, 'SIGKILL');
          });
        });
      });
    });
  }

  /**
   * The light/dark tone changed (or its first report): remember it and nudge
   * every program that asked for colour-scheme notifications to re-detect -
   * the one flip case xterm.js cannot deliver on its own.
   */
  setTone(dark: boolean): void {
    this.toneDark = dark;
    for (const t of this.terminals.values()) this.pushColorScheme(t);
  }

  /**
   * The PTY's real grid, for the renderer's xterm↔PTY invariant check. While
   * an adopt jiggle is pending, the size it will restore to rather than the
   * momentary rows−1 - that shrink is not a divergence.
   */
  size(id: string): { cols: number; rows: number } | null {
    const t = this.terminals.get(id);
    if (!t) return null;
    if (t.adoptRestore && t.restoreSize) return { ...t.restoreSize };
    return { cols: t.pty.cols, rows: t.pty.rows };
  }

  /**
   * Whether a program (not the idle shell prompt) is in the foreground. On
   * Windows the pty only ever names the shell it spawned, so the OS is asked
   * whether the shell has a child (`shellBusy`).
   */
  async foregroundBusy(id: string): Promise<boolean> {
    const t = this.terminals.get(id);
    if (!t) return false;
    if (this.shellBusy) {
      const pid = t.pty.pid;
      return pid !== undefined && pid > 0 ? this.shellBusy(pid).catch(() => false) : false;
    }
    const name = (t.pty.process || '').replace(/^-/, '').toLowerCase();
    return name.length > 0 && !SHELL_NAMES.has(name);
  }

  /**
   * Marker-driven as far as the stream knows: what it has shown wins (a
   * marker proves the hooks, 'ended' retires them), else what the launch
   * promised.
   */
  markerDriven(id: string): boolean {
    const t = this.terminals.get(id);
    return t ? this.isMarkerDriven(t) : false;
  }

  /** What the markers say the agent is doing; null for a terminal without the protocol. */
  agentStatus(id: string): AgentStatus | null {
    const t = this.terminals.get(id);
    return t && this.isMarkerDriven(t) ? t.modes.agentStatus : null;
  }

  inputList(id: string): InputEntry[] {
    return this.terminals.get(id)?.inputs.list() ?? [];
  }

  /**
   * A line the renderer read off the screen when Enter was pressed in a
   * program that reports nothing itself (a REPL, a shell without the
   * integration). The foreground process names it; its tag goes into the
   * ring only - the reporting xterm already placed its own marker - and only
   * between sequences, never inside one the program is still writing.
   */
  noteLine(id: string, text: string, ref: number): void {
    const t = this.terminals.get(id);
    if (!t || text.length > MAX_NOTED_LINE || !Number.isSafeInteger(ref)) return;
    const program = (t.pty.process || '').split('/').pop()?.replace(/^-/, '') || 'terminal';
    const { entry, tag } = t.inputs.addLine(text, program, this.now(), ref);
    if (!entry) return;
    if (t.modes.atGround) this.pushBuf(t, tag);
    this.emit({ type: 'inputs', id, entries: [entry] });
  }

  /**
   * Kill every terminal and settle once every killed shell has reported its
   * exit (see `unexited`). A shell still running after the grace period - one
   * that ignores SIGHUP - gets SIGKILL, which can't be ignored, so its exit
   * follows promptly. Only the shell's own pid is signalled: its children (a
   * `claude`) still get the SIGHUP of the tty hanging up, never a SIGKILL. The
   * caller caps the whole wait (quit-sequence.ts).
   */
  async killAll(): Promise<void> {
    for (const id of [...this.terminals.keys()]) this.kill(id);
    if (this.unexited.size === 0) return;
    const all = Promise.all(this.unexited.values()).then(() => undefined);
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      all,
      new Promise<void>((r) => {
        grace = setTimeout(r, this.killGraceMs);
      }),
    ]);
    clearTimeout(grace);
    for (const pty of this.unexited.keys()) {
      try {
        pty.kill('SIGKILL');
      } catch {
        // Already gone, or Windows (no signals) - nothing more to do.
      }
    }
    await all;
  }

  // --- internals ---------------------------------------------------------------

  private isMarkerDriven(t: Hosted): boolean {
    return t.modes.markerDriven ?? t.markerDriven;
  }

  private pushBuf(t: Hosted, data: string): void {
    t.buf.push(data);
    t.bufBytes += Buffer.byteLength(data);
    while (t.bufBytes > this.bufCap && t.buf.length > 1) {
      t.bufBytes -= Buffer.byteLength(t.buf.shift()!);
    }
  }

  /**
   * Apply the input marks `feed` just completed to the pty's input log (see
   * terminal-inputs.ts): returns the chunk with the position tags spliced in,
   * and reports every entry that was added or changed.
   */
  private recordInputs(id: string, t: Hosted, chunk: string, marks: InputMark[]): string {
    if (marks.length === 0) return chunk;
    const { data, changed } = t.inputs.apply(chunk, marks, this.now());
    if (changed.length > 0) this.emit({ type: 'inputs', id, entries: changed });
    return data;
  }

  /** The shell is gone: a start command still waiting is never typed. */
  private stopTyper(t: Hosted): void {
    t.typer?.dispose();
    t.typer = null;
    t.echo?.dispose();
    t.echo = null;
  }

  /** The terminal is gone: stop reading its marker folder and remove it. */
  private stopInbox(t: Hosted): void {
    if (!t.inbox) return;
    clearInterval(t.inbox.timer);
    void t.inbox.box.dispose();
    t.inbox = null;
  }

  /**
   * A PTY operation threw (the shell process is gone): tear the terminal down
   * and report an exit, so the renderer tab shows it instead of going silent.
   */
  private fail(id: string, t: Hosted): void {
    if (this.terminals.get(id) !== t) return;
    this.kill(id);
    this.emit({ type: 'exit', id, exitCode: -1 });
  }

  /**
   * Tell a program that asked for colour-scheme notifications (DECSET 2031) the
   * current tone, so it re-detects. A no-op for anything that did not enable
   * 2031 - never write the sequence to a plain shell, where it would land as
   * stray keystrokes at the prompt.
   */
  private pushColorScheme(t: Hosted): void {
    if (!t.modes.reportsColorScheme) return;
    try {
      t.pty.write(colorSchemeInput(this.toneDark));
    } catch {
      // Shell already gone - the exit handler will tell the owner.
    }
  }

  private clearJiggle(t: Hosted): void {
    if (t.adoptRestore) {
      clearTimeout(t.adoptRestore);
      t.adoptRestore = null;
    }
    t.restoreSize = undefined;
  }

  /**
   * Make a re-adopted shell's foreground TUI repaint its whole screen. A replay
   * reproduces the ring buffer's tail, but that tail can start mid-frame (the
   * ring trims whole chunks) and for a long-running TUI the screen-setup
   * sequences are long gone - so the replayed screen may be incomplete. The
   * program itself doesn't know anything happened (its pty never changed), so
   * nothing would ever redraw it. A rows−1 → rows resize pair forces exactly
   * that. The restore is cancelled outright when a real resize arrives
   * meanwhile (see `resize`): that refit is authoritative, and a size check
   * alone can't tell a refit that legitimately landed on rows−1 from "nothing
   * happened" - restoring over it would leave the PTY one row taller than the
   * xterm for good, garbling the TUI's bottom rows on every frame.
   */
  private scheduleAdoptRepaint(id: string, t: Hosted): void {
    this.clearJiggle(t);
    const { cols, rows } = t.pty;
    if (rows <= 1) return;
    try {
      t.pty.resize(cols, rows - 1);
    } catch {
      // Shell already gone - the exit handler will tell the new owner.
      return;
    }
    t.restoreSize = { cols, rows };
    t.adoptRestore = setTimeout(() => {
      t.adoptRestore = null;
      t.restoreSize = undefined;
      const cur = this.terminals.get(id);
      if (cur !== t || cur.pty.cols !== cols || cur.pty.rows !== rows - 1) return;
      try {
        cur.pty.resize(cols, rows);
      } catch {
        // Shell exited mid-jiggle - the exit handler already notified the owner.
      }
    }, this.adoptJiggleMs);
  }
}
