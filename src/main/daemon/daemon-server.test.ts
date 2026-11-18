import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PtyHost, type HostEvent, type HostPty, type PtySpawnOptions } from '../pty-host';
import { DaemonClient } from './daemon-client';
import { splitHistory, startDaemonServer, type DaemonServer } from './daemon-server';
import { PROTOCOL_VERSION, REMOTE_CAPS, type ViewEvent } from './protocol';

/**
 * The daemon end to end over a real Unix socket - server, client and protocol
 * together - with a fake pty factory in place of node-pty: the shells are
 * scripted, everything else is the real thing. The entry (daemon-main.ts)
 * only adds node-pty, the paths and the signals; the built bundle is smoke
 * tested by hand under the Electron binary (a private plan).
 */

type FakePty = HostPty & {
  emit: (d: string) => void;
  exit: (c: number) => void;
  written: string[];
  paused: number;
  resumed: number;
  killed: number;
  /** Writable here: the tests move the foreground program. */
  process: string;
};

function fakeSpawner(): {
  spawn: (f: string, a: string[], o: PtySpawnOptions) => FakePty;
  ptys: FakePty[];
} {
  const ptys: FakePty[] = [];
  return {
    ptys,
    spawn: (_file, _args, opts) => {
      if (_file === 'nope') throw new Error('cannot start');
      let dataCb: (d: string) => void = () => {};
      const exitCbs: Array<(e: { exitCode: number }) => void> = [];
      const pty: FakePty = {
        cols: opts.cols,
        rows: opts.rows,
        process: 'zsh',
        written: [],
        paused: 0,
        resumed: 0,
        killed: 0,
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
          pty.written.push(d);
        },
        resize: (c, r) => {
          (pty as { cols: number }).cols = c;
          (pty as { rows: number }).rows = r;
        },
        kill: () => {
          pty.killed++;
          // The scripted shell dies at once on SIGHUP.
          setImmediate(() => pty.exit(0));
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
    },
  };
}

const spawnReq = (id: string, file = '/bin/zsh') => ({
  id,
  file,
  args: ['-i'],
  cwd: '/tmp',
  env: { TERM: 'xterm-256color' },
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  markerDriven: false,
});

const scratch: string[] = [];
const servers: DaemonServer[] = [];
const clients: DaemonClient[] = [];

function socketIn(): string {
  // Windows listens on a named pipe, as the daemon does there (daemon-paths.ts).
  if (process.platform === 'win32') return `\\\\.\\pipe\\d0d-${randomUUID()}`;
  // Short path: the kernel caps a Unix socket path at ~104 bytes.
  const dir = mkdtempSync(join(tmpdir(), 'd0d-'));
  scratch.push(dir);
  return join(dir, 's.sock');
}

async function start(overrides: Partial<Parameters<typeof startDaemonServer>[0]> = {}) {
  const { spawn, ptys } = fakeSpawner();
  const host = new PtyHost(spawn, { adoptJiggleMs: 5, killGraceMs: 200, shellBusy: null });
  const socketPath = socketIn();
  const onExit = vi.fn();
  const server = startDaemonServer({
    socketPath,
    token: 'secret',
    buildId: 'build-1',
    appVersion: '0.4.2',
    host,
    idleGraceMs: 60_000,
    onExit,
    ...overrides,
  });
  servers.push(server);
  await server.listening;
  return { server, host, ptys, socketPath, onExit };
}

const hello = { token: 'secret', appVersion: '0.4.2', buildId: 'build-1' };
async function connect(socketPath: string, h: Partial<typeof hello> = {}): Promise<DaemonClient> {
  const c = await DaemonClient.connect(socketPath, { ...hello, ...h }, { timeoutMs: 2000 });
  clients.push(c);
  return c;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
  // An agent may still be writing its log into the folder (ENOTEMPTY
  // under a loaded run - CLAUDE.md › Testing gotchas).
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

describe('hello', () => {
  it('refuses a wrong token or protocol and anything that is not a hello', async () => {
    const { socketPath } = await start();
    await expect(connect(socketPath, { token: 'wrong' })).rejects.toThrow(/refused: token/);
    // A raw socket speaking garbage first is cut off without a welcome.
    const { createConnection } = await import('node:net');
    const raw = createConnection(socketPath);
    // Flowing, or the server's FIN is never consumed and `close` never fires.
    raw.resume();
    await new Promise<void>((r) => raw.once('connect', () => r()));
    const closed = new Promise<void>((r) => raw.once('close', () => r()));
    raw.write('{"t":"call","req":1,"op":"list","args":{}}\n');
    await closed;
    const ok = await connect(socketPath);
    expect(ok.welcome).toMatchObject({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      buildId: 'build-1',
      stale: false,
      terminals: [],
    });
  });

  it('marks a client of another build stale and refuses its spawns', async () => {
    const { socketPath, host } = await start();
    const old = await connect(socketPath, { buildId: 'build-0' });
    expect(old.stale).toBe(true);
    await expect(old.call('spawn', spawnReq('t1'))).rejects.toThrow('stale');
    expect(host.count).toBe(0);
    // It may still read and drive what the daemon holds.
    expect(await old.call('list')).toEqual([]);
  });
});

describe('a terminal across clients', () => {
  it('spawns, streams, keeps running unattended and replays to the next client', async () => {
    const { socketPath, host, ptys } = await start();
    const first = await connect(socketPath);
    const seen: HostEvent[] = [];
    first.onEvent((ev) => seen.push(ev));
    expect(await first.call('spawn', spawnReq('t1'))).toBe(true);
    expect(host.count).toBe(1);
    // Casts queue behind the spawn on the wire, so a resize right after it lands.
    first.cast('resize', { id: 't1', cols: 120, rows: 40 });
    first.cast('input', { id: 't1', data: 'ls\r' });
    await settle();
    expect(ptys[0].cols).toBe(120);
    expect(ptys[0].written).toEqual(['ls\r']);
    ptys[0].emit('$ ls\r\n');
    await settle();
    expect(seen).toEqual([{ type: 'data', id: 't1', data: '$ ls\r\n' }]);
    // The client paused the pty and then went away (the app quit).
    first.cast('pause', { id: 't1' });
    await settle();
    expect(ptys[0].paused).toBe(1);
    first.close();
    await vi.waitFor(() => expect(ptys[0].resumed).toBe(1));
    // Output while nobody listens goes into the ring.
    ptys[0].emit('file-a\r\nfile-b\r\n');
    ptys[0].emit('\x1b[?2004h');
    // The next launch of the app.
    const second = await connect(socketPath);
    expect(second.welcome.terminals).toEqual([
      { id: 't1', cols: 120, rows: 40, markerDriven: false, agentStatus: 'idle' },
    ]);
    const snapshot = await second.call<{ data: string; cols: number; rows: number }>('adopt', {
      id: 't1',
    });
    expect(snapshot).toEqual({
      data: '$ ls\r\nfile-a\r\nfile-b\r\n\x1b[?2004h\x1b\\\x1b[?2004h',
      cols: 120,
      rows: 40,
    });
    // Live again: new output reaches the new client, the exit ends it.
    const later: HostEvent[] = [];
    second.onEvent((ev) => later.push(ev));
    ptys[0].emit('more');
    ptys[0].exit(0);
    await vi.waitFor(() =>
      expect(later).toEqual([
        { type: 'data', id: 't1', data: 'more' },
        { type: 'exit', id: 't1', exitCode: 0 },
      ]),
    );
    expect(await second.call('list')).toEqual([]);
  });

  it('answers the queries and reports a shell that cannot start', async () => {
    const { socketPath, ptys } = await start();
    const c = await connect(socketPath);
    expect(await c.call('spawn', spawnReq('bad', 'nope'))).toBe(false);
    await c.call('spawn', spawnReq('t1'));
    ptys[0].emit('\x1b]6790;ready\x07\x1b]6790;running\x07');
    ptys[0].process = 'claude';
    expect(await c.call('size', { id: 't1' })).toEqual({ cols: 100, rows: 30 });
    expect(await c.call('foregroundBusy', { id: 't1' })).toBe(true);
    expect(await c.call('markerDriven', { ids: ['t1', 'nope'] })).toEqual(['t1']);
    expect(await c.call('agentStatus', { ids: ['t1'] })).toEqual([{ id: 't1', status: 'running' }]);
    c.cast('noteLine', { id: 't1', text: 'hello', ref: 1 });
    await settle();
    expect(await c.call('inputList', { id: 't1' })).toMatchObject([
      { text: 'hello', program: 'claude' },
    ]);
    await expect(c.call('size', { nope: true })).rejects.toThrow('bad args');
    expect(await c.call('size', { id: 'nope' })).toBeNull();
  });

  it('kills on request without an exit event, and ends everything on killAll', async () => {
    const { socketPath, host, ptys } = await start();
    const c = await connect(socketPath);
    const seen: HostEvent[] = [];
    c.onEvent((ev) => seen.push(ev));
    await c.call('spawn', spawnReq('t1'));
    await c.call('spawn', spawnReq('t2'));
    c.cast('kill', { id: 't1' });
    await settle();
    expect(ptys[0].killed).toBe(1);
    expect(host.count).toBe(1);
    expect(await c.call('killAll')).toBe(true);
    expect(host.count).toBe(0);
    expect(seen.filter((e) => e.type === 'exit')).toEqual([]);
    // The daemon stays for the next spawn.
    expect(await c.call('spawn', spawnReq('t3'))).toBe(true);
  });
});

// Off (user decision 2026-11-02): its byte counts and resizes race the
// socket on a busy Mac - see SKIPPED_LIVE_REMOTE_TESTS in vitest.config.ts.
describe.skip('two apps on one daemon (a private plan › 14, M4)', () => {
  const multi = () => start({ extraCaps: REMOTE_CAPS });
  const viewsOf = (c: DaemonClient) => {
    const seen: ViewEvent[] = [];
    c.onViewEvent((ev) => seen.push(ev));
    return seen;
  };
  const sizes = (seen: ViewEvent[]) =>
    seen.filter((e) => e.type === 'terminal-size').map((e) => JSON.stringify(e));

  it('numbers each client, counts the others and tells everyone when one joins or leaves', async () => {
    const { socketPath } = await multi();
    const laptopA = await connect(socketPath);
    expect(laptopA.connectionId).toEqual(expect.any(Number));
    expect(laptopA.welcome.peers).toEqual({ own: 0, other: 0 });
    const seenA = viewsOf(laptopA);
    const laptopB = await connect(socketPath);
    expect(laptopB.welcome.peers).toEqual({ own: 1, other: 0 });
    expect(laptopB.connectionId).not.toBe(laptopA.connectionId);
    await vi.waitFor(() => expect(seenA).toContainEqual({ type: 'peers', own: 1, other: 0 }));
    // A laptop of another build (attached to drain) is counted apart.
    const older = await connect(socketPath, { buildId: 'build-0' });
    expect(older.welcome.peers).toEqual({ own: 2, other: 0 });
    await vi.waitFor(() => expect(seenA).toContainEqual({ type: 'peers', own: 1, other: 1 }));
    laptopB.close();
    older.close();
    await vi.waitFor(() =>
      expect(seenA[seenA.length - 1]).toEqual({ type: 'peers', own: 0, other: 0 }),
    );
  });

  it('sends input from either client and every event to both', async () => {
    const { socketPath, ptys } = await multi();
    const a = await connect(socketPath);
    const b = await connect(socketPath);
    const seenB: HostEvent[] = [];
    b.onEvent((ev) => seenB.push(ev));
    await a.call('spawn', spawnReq('t1'));
    a.cast('input', { id: 't1', data: 'a' });
    b.cast('input', { id: 't1', data: 'b' });
    await settle();
    expect(ptys[0].written.sort()).toEqual(['a', 'b']);
    ptys[0].emit('\x1b]6790;needs-input\x07');
    await vi.waitFor(() => expect(seenB).toContainEqual(expect.objectContaining({ type: 'data' })));
    expect(await b.call('agentStatus', { ids: ['t1'] })).toEqual([
      { id: 't1', status: 'needs-input' },
    ]);
  });

  it('lets the client that interacts set the grid - a passive refit of the other follows it', async () => {
    const { socketPath, ptys } = await multi();
    const a = await connect(socketPath);
    const b = await connect(socketPath);
    const seenA = viewsOf(a);
    const seenB = viewsOf(b);
    await a.call('spawn', spawnReq('t1'));
    // A types into its 120x40 window: a claim, applied, broadcast to both.
    a.cast('resizeIntent', { id: 't1', cols: 120, rows: 40, kind: 'claim' });
    await vi.waitFor(() => expect(sizes(seenB)).toHaveLength(1));
    expect(ptys[0].cols).toBe(120);
    const byA = { type: 'terminal-size', id: 't1', cols: 120, rows: 40, by: a.connectionId };
    expect(seenB).toContainEqual(byA);
    expect(seenA).toContainEqual(byA);
    // B's window merely shows the tab (passive, 80x24): refused - the pty
    // keeps A's grid and B alone is told to follow it.
    b.cast('resizeIntent', { id: 't1', cols: 80, rows: 24, kind: 'passive' });
    await vi.waitFor(() => expect(sizes(seenB)).toHaveLength(2));
    expect(ptys[0].cols).toBe(120);
    expect(seenB[seenB.length - 1]).toEqual(byA);
    expect(sizes(seenA)).toHaveLength(1);
    // B types: its claim wins, A follows.
    b.cast('resizeIntent', { id: 't1', cols: 80, rows: 24, kind: 'claim' });
    await vi.waitFor(() => expect(sizes(seenA)).toHaveLength(2));
    expect(ptys[0].cols).toBe(80);
    expect(seenA[seenA.length - 1]).toEqual({
      type: 'terminal-size',
      id: 't1',
      cols: 80,
      rows: 24,
      by: b.connectionId,
    });
    // An older client's plain resize reads as a claim.
    a.cast('resize', { id: 't1', cols: 100, rows: 30 });
    await vi.waitFor(() => expect(ptys[0].cols).toBe(100));
    // The claimant leaves: the other's passive refit applies at once.
    a.close();
    await settle();
    b.cast('resizeIntent', { id: 't1', cols: 90, rows: 20, kind: 'passive' });
    await vi.waitFor(() => expect(ptys[0].cols).toBe(90));
  });

  it("keeps a slow client's pause from stalling the other, and hands it a snapshot once it falls 4 MiB behind", async () => {
    const { socketPath, ptys } = await multi();
    const slow = await connect(socketPath);
    const fast = await connect(socketPath);
    const viewsSlow = viewsOf(slow);
    let slowBytes = 0;
    let fastBytes = 0;
    slow.onEvent((ev) => {
      if (ev.type === 'data') slowBytes += ev.data.length;
    });
    fast.onEvent((ev) => {
      if (ev.type === 'data') fastBytes += ev.data.length;
    });
    await slow.call('spawn', spawnReq('t1'));
    slow.cast('pause', { id: 't1' });
    await settle();
    // Not every client paused: the pty keeps flowing.
    expect(ptys[0].paused).toBe(0);
    const piece = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 10; i++) ptys[0].emit(piece);
    await vi.waitFor(() => expect(fastBytes).toBe(10 * piece.length));
    const snapshots = () => viewsSlow.filter((e) => e.type === 'snapshot-needed');
    await vi.waitFor(() => expect(snapshots()).toEqual([{ type: 'snapshot-needed', id: 't1' }]));
    // Exactly 4 MiB went out before the cut; nothing after it. Wait for the
    // 4 MiB to cross the socket first: one settle() read 3.5 MiB on the loaded
    // release Mac (v0.7.3's check).
    await vi.waitFor(() => expect(slowBytes).toBe(8 * piece.length));
    await settle();
    expect(slowBytes).toBe(8 * piece.length);
    // Resuming alone does not restart a stream with a hole in it...
    slow.cast('resume', { id: 't1' });
    ptys[0].emit('after');
    await vi.waitFor(() => expect(fastBytes).toBe(10 * piece.length + 5));
    expect(slowBytes).toBe(8 * piece.length);
    // ...the snapshot does: the adopt carries the ring and the stream restarts.
    const snap = await slow.call<{ data: string }>('adopt', { id: 't1' });
    expect(snap.data.endsWith('after')).toBe(true);
    ptys[0].emit('live');
    await vi.waitFor(() => expect(slowBytes).toBe(8 * piece.length + 4));
    // Both paused: only then does the pty stop.
    slow.cast('pause', { id: 't1' });
    fast.cast('pause', { id: 't1' });
    await vi.waitFor(() => expect(ptys[0].paused).toBe(1));
    // One of them leaves: the pty flows for the other.
    fast.close();
    await vi.waitFor(() => expect(ptys[0].resumed).toBeGreaterThan(0));
  });

  it('tells the other client when one ends terminals - a tab close or Stop all reports no exit of its own', async () => {
    const { socketPath } = await multi();
    const a = await connect(socketPath);
    const b = await connect(socketPath);
    const seenA: HostEvent[] = [];
    const seenB: HostEvent[] = [];
    a.onEvent((ev) => seenA.push(ev));
    b.onEvent((ev) => seenB.push(ev));
    await a.call('spawn', spawnReq('t1'));
    await a.call('spawn', spawnReq('t2'));
    await a.call('spawn', spawnReq('t3'));
    a.cast('kill', { id: 't1' });
    await vi.waitFor(() => expect(seenB).toContainEqual({ type: 'exit', id: 't1', exitCode: 0 }));
    await b.call('killAll');
    await vi.waitFor(() =>
      expect(
        seenA
          .filter((e) => e.type === 'exit')
          .map((e) => e.id)
          .sort(),
      ).toEqual(['t2', 't3']),
    );
    // The client that ended them hears nothing extra (it knows).
    expect(seenA.filter((e) => e.type === 'exit' && e.id === 't1')).toEqual([]);
    expect(seenB.filter((e) => e.type === 'exit' && e.id !== 't1')).toEqual([]);
  });

  it('ignores a pause for a terminal that does not exist yet - a later one under that id streams', async () => {
    const { socketPath, ptys } = await multi();
    const a = await connect(socketPath);
    const b = await connect(socketPath);
    const views = viewsOf(a);
    let bytes = 0;
    a.onEvent((ev) => {
      if (ev.type === 'data') bytes += ev.data.length;
    });
    a.cast('pause', { id: 't1' });
    b.cast('pause', { id: 't1' });
    await a.call('spawn', spawnReq('t1'));
    const piece = 'y'.repeat(1024 * 1024);
    for (let i = 0; i < 5; i++) ptys[0].emit(piece);
    await vi.waitFor(() => expect(bytes).toBe(5 * piece.length));
    expect(ptys[0].paused).toBe(0);
    expect(views.filter((e) => e.type === 'snapshot-needed')).toEqual([]);
  });

  it('echoes the seq of the intent that set the grid (claim cross-fire, M4 review)', async () => {
    const { socketPath } = await multi();
    const a = await connect(socketPath);
    const b = await connect(socketPath);
    const seenB = viewsOf(b);
    await a.call('spawn', spawnReq('t1'));
    a.cast('resizeIntent', { id: 't1', cols: 120, rows: 40, kind: 'claim', seq: 4 });
    await vi.waitFor(() =>
      expect(seenB).toContainEqual(expect.objectContaining({ type: 'terminal-size', seq: 4 })),
    );
    // A refused passive intent is answered with the claimant's grid and seq.
    b.cast('resizeIntent', { id: 't1', cols: 80, rows: 24, kind: 'passive', seq: 1 });
    await vi.waitFor(() => expect(seenB.filter((e) => e.type === 'terminal-size')).toHaveLength(2));
    expect(seenB.at(-1)).toMatchObject({ cols: 120, by: a.connectionId, seq: 4 });
  });

  it('leaves a single-app daemon exactly as before: no intents, no peers, pause stops the pty', async () => {
    const { socketPath, ptys } = await start();
    const c = await connect(socketPath);
    expect(c.connectionId).toBeNull();
    expect(c.welcome.peers).toBeUndefined();
    const seen = viewsOf(c);
    await c.call('spawn', spawnReq('t1'));
    c.cast('resizeIntent', { id: 't1', cols: 70, rows: 20, kind: 'passive' });
    c.cast('pause', { id: 't1' });
    await settle();
    expect(ptys[0].cols).toBe(70);
    expect(ptys[0].paused).toBe(1);
    expect(seen).toEqual([]);
  });
});

describe('capabilities and the ops beside the chain (a private plan › 7)', () => {
  it('lists its capabilities in the welcome and answers a ping', async () => {
    const { socketPath } = await start();
    const c = await connect(socketPath);
    expect(c.welcome.caps).toEqual(['ping']);
    expect(c.supports('ping')).toBe(true);
    const before = Date.now();
    const pong = await c.call<{ t: number }>('ping');
    expect(pong.t).toBeGreaterThanOrEqual(before);
  });

  it('answers a ping while the ordered chain is held up, and keeps the chain in order', async () => {
    // A ping is the liveness probe of a host connection (plan 28 › decision
    // 12): queued behind a slow chain op it would read a busy daemon as a
    // dead one, and the reconnect would drop every terminal on it.
    const { socketPath, host, ptys } = await start();
    const c = await connect(socketPath);
    await c.call('spawn', spawnReq('t1'));
    let release!: () => void;
    host.killAll = () => new Promise<void>((r) => (release = r));
    const killed = c.call('killAll');
    c.cast('input', { id: 't1', data: 'behind the chain' });
    await expect(c.call('ping')).resolves.toMatchObject({ t: expect.any(Number) });
    // The cast stays behind the held chain op - the chain's order is the rule.
    await settle();
    expect(ptys[0].written).toEqual([]);
    release();
    expect(await killed).toBe(true);
    await vi.waitFor(() => expect(ptys[0].written).toEqual(['behind the chain']));
  });

  it('never holds a queued cast behind a slow call that runs beside the chain', async () => {
    // foregroundBusy asks the OS on Windows (a PowerShell that takes seconds
    // to start): a keystroke must not wait for it.
    const { socketPath, host, ptys } = await start();
    const c = await connect(socketPath);
    await c.call('spawn', spawnReq('t1'));
    host.foregroundBusy = () => new Promise<boolean>(() => {});
    void c.call('foregroundBusy', { id: 't1' }).catch(() => undefined);
    c.cast('input', { id: 't1', data: 'ls\r' });
    await vi.waitFor(() => expect(ptys[0].written).toEqual(['ls\r']));
    expect(await c.call('list')).toHaveLength(1);
  });

  it('serves a client that reaches it through a bridged stream', async () => {
    // The remote shape: the client speaks over a stream pair, a bridge
    // copies bytes to the daemon's socket (daemon.js connect on the host).
    const { createConnection } = await import('node:net');
    const { Duplex, PassThrough } = await import('node:stream');
    const { socketPath, ptys } = await start();
    const socket = createConnection(socketPath);
    await new Promise<void>((r) => socket.once('connect', () => r()));
    const toDaemon = new PassThrough();
    const fromDaemon = new PassThrough();
    toDaemon.pipe(socket);
    socket.pipe(fromDaemon);
    const c = await DaemonClient.connectOver(
      Duplex.from({ readable: fromDaemon, writable: toDaemon }),
      hello,
      { label: 'build-box' },
    );
    clients.push(c);
    const seen: HostEvent[] = [];
    c.onEvent((ev) => seen.push(ev));
    expect(await c.call('spawn', spawnReq('t1'))).toBe(true);
    c.cast('input', { id: 't1', data: 'pwd\r' });
    await vi.waitFor(() => expect(ptys[0].written).toEqual(['pwd\r']));
    ptys[0].emit('/home/emmaw\r\n');
    await vi.waitFor(() =>
      expect(seen).toEqual([{ type: 'data', id: 't1', data: '/home/emmaw\r\n' }]),
    );
    socket.destroy();
  });
});

describe('lifecycle', () => {
  it('exits once idle for the grace period, and not while a terminal or a client remains', async () => {
    const { socketPath, onExit, ptys } = await start({ idleGraceMs: 60 });
    const c = await connect(socketPath);
    await c.call('spawn', spawnReq('t1'));
    c.close();
    await new Promise((r) => setTimeout(r, 120));
    expect(onExit).not.toHaveBeenCalled();
    ptys[0].exit(0);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith('idle'), { timeout: 2000 });
    expect(existsSync(socketPath)).toBe(false);
  });

  it('exits once its last terminal is gone even while a newer build is connected', async () => {
    // A newer app attaches to an older daemon only to drain what it holds; an
    // empty old daemon it stays connected to must not live as long as the app.
    const { socketPath, onExit, ptys } = await start({ idleGraceMs: 60 });
    const own = await connect(socketPath);
    await own.call('spawn', spawnReq('t1'));
    own.close();
    const newer = await connect(socketPath, { buildId: 'build-2' });
    expect(newer.stale).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(onExit).not.toHaveBeenCalled();
    ptys[0].exit(0);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith('idle'), { timeout: 2000 });
  });

  it('drops a peer that never says hello, and does not stay up for it', async () => {
    // A silent connection counted as a live client kept the daemon running
    // forever (review, 2026-10-06).
    const { socketPath, onExit } = await start({ idleGraceMs: 60, helloTimeoutMs: 50 });
    const { createConnection } = await import('node:net');
    const peer = createConnection(socketPath);
    const closed = new Promise<void>((r) => peer.on('close', () => r()));
    await closed;
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith('idle'), { timeout: 2000 });
  });

  it('refuses a spawn once it is shutting down', async () => {
    const { server, socketPath } = await start();
    const c = await connect(socketPath);
    await c.call('spawn', spawnReq('t1'));
    const closing = server.close();
    await expect(c.call('spawn', spawnReq('t2'))).rejects.toThrow();
    await closing;
  });

  it('stays while a client of its own build is connected', async () => {
    const { socketPath, onExit } = await start({ idleGraceMs: 60 });
    const own = await connect(socketPath);
    await new Promise((r) => setTimeout(r, 120));
    expect(onExit).not.toHaveBeenCalled();
    own.close();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith('idle'), { timeout: 2000 });
  });

  it('shuts down on request: kills every shell, waits for them, answers, then exits', async () => {
    const { socketPath, onExit, ptys, host } = await start();
    const c = await connect(socketPath);
    await c.call('spawn', spawnReq('t1'));
    // The reply arrives - the quit waiting on it knows the shells are gone.
    expect(await c.call('shutdown')).toBe(true);
    expect(ptys[0].killed).toBe(1);
    expect(host.count).toBe(0);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith('client asked'));
    await vi.waitFor(() => expect(c.closed).toBe(true));
    expect(existsSync(socketPath)).toBe(false);
  });

  // A Windows named pipe is no file: nothing to unlink or take over by inode.
  it.skipIf(process.platform === 'win32')(
    'removes only its own socket file - a newer daemon may listen on the path by now',
    async () => {
      // The app takes a daemon for dead, removes its file and starts a
      // replacement on the same path; when the old one later exits, it must
      // not take the new one's socket with it.
      const { server: old, socketPath } = await start();
      unlinkSync(socketPath);
      const { spawn } = fakeSpawner();
      const replacement = startDaemonServer({
        socketPath,
        token: 'secret',
        buildId: 'build-1',
        appVersion: '0.4.2',
        host: new PtyHost(spawn, { shellBusy: null }),
        idleGraceMs: 60_000,
        onExit: vi.fn(),
      });
      servers.push(replacement);
      await replacement.listening;
      await old.close();
      expect(existsSync(socketPath)).toBe(true);
      const c = await connect(socketPath);
      expect(c.welcome.ok).toBe(true);
    },
  );
});

describe('splitHistory (a history too big for one reply)', () => {
  it('keeps a reply under its budget and hands the rest on, in order', () => {
    // One reply with the whole conversation could pass the frame cap and drop
    // the connection with every terminal on it (review, 2026-10-06).
    const chunks = Array.from({ length: 10 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
    const { head, rest } = splitHistory(chunks, 500);
    expect(Buffer.byteLength(JSON.stringify(head))).toBeLessThanOrEqual(500);
    expect([...head!, ...rest]).toEqual(chunks);
    expect(rest.length).toBeGreaterThan(0);
  });

  it('sends a small history whole and keeps "no conversation" null', () => {
    expect(splitHistory([{ a: 1 }])).toEqual({ head: [{ a: 1 }], rest: [] });
    expect(splitHistory(null)).toEqual({ head: null, rest: [] });
  });
});
