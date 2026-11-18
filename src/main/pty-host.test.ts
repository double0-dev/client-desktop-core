import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionReaper } from './session-reaper';
import {
  PtyHost,
  colorSchemeInput,
  type HostEvent,
  type HostPty,
  type HostSpawnRequest,
  type PtySpawnOptions,
} from './pty-host';
import {
  AFTER_PROMPT_QUIET_MS,
  LAUNCH_LINE,
  MAX_WAIT_MS,
  UNMARKED_QUIET_MS,
} from './startup-typer';

/**
 * The terminal host apart from any window or socket: what the replay carries,
 * how an adopt repaints, what the stream teaches it, and the quit wait. The
 * same class runs in-process and inside the session daemon.
 */

type FakePty = HostPty & {
  file: string;
  args: string[];
  opts: PtySpawnOptions;
  emit: (data: string) => void;
  exit: (code: number) => void;
  written: string[];
  resizes: Array<[number, number]>;
  killed: Array<string | undefined>;
  paused: number;
  resumed: number;
  /** Make every write / resize throw, as node-pty does once the shell is gone. */
  dead: boolean;
  process: string;
};

function fakeSpawner(): {
  spawn: (f: string, a: string[], o: PtySpawnOptions) => FakePty;
  ptys: FakePty[];
} {
  const ptys: FakePty[] = [];
  const spawn = (file: string, args: string[], opts: PtySpawnOptions): FakePty => {
    if (file === 'nope') throw new Error('spawn failed');
    let dataCb: (d: string) => void = () => {};
    const exitCbs: Array<(e: { exitCode: number }) => void> = [];
    const pty: FakePty = {
      file,
      args,
      opts,
      cols: opts.cols,
      rows: opts.rows,
      process: 'zsh',
      pid: 4242,
      dead: false,
      written: [],
      resizes: [],
      killed: [],
      paused: 0,
      resumed: 0,
      onData: (cb) => {
        dataCb = cb;
      },
      onExit: (cb) => {
        exitCbs.push(cb);
      },
      emit: (d) => dataCb(d),
      exit: (code) => {
        for (const cb of exitCbs) cb({ exitCode: code });
      },
      write: (d) => {
        if (pty.dead) throw new Error('EIO');
        pty.written.push(d);
      },
      resize: (c, r) => {
        if (pty.dead) throw new Error('EIO');
        pty.resizes.push([c, r]);
        (pty as { cols: number }).cols = c;
        (pty as { rows: number }).rows = r;
      },
      kill: (signal) => {
        pty.killed.push(signal);
      },
      pause: () => {
        pty.paused++;
      },
      resume: () => {
        pty.resumed++;
      },
    };
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys };
}

const req = (id: string, extra: Partial<HostSpawnRequest> = {}): HostSpawnRequest => ({
  id,
  file: '/bin/zsh',
  args: [],
  cwd: '/tmp',
  env: { TERM: 'xterm-256color' },
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  markerDriven: false,
  ...extra,
});

function setup(opts: ConstructorParameters<typeof PtyHost>[1] = {}) {
  const { spawn, ptys } = fakeSpawner();
  const host = new PtyHost(spawn, {
    adoptJiggleMs: 80,
    killGraceMs: 750,
    // The OS is never asked from a test (the Windows default).
    shellBusy: null,
    // Nor signalled: a tab close's reaper is opted into per test.
    reaper: null,
    ...opts,
  });
  const events: HostEvent[] = [];
  host.onEvent((ev) => events.push(ev));
  return { host, ptys, events };
}

afterEach(() => vi.useRealTimers());

describe('spawning', () => {
  it('spawns what it is told and reports a shell that cannot start', () => {
    const { host, ptys } = setup();
    expect(host.spawn(req('a', { args: ['-i', '-c', 'claude; exec /bin/zsh'] }))).toBe(true);
    expect(ptys[0].file).toBe('/bin/zsh');
    expect(ptys[0].args).toEqual(['-i', '-c', 'claude; exec /bin/zsh']);
    expect(ptys[0].opts).toMatchObject({
      cols: 120,
      rows: 40,
      cwd: '/tmp',
      name: 'xterm-256color',
    });
    expect(host.spawn(req('b', { file: 'nope' }))).toBe(false);
    // A second spawn under a live id is refused rather than replacing the shell.
    expect(host.spawn(req('a'))).toBe(false);
    // The shell's pid rides along: main asks whose program listens on a port.
    expect(host.list()).toEqual([
      { id: 'a', cols: 120, rows: 40, markerDriven: false, agentStatus: 'idle', pid: 4242 },
    ]);
  });

  it('falls back to 80x24 for a missing grid', () => {
    const { host, ptys } = setup();
    host.spawn(req('a', { cols: 0, rows: -1 }));
    expect(ptys[0].opts).toMatchObject({ cols: 80, rows: 24 });
  });

  it("types a start command just after the shell's first prompt mark", () => {
    vi.useFakeTimers();
    const { host, ptys } = setup();
    host.spawn(req('a', { typeWhenReady: { line: 'claude-personal', promptMarks: true } }));
    // The rc's own output, however slow, is not the prompt.
    ptys[0].emit('Last login: Thu Oct  8\r\n');
    vi.advanceTimersByTime(1000);
    expect(ptys[0].written).toEqual([]);
    // The mark comes before the prompt it announces: wait for that to be drawn.
    ptys[0].emit('\x1b]6791;ps\x07');
    ptys[0].emit('~/acme » ');
    vi.advanceTimersByTime(AFTER_PROMPT_QUIET_MS - 1);
    expect(ptys[0].written).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ptys[0].written).toEqual(['claude-personal\r']);
    // Once only: the next prompts are the user's.
    ptys[0].emit('\x1b]6791;ps\x07~/acme » ');
    vi.advanceTimersByTime(MAX_WAIT_MS);
    expect(ptys[0].written).toEqual(['claude-personal\r']);
  });

  it('types nothing once the shell says it runs the start command itself', () => {
    // The zsh integration sources the launch script from its first precmd, so
    // a new tab never shows the launch line. Typing it as well would send the
    // line into the program the script just started.
    vi.useFakeTimers();
    const { host, ptys } = setup();
    host.spawn(req('a', { typeWhenReady: { line: ' . "$DOUBLE0_LAUNCH"', promptMarks: true } }));
    ptys[0].emit('Last login: Thu Oct  8\r\n');
    ptys[0].emit('\x1b]6791;launch\x07');
    ptys[0].emit('agent frame');
    vi.advanceTimersByTime(MAX_WAIT_MS * 2);
    // Not at the prompt that follows the program's exit either.
    ptys[0].emit('\x1b]6791;ps\x07~/acme » ');
    vi.advanceTimersByTime(MAX_WAIT_MS);
    expect(ptys[0].written).toEqual([]);
  });

  it('keeps the typed launch line off the screen, whatever the shell', () => {
    // bash, sh, a zsh whose rc dropped the integration: the line that sources
    // the launch script is typed, and a new tab showed it at its prompt.
    vi.useFakeTimers();
    const { host, ptys, events } = setup();
    host.spawn(req('a', { typeWhenReady: { line: LAUNCH_LINE, promptMarks: false } }));
    ptys[0].emit('user@host:~$ ');
    vi.advanceTimersByTime(UNMARKED_QUIET_MS);
    expect(ptys[0].written).toEqual([`${LAUNCH_LINE}\r`]);
    const shown = (): string =>
      events
        .filter((e) => e.type === 'data')
        .map((e) => (e as { data: string }).data)
        .join('');
    ptys[0].emit(`${LAUNCH_LINE}\r\n`);
    expect(shown()).toBe('user@host:~$ ');
    ptys[0].emit('\x1b]6791;launch\x07agent frame');
    // The prompt row is erased and the program draws in its place.
    expect(shown()).toBe('user@host:~$ \r\x1b[2K\x1b]6791;launch\x07agent frame');
    // A fresh window's replay shows the same.
    expect(host.peek('a')?.data.startsWith(shown())).toBe(true);
  });

  it('types the launch line only when the shell has not taken the script itself', () => {
    // Both ran once: the zsh integration sourced the script from its first
    // precmd while the line typed during a slow rc waited in the tty, and the
    // agent read it as its first prompt.
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'double0-host-launch-test-'));
    try {
      const script = join(dir, 'tab.sh');
      const spawnWith = (id: string) => {
        writeFileSync(script, '# launch\n');
        return req(id, {
          env: { DOUBLE0_LAUNCH: script },
          typeWhenReady: { line: LAUNCH_LINE, promptMarks: false },
        });
      };
      const { host, ptys } = setup();
      host.spawn(spawnWith('a'));
      ptys[0].emit('$ ');
      vi.advanceTimersByTime(UNMARKED_QUIET_MS);
      expect(ptys[0].written).toEqual([`${LAUNCH_LINE}\r`]);
      expect(existsSync(`${script}.typed`)).toBe(true);
      rmSync(`${script}.typed`);
      // The shell got there first (it renames the script before sourcing it).
      host.spawn(spawnWith('b'));
      ptys[1].emit('rc output');
      renameSync(script, `${script}.sourced`);
      vi.advanceTimersByTime(MAX_WAIT_MS);
      expect(ptys[1].written).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows a typed start command that is not a launch script as the shell echoes it', () => {
    // No script, no mark to wait for (fish, a Windows shell): never hold.
    vi.useFakeTimers();
    const { host, ptys, events } = setup();
    host.spawn(req('a', { typeWhenReady: { line: 'claude', promptMarks: false } }));
    ptys[0].emit('PS> ');
    vi.advanceTimersByTime(UNMARKED_QUIET_MS);
    ptys[0].emit('claude\r\n');
    expect(events.filter((e) => e.type === 'data').length).toBe(2);
  });

  it('types into a shell without prompt marks once its startup output goes quiet', () => {
    vi.useFakeTimers();
    const { host, ptys } = setup();
    host.spawn(req('a', { typeWhenReady: { line: 'claude', promptMarks: false } }));
    ptys[0].emit('PS> ');
    vi.advanceTimersByTime(UNMARKED_QUIET_MS - 1);
    ptys[0].emit(' ');
    vi.advanceTimersByTime(UNMARKED_QUIET_MS - 1);
    expect(ptys[0].written).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ptys[0].written).toEqual(['claude\r']);
  });

  it('never types into a shell that is gone', () => {
    vi.useFakeTimers();
    const { host, ptys } = setup();
    host.spawn(req('a', { typeWhenReady: { line: 'claude', promptMarks: false } }));
    host.spawn(req('b', { typeWhenReady: { line: 'claude', promptMarks: false } }));
    ptys[0].emit('$ ');
    ptys[1].emit('$ ');
    host.kill('a');
    ptys[1].exit(0);
    vi.advanceTimersByTime(MAX_WAIT_MS);
    expect(ptys[0].written).toEqual([]);
    expect(ptys[1].written).toEqual([]);
  });
});

describe('output, exit and the replay', () => {
  it('forwards every chunk, reports titles apart, and ends with the exit code', () => {
    const { host, ptys, events } = setup();
    host.spawn(req('a'));
    ptys[0].emit('hello');
    ptys[0].emit('\x1b]0;Fixing tests\x07');
    ptys[0].exit(3);
    expect(events).toEqual([
      { type: 'data', id: 'a', data: 'hello' },
      { type: 'title', id: 'a', title: 'Fixing tests' },
      { type: 'data', id: 'a', data: '\x1b]0;Fixing tests\x07' },
      { type: 'exit', id: 'a', exitCode: 3 },
    ]);
    expect(host.has('a')).toBe(false);
  });

  it('keeps the replay within its budget by dropping whole old chunks', () => {
    const { host, ptys } = setup({ bufCap: 10 });
    host.spawn(req('a'));
    ptys[0].emit('12345');
    ptys[0].emit('67890');
    ptys[0].emit('ab');
    expect(host.adopt('a')?.data).toBe('67890ab');
  });

  it('replays the ring plus the mode preamble at the live grid, resumes, and jiggles a repaint', () => {
    vi.useFakeTimers();
    const { host, ptys } = setup();
    host.spawn(req('a'));
    // A TUI set up its modes long ago - they predate the ring's tail.
    ptys[0].emit('\x1b[?1049h\x1b[?2004h');
    ptys[0].emit('frame');
    const snap = host.adopt('a');
    expect(snap).toEqual({
      data: '\x1b[?1049h\x1b[?2004hframe\x1b\\\x1b[?1049h\x1b[?2004h',
      cols: 120,
      rows: 40,
    });
    expect(ptys[0].resumed).toBe(1);
    // rows-1 now, the real size after the jiggle; `size` reports the target meanwhile.
    expect(ptys[0].resizes).toEqual([[120, 39]]);
    expect(host.size('a')).toEqual({ cols: 120, rows: 40 });
    vi.advanceTimersByTime(80);
    expect(ptys[0].resizes).toEqual([
      [120, 39],
      [120, 40],
    ]);
    expect(host.size('a')).toEqual({ cols: 120, rows: 40 });
    expect(host.adopt('nope')).toBeNull();
  });

  it('lets a real resize cancel the jiggle restore', () => {
    // The renderer's refit is authoritative: restoring the old rows over it
    // would leave the pty one row taller than the xterm for good.
    vi.useFakeTimers();
    const { host, ptys } = setup();
    host.spawn(req('a'));
    host.adopt('a');
    host.resize('a', 100, 30);
    vi.advanceTimersByTime(200);
    expect(ptys[0].resizes).toEqual([
      [120, 39],
      [100, 30],
    ]);
    expect(host.size('a')).toEqual({ cols: 100, rows: 30 });
  });
});

describe('the stream', () => {
  const marker = (verb: string): string => `\x1b]6790;${verb}\x07`;

  it('learns marker mode and the agent status from the markers', () => {
    const { host, ptys } = setup();
    host.spawn(req('a'));
    expect(host.markerDriven('a')).toBe(false);
    expect(host.agentStatus('a')).toBeNull();
    ptys[0].emit(marker('ready'));
    expect(host.markerDriven('a')).toBe(true);
    expect(host.agentStatus('a')).toBe('idle');
    ptys[0].emit(marker('running'));
    expect(host.agentStatus('a')).toBe('running');
    expect(host.list()[0]).toMatchObject({ markerDriven: true, agentStatus: 'running' });
    ptys[0].emit(marker('ended'));
    expect(host.markerDriven('a')).toBe(false);
    expect(host.agentStatus('a')).toBeNull();
  });

  it('trusts the launch flag until the stream says otherwise, and settles a turn on an interrupt key', () => {
    const { host, ptys } = setup();
    host.spawn(req('a', { markerDriven: true }));
    expect(host.markerDriven('a')).toBe(true);
    ptys[0].emit(marker('running'));
    host.input('a', '\x1b');
    expect(host.agentStatus('a')).toBe('idle');
    expect(ptys[0].written).toEqual(['\x1b']);
  });

  it('turns shell-integration marks into input entries with their tags spliced in', () => {
    const { host, ptys, events } = setup({ now: () => 1000 });
    host.spawn(req('a'));
    const b64 = Buffer.from('pnpm test').toString('base64');
    ptys[0].emit(`\x1b]6791;ps\x07% `);
    ptys[0].emit(`pnpm test\r\n\x1b]6791;cmd;${b64}\x07`);
    ptys[0].emit(`FAIL\x1b]6791;done;1\x07`);
    expect(events.filter((e) => e.type === 'inputs')).toMatchObject([
      { entries: [{ seq: 1, kind: 'command', text: 'pnpm test', exitCode: null, at: 1000 }] },
      { entries: [{ seq: 1, exitCode: 1 }] },
    ]);
    const data = events.filter((e) => e.type === 'data').map((e) => (e as { data: string }).data);
    expect(data[0]).toBe('\x1b]6791;ps\x07\x1b]6791;at;1\x07% ');
    expect(data[1]).toContain(`\x1b]6791;cmd;${b64}\x07\x1b]6791;end;1\x07`);
    expect(host.inputList('a')).toMatchObject([{ seq: 1, text: 'pnpm test', exitCode: 1 }]);
    expect(host.inputList('nope')).toEqual([]);
  });

  it('records a reported line under the foreground program and tags the ring between sequences only', () => {
    const { host, ptys, events } = setup();
    host.spawn(req('a'));
    ptys[0].process = '/usr/bin/python3';
    host.noteLine('a', 'print(2 + 2)', 3);
    expect(events.filter((e) => e.type === 'inputs')).toMatchObject([
      { entries: [{ seq: 1, kind: 'line', program: 'python3', text: 'print(2 + 2)', ref: 3 }] },
    ]);
    expect(host.adopt('a')?.data).toContain('\x1b]6791;at;1\x07');
    // Mid-sequence: the entry exists, the tag never lands inside the program's escape.
    ptys[0].emit('\x1b[3');
    host.noteLine('a', 'SELECT 1;', 4);
    ptys[0].emit('1mred');
    expect(host.adopt('a')?.data).toContain('\x1b[31mred');
    expect(host.inputList('a')).toHaveLength(2);
    // Oversized or malformed reports are dropped.
    host.noteLine('a', 'x'.repeat(5000), 5);
    host.noteLine('a', 'ls', 1.5);
    expect(host.inputList('a')).toHaveLength(2);
  });

  it('tells a busy foreground from an idle shell prompt', async () => {
    const { host, ptys } = setup();
    host.spawn(req('a'));
    expect(await host.foregroundBusy('a')).toBe(false);
    ptys[0].process = '-zsh';
    expect(await host.foregroundBusy('a')).toBe(false);
    ptys[0].process = 'claude';
    expect(await host.foregroundBusy('a')).toBe(true);
    expect(await host.foregroundBusy('nope')).toBe(false);
  });

  // Windows: the pty names the spawned shell forever (powershell.exe with
  // Claude running in it), so the process name says nothing there.
  it('asks the OS about the shell when the pty cannot name its foreground', async () => {
    const asked: number[] = [];
    let busy = false;
    const { host, ptys } = setup({
      shellBusy: async (pid) => {
        asked.push(pid);
        return busy;
      },
    });
    host.spawn(req('a'));
    ptys[0].process = 'powershell.exe';
    expect(await host.foregroundBusy('a')).toBe(false);
    busy = true;
    expect(await host.foregroundBusy('a')).toBe(true);
    expect(asked).toEqual([4242, 4242]);
    expect(await host.foregroundBusy('nope')).toBe(false);
  });
});

describe('marker folder (Windows hooks)', () => {
  const STATUS_RUNNING = '\x1b]6790;running\x07';
  let dir: string;

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withInbox = () => {
    dir = mkdtempSync(join(tmpdir(), 'double0-markers-'));
    const s = setup({ markerPollMs: 5 });
    s.host.spawn(req('a', { env: { TERM: 'xterm-256color', DOUBLE0_MARKER_DIR: dir } }));
    const data = () =>
      s.events
        .filter((e): e is Extract<HostEvent, { type: 'data' }> => e.type === 'data')
        .map((e) => e.data)
        .join('');
    return { ...s, data };
  };

  it("splices a hook's markers into the stream, in the order they were written", async () => {
    const { host, data } = withInbox();
    writeFileSync(join(dir, '20-7.m'), '\x1b]6790;finished\x07');
    writeFileSync(join(dir, '10-9.m'), STATUS_RUNNING);
    // Still being written: never read.
    writeFileSync(join(dir, '5-1.tmp'), '\x1b]6790;ended\x07');
    await vi.waitFor(() => expect(data()).toContain('finished'));
    expect(data()).toBe(`${STATUS_RUNNING}\x1b]6790;finished\x07`);
    // Read like any pty's markers: the tab speaks the protocol now.
    expect(host.markerDriven('a')).toBe(true);
    expect(host.agentStatus('a')).toBe('idle');
    expect(existsSync(join(dir, '10-9.m'))).toBe(false);
    expect(existsSync(join(dir, '5-1.tmp'))).toBe(true);
  });

  // ConPTY output can stop inside a CSI: an OSC spliced there would end it
  // early and the rest would print as text.
  it('waits for the stream to leave an escape sequence before splicing', async () => {
    const { ptys, data } = withInbox();
    ptys[0].emit('\x1b[3');
    writeFileSync(join(dir, '1-1.m'), STATUS_RUNNING);
    // Wait for the whole drain, not just the claim: the inbox renames the file
    // to `.taken` and only then reads it, so "1-1.m is gone" let the rest of
    // the sequence arrive before the marker was held (failed 1 run in 3 under
    // load, 2026-11-02). The `.taken` unlink is the drain's last step; the
    // host holds the marker in the same microtask chain.
    await vi.waitFor(() => expect(readdirSync(dir)).toEqual([]));
    expect(data()).toBe('\x1b[3');
    ptys[0].emit('1mred');
    expect(data()).toBe(`\x1b[31mred${STATUS_RUNNING}`);
  });

  it('never writes anything but our markers to the screen', async () => {
    const { data } = withInbox();
    writeFileSync(join(dir, '1-1.m'), '\x1b]0;evil title\x07rm -rf /\r');
    writeFileSync(join(dir, '2-1.m'), STATUS_RUNNING);
    await vi.waitFor(() => expect(data()).toBe(STATUS_RUNNING));
    expect(existsSync(join(dir, '1-1.m'))).toBe(false);
  });

  it('removes the folder with the terminal', async () => {
    const { host } = withInbox();
    host.kill('a');
    await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
  });

  it('starts a NEW shell with an empty folder, and leaves a live one its markers', async () => {
    dir = mkdtempSync(join(tmpdir(), 'double0-markers-'));
    // Left by an earlier shell under the same id: never replayed into this one.
    writeFileSync(join(dir, '1-1.m'), STATUS_RUNNING);
    const { host, events } = setup({ markerPollMs: 60_000 });
    const spawn = () =>
      host.spawn(req('a', { env: { TERM: 'xterm-256color', DOUBLE0_MARKER_DIR: dir } }));
    expect(spawn()).toBe(true);
    expect(existsSync(join(dir, '1-1.m'))).toBe(false);
    // An app restart re-launches a terminal the daemon still runs: its
    // undrained markers stay for the drain.
    writeFileSync(join(dir, '2-1.m'), STATUS_RUNNING);
    expect(spawn()).toBe(false);
    expect(existsSync(join(dir, '2-1.m'))).toBe(true);
    expect(events.filter((e) => e.type === 'data')).toEqual([]);
    host.kill('a');
  });
});

describe('colour-scheme notifications (DECSET 2031)', () => {
  it('pushes the tone to programs that asked, on a flip and on adopt - never to a plain shell', () => {
    const { host, ptys } = setup();
    host.spawn(req('agent'));
    host.spawn(req('shell'));
    ptys[0].emit('\x1b[?2031h');
    host.setTone(false);
    expect(ptys[0].written).toEqual([colorSchemeInput(false)]);
    host.adopt('agent');
    expect(ptys[0].written).toEqual([colorSchemeInput(false), colorSchemeInput(false)]);
    expect(ptys[1].written).toEqual([]);
    ptys[0].emit('\x1b[?2031l');
    host.setTone(true);
    expect(ptys[0].written).toHaveLength(2);
  });
});

describe('failures and flow control', () => {
  it('ends a terminal whose shell is gone when a write or resize throws', () => {
    const { host, ptys, events } = setup();
    host.spawn(req('a'));
    host.spawn(req('b'));
    ptys[0].dead = true;
    host.input('a', 'x');
    expect(events).toEqual([{ type: 'exit', id: 'a', exitCode: -1 }]);
    expect(host.has('a')).toBe(false);
    expect(ptys[0].killed).toEqual([undefined]);
    ptys[1].dead = true;
    host.resize('b', 10, 10);
    expect(events.at(-1)).toEqual({ type: 'exit', id: 'b', exitCode: -1 });
  });

  it('pauses and resumes a pty, and resumes every one when the client is gone', () => {
    const { host, ptys } = setup();
    host.spawn(req('a'));
    host.spawn(req('b'));
    host.pause('a');
    expect(ptys[0].paused).toBe(1);
    host.resumeAll();
    expect(ptys[0].resumed).toBe(1);
    expect(ptys[1].resumed).toBe(1);
  });

  it('kills and forgets a terminal at once, with no exit event for it', () => {
    const { host, ptys, events } = setup();
    host.spawn(req('a'));
    host.kill('a');
    expect(ptys[0].killed).toEqual([undefined]);
    expect(host.has('a')).toBe(false);
    ptys[0].exit(0);
    expect(events).toEqual([]);
  });
});

describe('a closed tab', () => {
  // A program that ignored the hangup used to outlive its tab for good: the
  // demo's fake agent, stuck in its SessionEnd hook, sat there for days.
  const reaperOf = (group: number | null, aliveFor: number) => {
    const events: string[] = [];
    let checks = 0;
    const reaper: SessionReaper = {
      foregroundGroup: async (sid) => {
        events.push(`lookup ${sid}`);
        return group;
      },
      stillOurs: async (_pgid, sid) => {
        events.push(`ours? ${sid}`);
        return checks++ < aliveFor;
      },
      signalGroup: (pgid, sig) => events.push(`${sig} -${pgid}`),
    };
    return { reaper, events };
  };
  const opts = (reaper: SessionReaper) => ({ reaper, closeGraceMs: 3000, closeTermGraceMs: 2000 });

  it('reads the foreground group BEFORE hanging up, then TERMs and KILLs what stayed', async () => {
    vi.useFakeTimers();
    // Alive at the grace check and again after the TERM: it ignores both.
    const r = reaperOf(5300, 2);
    const { host, ptys } = setup(opts(r.reaper));
    host.spawn(req('a'));
    host.kill('a');
    // macOS clears the foreground flag once the terminal hangs up, so the
    // group is read first and the SIGHUP follows the answer.
    expect(r.events).toEqual(['lookup 4242']);
    expect(ptys[0].killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ptys[0].killed).toEqual([undefined]);
    ptys[0].exit(0); // the shell itself leaves on the hangup

    await vi.advanceTimersByTimeAsync(2999);
    expect(r.events).toEqual(['lookup 4242']); // the grace period is the program's
    await vi.advanceTimersByTimeAsync(1);
    // Asked by the closed shell's session before each signal.
    expect(r.events).toEqual(['lookup 4242', 'ours? 4242', 'SIGTERM -5300']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.events).toEqual([
      'lookup 4242',
      'ours? 4242',
      'SIGTERM -5300',
      'ours? 4242',
      'SIGKILL -5300',
    ]);
    expect(ptys[0].killed).toEqual([undefined]); // the shell had exited: never signalled again
  });

  it('stops at the TERM when that ended the group', async () => {
    vi.useFakeTimers();
    const r = reaperOf(5300, 1);
    const { host, ptys } = setup(opts(r.reaper));
    host.spawn(req('a'));
    host.kill('a');
    await vi.advanceTimersByTimeAsync(0);
    ptys[0].exit(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.events).toEqual(['lookup 4242', 'ours? 4242', 'SIGTERM -5300', 'ours? 4242']);
  });

  // Its id can be handed on once every member left: never signal a group
  // that is no longer the closed shell's (a Linux host wraps pids quickly).
  it('signals nothing when everything left on the hangup, or the group is no longer ours', async () => {
    vi.useFakeTimers();
    const r = reaperOf(5300, 0);
    const { host, ptys } = setup(opts(r.reaper));
    host.spawn(req('a'));
    host.kill('a');
    await vi.advanceTimersByTimeAsync(0);
    ptys[0].exit(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.events).toEqual(['lookup 4242', 'ours? 4242']);
    expect(ptys[0].killed).toEqual([undefined]);
  });

  it("never signals the shell's own group - a tab closed at the prompt", async () => {
    vi.useFakeTimers();
    const r = reaperOf(4242, 5);
    const { host, ptys } = setup(opts(r.reaper));
    host.spawn(req('a'));
    host.kill('a');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.events).toEqual(['lookup 4242']);
    // It ignored the hangup, so it alone gets the KILL - as killAll does.
    expect(ptys[0].killed).toEqual([undefined, 'SIGKILL']);
  });

  it('hangs up anyway when the lookup is slow, and then signals no group', async () => {
    vi.useFakeTimers();
    let answer: (g: number) => void = () => {};
    const events: string[] = [];
    const reaper: SessionReaper = {
      foregroundGroup: () => new Promise((res) => (answer = res)),
      stillOurs: async () => true,
      signalGroup: (pgid, sig) => events.push(`${sig} -${pgid}`),
    };
    const { host, ptys } = setup(opts(reaper));
    host.spawn(req('a'));
    host.kill('a');
    await vi.advanceTimersByTimeAsync(249);
    expect(ptys[0].killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ptys[0].killed).toEqual([undefined]); // never held longer than the cap
    answer(5300); // read after the hangup: the OS no longer knew
    ptys[0].exit(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([]);
  });
});

describe('killAll', () => {
  // node-pty hands a shell's exit from its watcher thread to JS; one that lands
  // after Node's environment started tearing down can't call into JS, and the
  // addon's C++ Napi::Error aborts the process (crash report 149155736). So the wait
  // settles only once every killed shell has reported its exit.
  it('settles only after every killed shell has exited', async () => {
    const { host, ptys } = setup();
    host.spawn(req('a'));
    host.spawn(req('b'));
    let settled = false;
    const gone = host.killAll().then(() => {
      settled = true;
    });
    expect(ptys[0].killed).toEqual([undefined]);
    expect(ptys[1].killed).toEqual([undefined]);
    ptys[0].exit(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    ptys[1].exit(0);
    await gone;
    expect(settled).toBe(true);
    expect(host.count).toBe(0);
  });

  it('escalates to SIGKILL for a shell still running after the grace period', async () => {
    const { host, ptys } = setup();
    host.spawn(req('a'));
    vi.useFakeTimers();
    let settled = false;
    const gone = host.killAll().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(ptys[0].killed).toEqual([undefined]);
    await vi.advanceTimersByTimeAsync(100);
    expect(ptys[0].killed).toEqual([undefined, 'SIGKILL']);
    expect(settled).toBe(false);
    ptys[0].exit(137);
    await gone;
    expect(settled).toBe(true);
  });

  it('settles at once when no shell is running', async () => {
    const { host, ptys } = setup();
    host.spawn(req('a'));
    ptys[0].exit(0);
    await expect(host.killAll()).resolves.toBeUndefined();
  });
});
