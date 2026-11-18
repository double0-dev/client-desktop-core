import { describe, expect, it, vi } from 'vitest';

/**
 * The preload bridge is pure marshalling - every renderer call crosses it, and
 * nothing type-checks the channel string or the payload shape on the other
 * side. The failure modes are silent: a swapped argument reaches main as the
 * wrong field, a listener hands the renderer an IpcRendererEvent instead of the
 * payload, an unsubscribe that does not unsubscribe leaks a listener per mount.
 *
 * `ipcRenderer` is recorded rather than stubbed per-test so the whole surface
 * can be walked generically.
 */

const invoke = vi.fn(async () => ({}));
const send = vi.fn();
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

const on = vi.fn((channel: string, fn: (...args: unknown[]) => void) => {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel)!.add(fn);
});
const removeListener = vi.fn((channel: string, fn: (...args: unknown[]) => void) => {
  listeners.get(channel)?.delete(fn);
});

type Exposed = { key: string; value: Record<string, unknown> };
let exposed: Exposed | null = null;

vi.mock('electron', () => {
  const ipcRenderer = { invoke, send, on, removeListener, once: on };
  const contextBridge = {
    exposeInMainWorld: (key: string, value: Record<string, unknown>) => {
      // An extension's preload may expose its bridge keys first; the app's own
      // `api` surface is exposed last, so last-write-wins keeps the test on it.
      exposed = { key, value };
    },
  };
  // An extension's preload may import electron's default export too.
  return { ipcRenderer, contextBridge, default: { ipcRenderer, contextBridge } };
});

// What the official run's `@pro/preload` pulls from node_modules is mocked in
// Pro's own setup file (vitest.config.ts › main setupFiles).

// The packaged app always runs context-isolated; take that branch rather than
// the `window.api =` fallback (there is no window in this project).
Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true });

const { api } = (await import('./index')) as unknown as { api: Record<string, never> };
type Api = Record<string, Record<string, (...args: unknown[]) => unknown>>;
const bridge = ((exposed as Exposed | null)?.value ?? api) as unknown as Api;

/** Fire the payload main would send on `channel`, as ipcRenderer would. */
const emit = (channel: string, ...payload: unknown[]): void => {
  const event = { sender: {}, senderId: 0 };
  for (const fn of listeners.get(channel) ?? []) fn(event, ...payload);
};

const namespaces = Object.keys(bridge);

describe('what gets exposed', () => {
  it('exposes exactly one curated surface, named api', () => {
    expect((exposed as Exposed | null)?.key).toBe('api');
  });

  it('never exposes the raw electron bridge', () => {
    // The @electron-toolkit electronAPI would hand a renderer compromise
    // arbitrary-channel IPC and process.env.
    expect(namespaces).not.toContain('electron');
    expect(namespaces).not.toContain('electronAPI');
    expect(namespaces).not.toContain('ipcRenderer');
  });

  it('covers the app’s subsystems', () => {
    // Core's own; Pro's bridges (integrations, jira, ...) are spread in from
    // the official build and are absent in the core build (a private plan).
    for (const ns of ['fs', 'git', 'db', 'terminal', 'layout', 'files']) {
      expect(namespaces, ns).toContain(ns);
    }
  });

  it('exposes only functions and namespaces of functions', () => {
    // A few helpers (selectDirectory, saveTextFile) sit at the top level; the
    // rest are grouped. Nothing else - no raw objects, no channel strings.
    for (const key of namespaces) {
      const value = bridge[key] as unknown;
      if (typeof value === 'function') continue;
      expect(typeof value, key).toBe('object');
      for (const [name, member] of Object.entries(value as object)) {
        expect(typeof member, `${key}.${name}`).toBe('function');
      }
    }
  });
});

describe('argument marshalling', () => {
  const callOf = (fn: () => unknown): [string, unknown] => {
    invoke.mockClear();
    fn();
    expect(invoke, 'expected the call to reach ipcRenderer.invoke').toHaveBeenCalledTimes(1);
    return invoke.mock.calls[0] as unknown as [string, unknown];
  };

  it('names each fs argument rather than passing positionally', () => {
    // `rename(from, to)` reversed would move the wrong file; the payload is
    // keyed so main cannot silently take them in the other order.
    expect(callOf(() => bridge.fs.rename('/a/old.ts', '/a/new.ts'))).toEqual([
      'fs:rename',
      { from: '/a/old.ts', to: '/a/new.ts' },
    ]);
  });

  it('passes a file read as a path payload', () => {
    expect(callOf(() => bridge.fs.readFile('/a/b.ts'))).toEqual([
      'fs:readFile',
      { path: '/a/b.ts' },
    ]);
  });

  it('marshals a db insert as table + row', () => {
    const row = { id: '1', name: 'acme' };
    expect(callOf(() => bridge.db.insert('projects', row))).toEqual([
      'db:insert',
      { table: 'projects', row },
    ]);
  });

  it('marshals a db update as table + id + patch', () => {
    expect(callOf(() => bridge.db.update('projects', 'id-1', { name: 'new' }))).toEqual([
      'db:update',
      { table: 'projects', id: 'id-1', patch: { name: 'new' } },
    ]);
  });

  it('marshals a layout save as sessionId + layout', () => {
    const layout = { rootId: 'p1' };
    expect(callOf(() => bridge.layout.save('session-1', layout))).toEqual([
      'layout:save',
      { sessionId: 'session-1', layout },
    ]);
  });
});

describe('event subscriptions', () => {
  /** Every `on*` member across the bridge. */
  const subscribers: [string, string][] = namespaces
    .filter((key) => typeof bridge[key] === 'object')
    .flatMap((ns) =>
      Object.keys(bridge[ns])
        .filter((name) => /^on[A-Z]/.test(name) || name === 'onChange' || name === 'onChanged')
        .map((name) => [ns, name] as [string, string]),
    );

  /** The id-keyed subscribers take (id, cb) and fan out from ONE module-level
   * ipcRenderer listener registered at import; the rest take just (cb) and
   * register their own. */
  const KEYED = new Set([
    'terminal.onData',
    'terminal.onExit',
    'terminal.onActivity',
    'terminal.onActivityExit',
    'lsp.onMessage',
    'lsp.onExit',
  ]);
  /** Take just (cb) but fan out from one module-level listener too - every
   * collection subscribes, and a listener each passed Node's leak warning. */
  const SHARED = new Set(['db.onChange']);

  it('finds the subscriber surface it is about to check', () => {
    expect(subscribers.length).toBeGreaterThan(8);
    // Both registration styles are represented.
    expect(subscribers.some(([ns, n]) => KEYED.has(`${ns}.${n}`))).toBe(true);
    expect(subscribers.some(([ns, n]) => !KEYED.has(`${ns}.${n}`))).toBe(true);
  });

  it.each(subscribers)('%s.%s hands back an unsubscribe', (ns, name) => {
    const off = KEYED.has(`${ns}.${name}`)
      ? bridge[ns][name]('pty-1', () => {})
      : bridge[ns][name](() => {});
    expect(typeof off, `${ns}.${name} must return an unsubscribe`).toBe('function');
    expect(() => (off as () => void)()).not.toThrow();
  });

  it.each(subscribers.filter(([ns, n]) => !KEYED.has(`${ns}.${n}`) && !SHARED.has(`${ns}.${n}`)))(
    '%s.%s removes its ipcRenderer listener again',
    (ns, name) => {
      const count = (): number => [...listeners.values()].reduce((n, set) => n + set.size, 0);
      const before = count();
      const off = bridge[ns][name](() => {});
      expect(count(), `${ns}.${name} must register a listener`).toBeGreaterThan(before);
      (off as unknown as () => void)();
      expect(count(), `${ns}.${name} leaked a listener`).toBe(before);
    },
  );

  it('drops an id-keyed handler on unsubscribe', () => {
    const seen: string[] = [];
    const off = bridge.terminal.onData('pty-1', (data: string) => seen.push(data));
    emit('terminal:data', { id: 'pty-1', data: 'hello' });
    expect(seen).toEqual(['hello']);

    (off as unknown as () => void)();
    emit('terminal:data', { id: 'pty-1', data: 'more' });
    expect(seen).toEqual(['hello']);
  });

  it('routes id-keyed output only to that terminal', () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = bridge.terminal.onData('pty-a', (d: string) => a.push(d));
    const offB = bridge.terminal.onData('pty-b', (d: string) => b.push(d));

    emit('terminal:data', { id: 'pty-a', data: 'for a' });

    expect(a).toEqual(['for a']);
    expect(b).toEqual([]);
    (offA as unknown as () => void)();
    (offB as unknown as () => void)();
  });

  it('feeds the display and the activity observer from one stream', () => {
    // Session status observes output without disturbing the xterm write path;
    // both handlers must fire for the same chunk.
    const display: string[] = [];
    const activity: string[] = [];
    const offD = bridge.terminal.onData('pty-1', (d: string) => display.push(d));
    const offA = bridge.terminal.onActivity('pty-1', (d: string) => activity.push(d));

    emit('terminal:data', { id: 'pty-1', data: 'output' });

    expect(display).toEqual(['output']);
    expect(activity).toEqual(['output']);
    (offD as unknown as () => void)();
    (offA as unknown as () => void)();
  });

  it('flags an adopt replay to the activity observer', () => {
    // The replay is the ring - old status markers included. Read as live it
    // re-raised a finished turn's alert (2026-11-02).
    const activity: unknown[][] = [];
    const offA = bridge.terminal.onActivity('pty-1', (...args: unknown[]) => activity.push(args));

    emit('terminal:data', { id: 'pty-1', data: 'ring', replaySize: { cols: 80, rows: 24 } });
    emit('terminal:data', { id: 'pty-1', data: 'live' });

    expect(activity).toEqual([['ring', { replay: true }], ['live']]);
    (offA as unknown as () => void)();
  });

  it('fires both exit observers for one pty exit', () => {
    const exits: number[] = [];
    let activityExits = 0;
    const offE = bridge.terminal.onExit('pty-1', (code: number) => exits.push(code));
    const offA = bridge.terminal.onActivityExit('pty-1', () => (activityExits += 1));

    emit('terminal:exit', { id: 'pty-1', exitCode: 130 });

    expect(exits).toEqual([130]);
    expect(activityExits).toBe(1);
    (offE as unknown as () => void)();
    (offA as unknown as () => void)();
  });
});

describe('window chrome', () => {
  it('reports full screen as main last pushed it, kept from before the page subscribed', () => {
    // The header reads this on its first render; a window restored into full
    // screen is told so before React mounts any listener.
    emit('window:fullScreen', true);
    expect(bridge.windowChrome.isFullScreen()).toBe(true);
    emit('window:fullScreen', false);
    expect(bridge.windowChrome.isFullScreen()).toBe(false);
  });

  it('reads anything but a boolean true as not full screen', () => {
    emit('window:fullScreen', 'yes');
    expect(bridge.windowChrome.isFullScreen()).toBe(false);
  });

  it('shows the DEV badge only when main passed the local flag', () => {
    expect(bridge.windowChrome.isLocal()).toBe(false);
    process.argv.push('--double0-env=local');
    try {
      expect(bridge.windowChrome.isLocal()).toBe(true);
    } finally {
      process.argv.pop();
    }
  });
});

describe('what a subscriber receives', () => {
  it('hands the renderer the payload, not the IpcRendererEvent', () => {
    // `(_e, payload) => cb(payload)` - off by one here and every consumer gets
    // an event object where it expected data.
    const seen: unknown[] = [];
    const off = bridge.db.onChange((change: unknown) => seen.push(change));

    const change = { table: 'projects', type: 'insert', row: { id: '1' } };
    emit('db:change', change);

    expect(seen).toEqual([change]);
    (off as unknown as () => void)();
  });

  it('unpacks a git change payload into the callback’s arguments', () => {
    // Main sends one object; the renderer's consumers take (root, kind).
    const seen: unknown[][] = [];
    const off = bridge.git.onChanged((...args: unknown[]) => seen.push(args));

    emit('git:changed', { root: '/repo', kind: 'history' });

    expect(seen).toEqual([['/repo', 'history']]);
    (off as unknown as () => void)();
  });

  it('unpacks an fs change the same way', () => {
    const seen: unknown[][] = [];
    const off = bridge.fs.onChanged((...args: unknown[]) => seen.push(args));

    emit('fs:changed', { root: '/repo', paths: ['README.md'] });
    // A remote watch that switched to polling says so in the same notice.
    emit('fs:changed', { root: '/srv/acme', paths: [], mode: 'poll' });

    expect(seen).toEqual([
      ['/repo', ['README.md'], undefined],
      ['/srv/acme', [], 'poll'],
    ]);
    (off as unknown as () => void)();
  });

  it('stops delivering after unsubscribe', () => {
    const seen: unknown[] = [];
    const off = bridge.db.onChange((c: unknown) => seen.push(c));
    (off as unknown as () => void)();

    emit('db:change', { table: 'projects', type: 'delete', id: '1' });

    expect(seen).toEqual([]);
  });

  it('supports several independent subscribers on one channel', () => {
    // Two windows' worth of consumers share a channel; one unsubscribing must
    // not silence the other.
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = bridge.db.onChange((c: unknown) => a.push(c));
    const offB = bridge.db.onChange((c: unknown) => b.push(c));

    emit('db:change', { table: 'projects', type: 'insert', row: { id: '1' } });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    (offA as unknown as () => void)();
    emit('db:change', { table: 'projects', type: 'insert', row: { id: '2' } });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);

    (offB as unknown as () => void)();
  });

  it('feeds every database subscriber from one ipc listener', () => {
    // One listener per collection passed Node's 10-listener leak warning at 11
    // collections; however many subscribe, ipcRenderer holds one.
    const seen: number[] = [];
    const offs = Array.from({ length: 11 }, (_, i) =>
      bridge.db.onChange(() => seen.push(i)),
    ) as unknown as (() => void)[];

    expect(listeners.get('db:change')?.size).toBe(1);
    emit('db:change', { table: 'projects', type: 'insert', row: { id: '1' } });
    expect(seen).toHaveLength(11);

    for (const off of offs) off();
    emit('db:change', { table: 'projects', type: 'insert', row: { id: '2' } });
    expect(seen).toHaveLength(11);
  });
});
