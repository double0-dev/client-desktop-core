import { describe, expect, it, vi } from 'vitest';
import type { HostEvent, TerminalSummary } from '../pty-host';
import type { BackendEvent } from '../terminal-backend';
import type { ExtensionEvent } from './protocol';
import type { AttachedDaemon } from './extension-channel';
import {
  DaemonBackend,
  reconnectBackoffMs,
  type ClientLike,
  type DaemonBackendDeps,
} from './daemon-backend';

/**
 * The manager's routing over fake daemons: which sockets it opens, which it
 * removes, where spawns go, and what happens when a daemon disappears.
 */

type Fake = ClientLike & {
  calls: Array<{ op: string; args: unknown }>;
  casts: Array<{ op: string; args: unknown }>;
  emit: (ev: HostEvent) => void;
  emitExtension: (ev: ExtensionEvent) => void;
  drop: () => void;
};

const summary = (id: string): TerminalSummary => ({
  id,
  cols: 80,
  rows: 24,
  markerDriven: false,
  agentStatus: 'idle',
});

function fakeClient(
  socketPath: string,
  buildId: string,
  own: string,
  terminals: string[] = [],
  welcomeExtra: Record<string, unknown> = {},
): Fake {
  const events = new Set<(ev: HostEvent) => void>();
  const extensionEvents = new Set<(ev: ExtensionEvent) => void>();
  const closes = new Set<() => void>();
  const fake: Fake = {
    socketPath,
    buildId,
    stale: buildId !== own,
    closed: false,
    welcome: { terminals: terminals.map(summary), ...welcomeExtra },
    calls: [],
    casts: [],
    call: vi.fn(async (op: string, args: unknown) => {
      fake.calls.push({ op, args });
      // A daemon refuses a spawn for an id it already holds live (pty-host).
      if (op === 'spawn')
        return (
          !fake.stale && !fake.welcome.terminals.some((t) => t.id === (args as { id: string }).id)
        );
      if (op === 'adopt')
        return { data: `ring:${(args as { id: string }).id}`, cols: 80, rows: 24 };
      if (op === 'list') return fake.welcome.terminals;
      if (op === 'size') return { cols: 80, rows: 24 };
      if (op === 'markerDriven') return (args as { ids: string[] }).ids;
      if (op === 'agentStatus')
        return (args as { ids: string[] }).ids.map((id) => ({ id, status: 'idle' }));
      return true;
    }) as Fake['call'],
    cast: (op, args) => {
      fake.casts.push({ op, args });
    },
    onEvent: (cb) => {
      events.add(cb);
      return () => events.delete(cb);
    },
    onClose: (cb) => {
      closes.add(cb);
      return () => closes.delete(cb);
    },
    onExtensionEvent: (cb) => {
      extensionEvents.add(cb);
      return () => extensionEvents.delete(cb);
    },
    emitExtension: (ev) => {
      for (const cb of extensionEvents) cb(ev);
    },
    close: () => {
      (fake as { closed: boolean }).closed = true;
    },
    emit: (ev) => {
      for (const cb of events) cb(ev);
    },
    drop: () => {
      (fake as { closed: boolean }).closed = true;
      for (const cb of closes) cb();
    },
  };
  return fake;
}

type World = {
  /** Socket path → the daemon answering there (absent = dead socket). */
  daemons: Map<string, () => Fake>;
  /** Socket path → a connect failure other than "nobody listens" (a live daemon that did not answer). */
  unreachable: Map<string, Error>;
  /** Socket path → how many connects still fail (with `unreachable`'s error) before the daemon answers. */
  slow: Map<string, number>;
  /** Connect attempts per socket path. */
  attempts: Map<string, number>;
  names: string[];
  removed: string[];
  spawned: string[];
  /** Removals and spawns in the order they happened. */
  order: string[];
  log: string[];
};

/** What node's `connect` rejects with when the socket file has no listener. */
const refused = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
/** ... and when there is no socket file at all. */
const missing = (): Error => Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function setup(world: Partial<World> = {}, own = 'b2', extra: Partial<DaemonBackendDeps> = {}) {
  const w: World = {
    daemons: new Map(),
    unreachable: new Map(),
    slow: new Map(),
    attempts: new Map(),
    names: [],
    removed: [],
    spawned: [],
    order: [],
    log: [],
    ...world,
  };
  const connected: Fake[] = [];
  const deps: DaemonBackendDeps = {
    buildId: own,
    socketPathFor: (v, b) => `/s/daemon-v${v}-${b}.sock`,
    listSocketNames: () => w.names,
    connect: async (path) => {
      w.attempts.set(path, (w.attempts.get(path) ?? 0) + 1);
      const stuck = w.unreachable.get(path);
      const left = w.slow.get(path) ?? 0;
      if (left > 0) {
        w.slow.set(path, left - 1);
        throw stuck ?? new Error('daemon handshake timed out');
      }
      if (stuck) throw stuck;
      const make = w.daemons.get(path);
      if (make) {
        const c = make();
        connected.push(c);
        return c;
      }
      // A socket file nobody listens behind refuses; no file at all is ENOENT.
      throw w.names.includes(baseName(path)) ? refused() : missing();
    },
    spawnDaemon: (path) => {
      w.spawned.push(path);
      w.order.push(`spawn ${path}`);
      // The daemon comes up by the next poll - and its socket file appears.
      w.daemons.set(path, () => fakeClient(path, own, own));
      if (!w.names.includes(baseName(path))) w.names.push(baseName(path));
    },
    removeDeadSocket: (path) => {
      w.removed.push(path);
      w.order.push(`remove ${path}`);
    },
    log: (m) => w.log.push(m),
    startTimeoutMs: 500,
    pollMs: 1,
    reconnectAttempts: 2,
    bootDeadlineMs: 20,
    bootRetryMs: 1,
    sleep: () => Promise.resolve(),
    ...extra,
  };
  const backend = new DaemonBackend(deps);
  const events: BackendEvent[] = [];
  backend.onEvent((ev) => events.push(ev));
  return { backend, w, connected, events };
}

describe('boot', () => {
  it('connects to every compatible daemon, removes dead sockets and starts its own build', async () => {
    const { backend, w, events } = setup({
      names: ['token', 'daemon-v1-b1.sock', 'daemon-v1-dead.sock', 'daemon-v9-future.sock'],
      daemons: new Map([
        ['/s/daemon-v1-b1.sock', () => fakeClient('/s/daemon-v1-b1.sock', 'b1', 'b2', ['old-tab'])],
      ]),
    });
    await backend.ready();
    expect(w.removed).toEqual(['/s/daemon-v1-dead.sock']);
    expect(w.spawned).toEqual(['/s/daemon-v1-b2.sock']);
    expect(backend.connected().sort()).toEqual(['/s/daemon-v1-b1.sock', '/s/daemon-v1-b2.sock']);
    // The older build's terminal is announced so main can route its tab to it.
    expect(events).toEqual([{ type: 'discovered', terminals: [summary('old-tab')] }]);
  });

  it('waits on its own daemon when it is slow to answer instead of starting a second one', async () => {
    // Only a refused or missing socket means nobody listens; a second daemon
    // on a live path fails to bind and only adds its timeouts (review, 2026-10-06).
    const { backend, w } = setup({
      daemons: new Map([
        ['/s/daemon-v1-b2.sock', () => fakeClient('/s/daemon-v1-b2.sock', 'b2', 'b2')],
      ]),
      slow: new Map([['/s/daemon-v1-b2.sock', 3]]),
    });
    await backend.ready();
    expect(w.spawned).toEqual([]);
    expect(backend.connected()).toEqual(['/s/daemon-v1-b2.sock']);
  });

  it('reuses a running daemon of its own build instead of starting another', async () => {
    const { backend, w } = setup({
      names: ['daemon-v1-b2.sock'],
      daemons: new Map([
        ['/s/daemon-v1-b2.sock', () => fakeClient('/s/daemon-v1-b2.sock', 'b2', 'b2', ['t'])],
      ]),
    });
    await backend.ready();
    expect(w.spawned).toEqual([]);
    expect(await backend.list()).toEqual([summary('t')]);
  });

  it('leaves the socket of a daemon that is there but did not answer in time', async () => {
    // A handshake timeout, a refused hello, a close mid-handshake: a daemon
    // IS listening. Unlinking its socket would orphan every terminal it holds
    // - alive, and unreachable on every later launch.
    const { backend, w } = setup({
      names: ['daemon-v1-b1.sock', 'daemon-v1-b0.sock'],
      unreachable: new Map([
        ['/s/daemon-v1-b1.sock', new Error('daemon handshake timed out')],
        ['/s/daemon-v1-b0.sock', new Error('daemon refused: token')],
      ]),
    });
    await backend.ready();
    expect(w.removed).toEqual([]);
    expect(w.log.filter((m) => m.includes('left alone'))).toHaveLength(2);
    expect(backend.connected()).toEqual(['/s/daemon-v1-b2.sock']);
    // Retried until the boot deadline, not written off on the first miss. The
    // deadline is one for the whole folder: b0 (first in build-id order) used
    // it up, so b1 got a single attempt - a boot with several slow daemons
    // still ends.
    expect(w.attempts.get('/s/daemon-v1-b0.sock')!).toBeGreaterThan(1);
    expect(w.attempts.get('/s/daemon-v1-b1.sock')).toBe(1);
  });

  it('keeps retrying a daemon that is slow to answer and does not resolve ready() without it', async () => {
    // A daemon busy with its ptys may miss the first hello. Giving up on it
    // read as "its terminals are gone": the crash-recovery sweep reset their
    // sessions and the renderer spawned duplicates under its ids. ready()
    // waits for the retries, so neither ever sees that half-known world.
    const slowOne = fakeClient('/s/daemon-v1-b1.sock', 'b1', 'b2', ['kept-tab']);
    const { backend, w, events } = setup({
      names: ['daemon-v1-b1.sock'],
      daemons: new Map([['/s/daemon-v1-b1.sock', () => slowOne]]),
      slow: new Map([['/s/daemon-v1-b1.sock', 2]]),
    });
    let ready = false;
    void backend.ready().then(() => {
      ready = true;
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: 'discovered', terminals: [summary('kept-tab')] }),
    );
    await backend.ready();
    expect(ready).toBe(true);
    expect(w.attempts.get('/s/daemon-v1-b1.sock')).toBe(3);
    expect(w.removed).toEqual([]);
    expect(backend.connected().sort()).toEqual(['/s/daemon-v1-b1.sock', '/s/daemon-v1-b2.sock']);
  });

  it('gives up on a daemon that never answers once the boot deadline passes, and still starts', async () => {
    const start = Date.now();
    const { backend, w } = setup({
      names: ['daemon-v1-b1.sock'],
      unreachable: new Map([['/s/daemon-v1-b1.sock', new Error('daemon handshake timed out')]]),
    });
    await backend.ready();
    // Bounded by the deadline (20 ms here), not by a fixed attempt count.
    expect(Date.now() - start).toBeLessThan(1000);
    expect(w.removed).toEqual([]);
    expect(w.spawned).toEqual(['/s/daemon-v1-b2.sock']);
  });

  it('does nothing about a socket that vanished between the listing and the connect', async () => {
    // Its daemon idle-exited meanwhile and unlinked the file itself.
    const { backend, w } = setup({
      names: ['daemon-v1-b1.sock'],
      unreachable: new Map([
        ['/s/daemon-v1-b1.sock', Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' })],
      ]),
    });
    await backend.ready();
    expect(w.removed).toEqual([]);
    expect(w.attempts.get('/s/daemon-v1-b1.sock')).toBe(1);
  });

  it('rejects ready when its daemon never answers, so main falls back in-process', async () => {
    const { backend } = setup({
      daemons: new Map(),
    });
    // The spawner above makes the daemon appear; this one never does.
    const silent = new DaemonBackend({
      buildId: 'b2',
      socketPathFor: (v, b) => `/s/daemon-v${v}-${b}.sock`,
      listSocketNames: () => [],
      connect: async () => {
        throw refused();
      },
      spawnDaemon: () => {},
      removeDeadSocket: () => {},
      log: () => {},
      startTimeoutMs: 5,
      pollMs: 1,
    });
    await expect(silent.ready()).rejects.toThrow(/did not answer/);
    await backend.ready();
  });
});

describe('routing', () => {
  async function booted() {
    const old = fakeClient('/s/daemon-v1-b1.sock', 'b1', 'b2', ['old-tab']);
    const ctx = setup({
      names: ['daemon-v1-b1.sock'],
      daemons: new Map([['/s/daemon-v1-b1.sock', () => old]]),
    });
    await ctx.backend.ready();
    const own = ctx.connected.find((c) => c.buildId === 'b2')!;
    return { ...ctx, old, own };
  }

  it('sends new spawns to its own build only and drives each terminal through the daemon holding it', async () => {
    const { backend, old, own } = await booted();
    const req = {
      id: 'new-tab',
      file: '/bin/zsh',
      args: [],
      cwd: '/',
      env: {},
      name: 'x',
      cols: 1,
      rows: 1,
      markerDriven: false,
    };
    expect(await backend.spawn(req)).toBe(true);
    expect(own.calls).toContainEqual({ op: 'spawn', args: req });
    expect(old.calls.find((c) => c.op === 'spawn')).toBeUndefined();
    backend.input('old-tab', 'ls');
    backend.input('new-tab', 'pwd');
    backend.resize('old-tab', 10, 5);
    expect(old.casts).toEqual([
      { op: 'input', args: { id: 'old-tab', data: 'ls' } },
      { op: 'resize', args: { id: 'old-tab', cols: 10, rows: 5 } },
    ]);
    expect(own.casts).toEqual([{ op: 'input', args: { id: 'new-tab', data: 'pwd' } }]);
    expect(await backend.adopt('old-tab')).toEqual({ data: 'ring:old-tab', cols: 80, rows: 24 });
    expect(await backend.adopt('unknown')).toBeNull();
    // Queries fan out by holder and merge.
    expect(await backend.markerDriven(['old-tab', 'new-tab', 'unknown'])).toEqual([
      'old-tab',
      'new-tab',
    ]);
    expect(await backend.agentStatus(['new-tab'])).toEqual([{ id: 'new-tab', status: 'idle' }]);
    // The tone goes everywhere.
    backend.setTone(false);
    expect(old.casts.at(-1)).toEqual({ op: 'setTone', args: { dark: false } });
    expect(own.casts.at(-1)).toEqual({ op: 'setTone', args: { dark: false } });
  });

  it('lists every daemon with the terminals it holds - the move of idle sessions reads it', async () => {
    const { backend } = await booted();
    await backend.spawn({
      id: 'new-tab',
      file: '/bin/zsh',
      args: [],
      cwd: '/',
      env: {},
      name: 'x',
      cols: 1,
      rows: 1,
      markerDriven: false,
    });
    const byBuild = Object.fromEntries(backend.daemons().map((d) => [d.buildId, d]));
    expect(byBuild.b1).toMatchObject({
      socketPath: '/s/daemon-v1-b1.sock',
      current: false,
      ids: ['old-tab'],
    });
    expect(byBuild.b2).toMatchObject({ current: true, ids: ['new-tab'] });
    // A kill takes the id off its daemon's list at once.
    backend.kill('old-tab');
    expect(backend.daemons().find((d) => d.buildId === 'b1')?.ids).toEqual([]);
  });

  it("forwards a holder's events and drops the route on exit and kill", async () => {
    const { backend, old, own, events } = await booted();
    events.length = 0;
    old.emit({ type: 'data', id: 'old-tab', data: 'x' });
    // A daemon only speaks for terminals routed to it.
    own.emit({ type: 'data', id: 'old-tab', data: 'spoof' });
    old.emit({ type: 'exit', id: 'old-tab', exitCode: 0 });
    expect(events).toEqual([
      { type: 'data', id: 'old-tab', data: 'x' },
      { type: 'exit', id: 'old-tab', exitCode: 0 },
    ]);
    backend.input('old-tab', 'gone');
    expect(old.casts).toEqual([]);
    await backend.spawn({
      id: 't',
      file: '/bin/zsh',
      args: [],
      cwd: '/',
      env: {},
      name: 'x',
      cols: 1,
      rows: 1,
      markerDriven: false,
    });
    backend.kill('t');
    expect(own.casts.at(-1)).toEqual({ op: 'kill', args: { id: 't' } });
    backend.input('t', 'x');
    expect(own.casts.at(-1)).toEqual({ op: 'kill', args: { id: 't' } });
  });

  it('hands back a spawn for an id its daemon still holds, so the caller adopts it', async () => {
    // A daemon reported lost while it was merely stalled keeps its shells;
    // the reopened tab's spawn is refused there. Orphaning it made every
    // reopen fail the same way (review, 2026-10-06).
    const { backend, own } = await booted();
    own.welcome.terminals.push({ id: 'kept' } as never);
    const req = {
      id: 'kept',
      file: '/bin/zsh',
      args: [],
      cwd: '/',
      env: {},
      name: 'x',
      cols: 1,
      rows: 1,
      markerDriven: false,
    };
    expect(await backend.spawn(req)).toBe('existing');
    // Still routed there: the adopt and the input reach it.
    expect(await backend.adopt('kept')).toEqual({ data: 'ring:kept', cols: 80, rows: 24 });
    backend.input('kept', 'ls');
    expect(own.casts).toContainEqual({ op: 'input', args: { id: 'kept', data: 'ls' } });
  });

  it('keeps one connection when a spawn reconnects while the drop is still retrying', async () => {
    // Both the reconnect loop and a spawn's startOwn used to attach - the
    // first connection stayed open unreferenced, so the daemon never idled
    // out while the app ran (review, 2026-10-06).
    const { backend, own, connected } = await booted();
    const req = (id: string) => ({
      id,
      file: '/bin/zsh',
      args: [],
      cwd: '/',
      env: {},
      name: 'x',
      cols: 1,
      rows: 1,
      markerDriven: false,
    });
    await backend.spawn(req('t1'));
    own.drop();
    await backend.spawn(req('t2'));
    await new Promise((r) => setTimeout(r, 20));
    const open = connected.filter((c) => c.socketPath === own.socketPath && !c.closed);
    expect(open).toHaveLength(1);
  });

  it('reports the terminals of a daemon that vanished as lost, and starts a fresh one for the next spawn', async () => {
    const { backend, own, w, events } = await booted();
    await backend.spawn({
      id: 't1',
      file: '/bin/zsh',
      args: [],
      cwd: '/',
      env: {},
      name: 'x',
      cols: 1,
      rows: 1,
      markerDriven: false,
    });
    events.length = 0;
    w.daemons.delete('/s/daemon-v1-b2.sock');
    own.drop();
    await vi.waitFor(() => expect(events).toEqual([{ type: 'lost', ids: ['t1'] }]));
    expect(w.spawned).toEqual(['/s/daemon-v1-b2.sock']);
    w.order.length = 0;
    expect(
      await backend.spawn({
        id: 't2',
        file: '/bin/zsh',
        args: [],
        cwd: '/',
        env: {},
        name: 'x',
        cols: 1,
        rows: 1,
        markerDriven: false,
      }),
    ).toBe(true);
    expect(w.spawned).toEqual(['/s/daemon-v1-b2.sock', '/s/daemon-v1-b2.sock']);
    // The crashed daemon's socket file is still on disk and a new daemon
    // cannot bind the path while it is (EADDRINUSE) - so it goes first. Until
    // this, no new terminal could be opened after a daemon crash before the
    // next app start swept the folder.
    expect(w.order).toEqual(['remove /s/daemon-v1-b2.sock', 'spawn /s/daemon-v1-b2.sock']);
  });

  it('an id two older daemons both hold stays with the first and is ended in the second', async () => {
    // Listed in the other order on purpose: the folder's order is not the rule.
    const first = fakeClient('/s/daemon-v1-b0.sock', 'b0', 'b2', ['shared', 'only-first']);
    const second = fakeClient('/s/daemon-v1-b1.sock', 'b1', 'b2', ['shared', 'only-second']);
    const { backend, w, events } = setup({
      names: ['daemon-v1-b1.sock', 'daemon-v1-b0.sock'],
      daemons: new Map([
        ['/s/daemon-v1-b0.sock', () => first],
        ['/s/daemon-v1-b1.sock', () => second],
      ]),
    });
    await backend.ready();
    backend.input('shared', 'x');
    expect(first.casts).toEqual([{ op: 'input', args: { id: 'shared', data: 'x' } }]);
    // The losing copy is ended the way a tab close ends a shell - a plain
    // kill (SIGHUP through the pty), never SIGKILL.
    expect(second.casts).toEqual([{ op: 'kill', args: { id: 'shared' } }]);
    // The second daemon's copy is not announced as a terminal to adopt.
    expect(events.filter((e) => e.type === 'discovered')).toEqual([
      { type: 'discovered', terminals: [summary('shared'), summary('only-first')] },
      { type: 'discovered', terminals: [summary('only-second')] },
    ]);
    expect(w.log.some((m) => m.includes('held by two daemons'))).toBe(true);
  });

  it("this build's daemon wins a twice-held id whichever side of it attached - the respawn ran there", async () => {
    // An older daemon given up for lost at some point still holds the id; the
    // tab was respawned on this build's daemon since. Attached after the old
    // one here (b1 sorts before b2) ...
    const old = fakeClient('/s/daemon-v1-b1.sock', 'b1', 'b2', ['shared']);
    const own = fakeClient('/s/daemon-v1-b2.sock', 'b2', 'b2', ['shared', 'mine']);
    const ctx = setup({
      names: ['daemon-v1-b1.sock', 'daemon-v1-b2.sock'],
      daemons: new Map([
        ['/s/daemon-v1-b1.sock', () => old],
        ['/s/daemon-v1-b2.sock', () => own],
      ]),
    });
    await ctx.backend.ready();
    ctx.backend.input('shared', 'x');
    expect(own.casts).toEqual([{ op: 'input', args: { id: 'shared', data: 'x' } }]);
    expect(old.casts).toEqual([{ op: 'kill', args: { id: 'shared' } }]);
    expect(ctx.w.spawned).toEqual([]);

    // ... and attached before it (b9 sorts after b2).
    const later = fakeClient('/s/daemon-v1-b9.sock', 'b9', 'b2', ['shared']);
    const own2 = fakeClient('/s/daemon-v1-b2.sock', 'b2', 'b2', ['shared']);
    const ctx2 = setup({
      names: ['daemon-v1-b2.sock', 'daemon-v1-b9.sock'],
      daemons: new Map([
        ['/s/daemon-v1-b2.sock', () => own2],
        ['/s/daemon-v1-b9.sock', () => later],
      ]),
    });
    await ctx2.backend.ready();
    ctx2.backend.input('shared', 'y');
    expect(own2.casts).toEqual([{ op: 'input', args: { id: 'shared', data: 'y' } }]);
    expect(later.casts).toEqual([{ op: 'kill', args: { id: 'shared' } }]);
    // Only the surviving copy was announced.
    expect(ctx2.events.filter((e) => e.type === 'discovered')).toEqual([
      { type: 'discovered', terminals: [summary('shared')] },
    ]);
  });

  it('re-reaches a daemon whose socket only hiccupped and loses nothing it still holds', async () => {
    const { backend, own, w, events } = await booted();
    await backend.spawn({
      id: 't1',
      file: '/bin/zsh',
      args: [],
      cwd: '/',
      env: {},
      name: 'x',
      cols: 1,
      rows: 1,
      markerDriven: false,
    });
    await backend.spawn({
      id: 't2',
      file: '/bin/zsh',
      args: [],
      cwd: '/',
      env: {},
      name: 'x',
      cols: 1,
      rows: 1,
      markerDriven: false,
    });
    events.length = 0;
    // Still running, holding t1 only (t2 ended meanwhile).
    w.daemons.set('/s/daemon-v1-b2.sock', () =>
      fakeClient('/s/daemon-v1-b2.sock', 'b2', 'b2', ['t1']),
    );
    own.drop();
    await vi.waitFor(() => expect(events.some((e) => e.type === 'lost')).toBe(true));
    expect(events).toEqual([
      { type: 'discovered', terminals: [summary('t1')] },
      { type: 'lost', ids: ['t2'] },
    ]);
    // Only the boot spawn - the hiccup started no second daemon.
    expect(w.spawned).toEqual(['/s/daemon-v1-b2.sock']);
  });
});

describe('quit', () => {
  it('keeps sessions by letting go of the sockets, or stops them through every daemon', async () => {
    const old = fakeClient('/s/daemon-v1-b1.sock', 'b1', 'b2', ['old-tab']);
    const ctx = setup({
      names: ['daemon-v1-b1.sock'],
      daemons: new Map([['/s/daemon-v1-b1.sock', () => old]]),
    });
    await ctx.backend.ready();
    const own = ctx.connected.find((c) => c.buildId === 'b2')!;
    await ctx.backend.shutdown({ stopSessions: false });
    expect(old.calls.find((c) => c.op === 'shutdown')).toBeUndefined();
    expect(old.closed).toBe(true);
    expect(own.closed).toBe(true);
    // No "lost" for a quit - the terminals live on.
    expect(ctx.events.filter((e) => e.type === 'lost')).toEqual([]);

    const old2 = fakeClient('/s/daemon-v1-b1.sock', 'b1', 'b2', ['old-tab']);
    const ctx2 = setup({
      names: ['daemon-v1-b1.sock'],
      daemons: new Map([['/s/daemon-v1-b1.sock', () => old2]]),
    });
    await ctx2.backend.ready();
    await ctx2.backend.shutdown({ stopSessions: true });
    expect(old2.calls).toContainEqual({ op: 'shutdown', args: {} });
    await ctx2.backend.killAll();
  });
});

// An extension's work in the daemon (`gadget*` stands for any): its channel
// reaches this build's daemon only, and it sees every daemon attached.
describe("an extension's channel and attach hook", () => {
  const OLD = '/s/daemon-v1-b1.sock';
  const OWN = '/s/daemon-v1-b2.sock';
  const status = (sessionId: string): ExtensionEvent => ({
    type: 'gadget-status',
    sessionId,
    status: 'active',
  });

  it("calls go to this build's daemon and only its extension events come back", async () => {
    const { backend, connected } = setup({
      names: ['daemon-v1-b1.sock'],
      daemons: new Map([[OLD, () => fakeClient(OLD, 'b1', 'b2')]]),
    });
    const channel = await backend.extensionChannel();
    const seen: ExtensionEvent[] = [];
    channel.onEvent((ev) => seen.push(ev));
    await channel.call('gadgetLive', {});
    const own = connected.find((c) => c.socketPath === OWN)!;
    const old = connected.find((c) => c.socketPath === OLD)!;
    expect(own.calls).toContainEqual({ op: 'gadgetLive', args: {} });
    expect(old.calls.some((c) => c.op.startsWith('gadget'))).toBe(false);
    old.emitExtension(status('a'));
    own.emitExtension(status('b'));
    expect(seen).toEqual([status('b')]);
  });

  it('shows the extension every daemon attached - which is current, its welcome, a way to cast', async () => {
    const seen: AttachedDaemon[] = [];
    const { backend, connected } = setup(
      {
        names: ['daemon-v1-b1.sock'],
        daemons: new Map([[OLD, () => fakeClient(OLD, 'b1', 'b2', [], { gadgets: 2 })]]),
      },
      'b2',
      { onAttach: (daemon) => seen.push(daemon) },
    );
    await backend.ready();
    const old = seen.find((d) => !d.current)!;
    expect(old.welcome.gadgets).toBe(2);
    // Nothing is cast unless the extension asks.
    expect(connected.find((c) => c.socketPath === OLD)!.casts).toEqual([]);
    old.cast('gadgetStopAll', {});
    expect(connected.find((c) => c.socketPath === OLD)!.casts).toEqual([
      { op: 'gadgetStopAll', args: {} },
    ]);
    // This build's daemon, started on demand, is seen as current.
    await backend.extensionChannel().then((c) => c.call('gadgetLive', {}));
    expect(seen.some((d) => d.current)).toBe(true);
  });

  it("reports the extension's work lost when this build's daemon is gone for good", async () => {
    const { backend, w, connected } = setup();
    const channel = await backend.extensionChannel();
    const lost = vi.fn();
    channel.onLost(lost);
    const own = connected.find((c) => c.socketPath === OWN)!;
    w.daemons.delete(OWN);
    own.drop();
    await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
  });
});

describe("a remote host's daemon (patient loss policy)", () => {
  // a private plan › 9.2: a network cut must never read
  // as "the terminals are gone" - they run on the host whatever the laptop's
  // network does. Only a reconnected daemon that no longer lists an id may
  // make it lost.
  const own = '/s/daemon-v1-b2.sock';
  const patient = (w: Partial<World>, delays: number[] = []) =>
    setup(w, 'b2', {
      lossPolicy: 'patient',
      backoffMs: (n) => {
        delays.push(n);
        return 0;
      },
    });

  it('reports a drop unreachable - never lost - and reachable once the host answers', async () => {
    const delays: number[] = [];
    const daemons = new Map([[own, () => fakeClient(own, 'b2', 'b2', ['t1', 't2'])]]);
    const { backend, w, connected, events } = patient(
      { names: ['daemon-v1-b2.sock'], daemons },
      delays,
    );
    await backend.ready();
    events.length = 0;
    // The network is cut for three attempts (a timed-out bridge, not a dead
    // socket); the host kept t1 alive, t2 ended there meanwhile.
    daemons.set(own, () => fakeClient(own, 'b2', 'b2', ['t1']));
    w.slow.set(own, 3);
    connected[0].drop();
    await vi.waitFor(() => expect(events.some((e) => e.type === 'reachable')).toBe(true));
    expect(events[0]).toEqual({ type: 'unreachable', ids: ['t1', 't2'] });
    // Never `lost` while it could not reach the host: only after it answered.
    const lostAt = events.findIndex((e) => e.type === 'lost');
    expect(lostAt).toBeGreaterThan(0);
    expect(events[lostAt]).toEqual({ type: 'lost', ids: ['t2'] });
    expect(events.find((e) => e.type === 'reachable')).toEqual({ type: 'reachable', ids: ['t1'] });
    // Backoff attempts 0, 1, 2 failed, 3 answered.
    expect(delays).toEqual([0, 1, 2, 3]);
    // The live id is routed to the new connection: input reaches it.
    backend.input('t1', 'ls\r');
    expect(connected[connected.length - 1].casts).toContainEqual({
      op: 'input',
      args: { id: 't1', data: 'ls\r' },
    });
  });

  it("keeps trying past the quick policy's attempts", async () => {
    const daemons = new Map([[own, () => fakeClient(own, 'b2', 'b2', ['t1'])]]);
    const { backend, w, connected, events } = patient({ names: ['daemon-v1-b2.sock'], daemons });
    await backend.ready();
    events.length = 0;
    // `reconnectAttempts: 2` would have given up and reported t1 lost.
    w.slow.set(own, 12);
    connected[0].drop();
    await vi.waitFor(() => expect(events.some((e) => e.type === 'reachable')).toBe(true));
    expect(events.filter((e) => e.type === 'lost')).toEqual([]);
    expect(w.attempts.get(own)).toBeGreaterThan(12);
  });

  it("reports an older build's terminals lost when the host says its socket is gone", async () => {
    const old = '/s/daemon-v1-b1.sock';
    const daemons = new Map([
      [old, () => fakeClient(old, 'b1', 'b2', ['drained'])],
      [own, () => fakeClient(own, 'b2', 'b2')],
    ]);
    const { backend, connected, events } = patient({
      names: ['daemon-v1-b1.sock', 'daemon-v1-b2.sock'],
      daemons,
    });
    await backend.ready();
    events.length = 0;
    daemons.delete(old);
    // ENOENT through the bridge: the older daemon idle-exited, its socket went.
    connected.find((c) => c.socketPath === old)!.drop();
    await vi.waitFor(() => expect(events.some((e) => e.type === 'lost')).toBe(true));
    expect(events).toEqual([
      { type: 'unreachable', ids: ['drained'] },
      { type: 'lost', ids: ['drained'] },
    ]);
  });

  it("tells the extension only when THIS build's daemon is gone for good (plan 29 › M6)", async () => {
    const old = '/s/daemon-v1-b1.sock';
    const daemons = new Map([
      [old, () => fakeClient(old, 'b1', 'b2', ['drained'])],
      [own, () => fakeClient(own, 'b2', 'b2', ['t1'])],
    ]);
    const { backend, connected, events } = patient({
      names: ['daemon-v1-b1.sock', 'daemon-v1-b2.sock'],
      daemons,
    });
    let lost = 0;
    backend.onExtensionLost(() => lost++);
    await backend.ready();
    // An older build's daemon draining away takes none of our work.
    daemons.delete(old);
    connected.find((c) => c.socketPath === old)!.drop();
    await vi.waitFor(() => expect(events.some((e) => e.type === 'lost')).toBe(true));
    expect(lost).toBe(0);
    // Our own daemon crashed on the host: its agents went with it.
    daemons.delete(own);
    connected.find((c) => c.socketPath === own)!.drop();
    await vi.waitFor(() => expect(lost).toBe(1));
  });

  it('stops retrying on shutdown', async () => {
    const daemons = new Map([[own, () => fakeClient(own, 'b2', 'b2', ['t1'])]]);
    const { backend, w, connected } = patient({ names: ['daemon-v1-b2.sock'], daemons });
    await backend.ready();
    w.slow.set(own, 1_000_000);
    connected[0].drop();
    await backend.shutdown({ stopSessions: false });
    const before = w.attempts.get(own) ?? 0;
    await new Promise((r) => setTimeout(r, 5));
    expect((w.attempts.get(own) ?? 0) - before).toBeLessThanOrEqual(1);
  });

  it('closes a reconnect that lands after shutdown instead of attaching it', async () => {
    // Connect clicked while unreachable drops this backend; its reconnect in
    // flight must not attach - that leaked the ssh bridge and the client.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const clients: Fake[] = [];
    let calls = 0;
    const { backend, events } = setup({ names: ['daemon-v1-b2.sock'] }, 'b2', {
      lossPolicy: 'patient',
      backoffMs: () => 0,
      connect: async (path) => {
        calls += 1;
        // The reconnect's bridge is still opening when shutdown runs.
        if (calls > 1) await gate;
        const c = fakeClient(path, 'b2', 'b2', ['t1']);
        clients.push(c);
        return c;
      },
    });
    await backend.ready();
    events.length = 0;
    clients[0].drop();
    await new Promise((r) => setTimeout(r, 1));
    expect(calls).toBe(2);
    await backend.shutdown({ stopSessions: false });
    release();
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 1));
    expect(clients[1].closed).toBe(true);
    expect(backend.connected()).toEqual([]);
    expect(events.filter((e) => e.type === 'reachable' || e.type === 'discovered')).toEqual([]);
  });

  it('backs off 1, 2, 4 … 32 s, then every 60 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 50].map(reconnectBackoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });
});

describe('a daemon several apps share (a private plan › 14, M4)', () => {
  const own = '/s/daemon-v1-b2.sock';
  type ViewListener = Parameters<NonNullable<ClientLike['onViewEvent']>>[0];
  /** A fake of a multi-client daemon: caps, a connection id, peers, view events. */
  const shared = (terminals: string[] = [], peers = { own: 0, other: 0 }) => {
    const views = new Set<ViewListener>();
    const make = (): Fake & { view: ViewListener } => {
      const c = fakeClient(own, 'b2', 'b2', terminals) as Fake & { view: ViewListener };
      c.welcome = { ...c.welcome, caps: ['resizeIntents', 'peers'], connectionId: 7, peers };
      c.onViewEvent = (cb) => {
        views.add(cb);
        return () => views.delete(cb);
      };
      c.view = (ev) => {
        for (const cb of views) cb(ev);
      };
      return c;
    };
    return make;
  };

  it('sends a resize intent with its kind to such a daemon, and a plain resize to any other', async () => {
    const make = shared(['t1']);
    const { backend, connected } = setup({
      names: ['daemon-v1-b2.sock'],
      daemons: new Map([[own, make]]),
    });
    await backend.ready();
    backend.resize('t1', 100, 30, 'passive');
    backend.resize('t1', 120, 40);
    expect(connected[0].casts).toEqual([
      { op: 'resizeIntent', args: { id: 't1', cols: 100, rows: 30, kind: 'passive', seq: 1 } },
      // No kind = a claim (the old "last resize wins").
      { op: 'resizeIntent', args: { id: 't1', cols: 120, rows: 40, kind: 'claim', seq: 2 } },
    ]);
    const local = setup({
      names: ['daemon-v1-b2.sock'],
      daemons: new Map([[own, () => fakeClient(own, 'b2', 'b2', ['t1'])]]),
    });
    await local.backend.ready();
    local.backend.resize('t1', 100, 30, 'passive');
    expect(local.connected[0].casts).toEqual([
      { op: 'resize', args: { id: 't1', cols: 100, rows: 30 } },
    ]);
  });

  it("turns the daemon's grid into this app's or another's, and a snapshot notice into a re-adopt", async () => {
    const make = shared(['t1']);
    const { backend, connected, events } = setup({
      names: ['daemon-v1-b2.sock'],
      daemons: new Map([[own, make]]),
    });
    await backend.ready();
    events.length = 0;
    const c = connected[0] as ReturnType<typeof make>;
    c.view({ type: 'terminal-size', id: 't1', cols: 90, rows: 20, by: 3 });
    c.view({ type: 'terminal-size', id: 't1', cols: 100, rows: 30, by: 7 });
    c.view({ type: 'snapshot-needed', id: 't1' });
    // Not routed to this daemon: not ours to speak for.
    c.view({ type: 'terminal-size', id: 'other', cols: 1, rows: 1, by: 3 });
    expect(events).toEqual([
      { type: 'grid', id: 't1', cols: 90, rows: 20, own: false },
      { type: 'grid', id: 't1', cols: 100, rows: 30, own: true },
      { type: 'snapshot-needed', id: 't1' },
    ]);
  });

  it("drops another app's grid that crossed this app's newer claim on the wire (claim cross-fire)", async () => {
    const make = shared(['t1']);
    const { backend, connected, events } = setup({
      names: ['daemon-v1-b2.sock'],
      daemons: new Map([[own, make]]),
    });
    await backend.ready();
    events.length = 0;
    const c = connected[0] as ReturnType<typeof make>;
    // We claim (seq 1)... and A's claim, applied just before ours, arrives first.
    backend.resize('t1', 90, 30, 'claim');
    c.view({ type: 'terminal-size', id: 't1', cols: 120, rows: 40, by: 3, seq: 9 });
    // Our claim comes back: ours.
    c.view({ type: 'terminal-size', id: 't1', cols: 90, rows: 30, by: 7, seq: 1 });
    // From now on A's grids count again.
    c.view({ type: 'terminal-size', id: 't1', cols: 120, rows: 40, by: 3, seq: 10 });
    expect(events).toEqual([
      { type: 'grid', id: 't1', cols: 90, rows: 30, own: true },
      { type: 'grid', id: 't1', cols: 120, rows: 40, own: false },
    ]);
  });

  it('counts the other apps attached - and none for a daemon that cannot say (this laptop after an update)', async () => {
    const make = shared([], { own: 1, other: 0 });
    const old = '/s/daemon-v1-b1.sock';
    const daemons = new Map<string, () => Fake>([
      [own, make],
      [old, () => fakeClient(old, 'b1', 'b2', ['kept'])],
    ]);
    const { backend, connected } = setup({
      names: ['daemon-v1-b1.sock', 'daemon-v1-b2.sock'],
      daemons,
    });
    const changes: number[] = [];
    backend.onPeersChange(() => changes.push(backend.peers()));
    await backend.ready();
    // The older build's daemon (no count in its welcome) is not "another computer".
    expect(backend.peers()).toBe(1);
    const c = connected.find((x) => x.socketPath === own) as ReturnType<typeof make>;
    c.view({ type: 'peers', own: 0, other: 0 });
    expect(backend.peers()).toBe(0);
    expect(changes.at(-1)).toBe(0);
    daemons.delete(old);
    connected.find((x) => x.socketPath === old)!.drop();
    await vi.waitFor(() => expect(backend.peers()).toBe(0));
  });

  it('reports a spawn whose reply went down with the bridge as outcome unknown - never a failure', async () => {
    const make = shared();
    const { backend, connected } = setup(
      { names: ['daemon-v1-b2.sock'], daemons: new Map([[own, make]]) },
      'b2',
      { lossPolicy: 'patient', backoffMs: () => 1_000_000 },
    );
    await backend.ready();
    const c = connected[0];
    (c.call as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw Object.assign(new Error('daemon connection closed'), { code: 'EOUTCOMEUNKNOWN' });
    });
    expect(await backend.spawn({ ...spawnRequest('t9') })).toBe('unknown');
    // Any other failure is still a failure.
    (c.call as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('bad args');
    });
    expect(await backend.spawn({ ...spawnRequest('t10') })).toBe(false);
  });
});

function spawnRequest(id: string) {
  return {
    id,
    file: '/bin/zsh',
    args: [],
    cwd: '/tmp',
    env: {},
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    markerDriven: false,
  };
}
