import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './ipc-util';

/**
 * Lifecycle of the LSP process manager: refcounting, the idle kill, and the
 * crash budget that stops a server which cannot start from being respawned
 * forever.
 *
 * No real language server is spawned - `node:child_process` is faked with a
 * process whose stdio are PassThrough streams, which is enough for the
 * vscode-jsonrpc reader/writer the module wraps them in. Timers are faked so
 * the 60s idle kill and the "ran long enough to be healthy" window are
 * reachable without waiting.
 */

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
    on: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      listeners.set(channel, fn);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
    removeAllListeners: (channel: string) => listeners.delete(channel),
  },
}));

/** Every fake process spawned, newest last, so a test can crash a specific one. */
const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  /** The server dying on its own (crash), as opposed to us killing it. */
  crash(code = 1): void {
    this.emit('exit', code);
  }
}

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new FakeChild();
    spawned.push(child);
    return child;
  },
}));

vi.mock('./user-path', () => ({
  resolveUserPath: async () => '/usr/bin:/bin',
  findOnPath: async () => null,
}));

vi.mock('./language-registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('./language-registry')>();
  const registry = [
    {
      id: 'python',
      name: 'Python',
      extensions: ['.py'],
      server: {
        installType: 'npm',
        package: 'pyright',
        version: '1.0.0',
        integrity: '',
        entryBin: 'pyright-langserver',
        args: ['--stdio'],
        approxMb: 10,
        lockedDeps: [],
      },
    },
    {
      id: 'go',
      name: 'Go',
      extensions: ['go'],
      server: {
        installType: 'detect-only',
        bin: 'gopls',
        args: [],
        installHint: 'go install golang.org/x/tools/gopls@latest',
      },
    },
    {
      id: 'cpp',
      name: 'C / C++',
      extensions: ['c'],
      server: {
        installType: 'detect-only',
        bin: 'clangd',
        args: [],
        installHint: 'xcode-select --install',
        linuxInstallHint: 'sudo apt install clangd',
      },
    },
  ];
  return {
    ...real,
    LANGUAGE_REGISTRY: registry,
    registryEntry: (id: string) => registry.find((e) => e.id === id),
  };
});

const hostInstall = {
  getInstalledOnHost: vi.fn<(t: unknown, id: string) => Promise<{ version: string } | null>>(
    async () => null,
  ),
  installServerOnHost: vi.fn(async () => {}),
  removeServerOnHost: vi.fn(async () => {}),
};

vi.mock('./language-server-install', () => ({
  resolveServerCommand: async () => ({ cmd: 'pyright', args: ['--stdio'], runAsNode: false }),
  getInstalled: async () => null,
  isInstalling: () => false,
  installServer: async () => {},
  removeServer: async () => {},
  isInstallingOnHost: () => false,
  getInstalledOnHost: (t: unknown, id: string) => hostInstall.getInstalledOnHost(t, id),
  installServerOnHost: (...a: unknown[]) =>
    (hostInstall.installServerOnHost as (...x: unknown[]) => Promise<void>)(...a),
  removeServerOnHost: (...a: unknown[]) =>
    (hostInstall.removeServerOnHost as (...x: unknown[]) => Promise<void>)(...a),
}));

const { registerLanguageServersIpc, disposeLanguageServersForWindow, languageServerKey } =
  await import('./language-servers');

/** A host this machine knows (index.ts builds the real one over `RemoteHosts`). */
type FakeTarget = {
  hostId: string;
  label: string;
  platform: string | null;
  isConnected: boolean;
  hasLsp: boolean;
  calls: Array<{ op: string; args: Record<string, unknown> }>;
  casts: Array<{ op: string; args: Record<string, unknown> }>;
  listeners: Set<(ev: { type: string } & Record<string, unknown>) => void>;
  drops: Set<() => void>;
  answer: (op: string, args: Record<string, unknown>) => unknown;
  emit(ev: { type: string } & Record<string, unknown>): void;
  drop(): void;
};

function fakeTarget(hostId: string): FakeTarget {
  const t: FakeTarget = {
    hostId,
    label: hostId === 'h1' ? 'build-box' : hostId,
    platform: 'linux',
    isConnected: true,
    hasLsp: true,
    calls: [],
    casts: [],
    listeners: new Set(),
    drops: new Set(),
    answer: (op) => (op === 'lspOpen' ? { ok: true, pid: 77 } : { ok: true }),
    emit: (ev) => {
      for (const l of [...t.listeners]) l(ev);
    },
    drop: () => {
      for (const l of [...t.drops]) l();
    },
  };
  return t;
}

const targets = new Map<string, FakeTarget>();
/** Remote project roots: `/home/emmaw/acme` lives on h1 AND (another project) on h2. */
let hostRoots: Array<{ prefix: string; hostId: string }> = [];

registerLanguageServersIpc({
  hosts: {
    hostOf: (path) => hostRoots.find((r) => path.startsWith(r.prefix))?.hostId ?? null,
    target: (hostId) => {
      const t = targets.get(hostId);
      if (!t) return null;
      return {
        hostId,
        label: t.label,
        platform: t.platform,
        supports: () => t.isConnected && t.hasLsp,
        connected: () => t.isConnected,
        call: async <T>(op: string, args: Record<string, unknown>) => {
          t.calls.push({ op, args });
          return t.answer(op, args) as T;
        },
        cast: (op, args) => {
          t.casts.push({ op, args });
          return true;
        },
        onEvent: (l) => {
          t.listeners.add(l);
          return () => t.listeners.delete(l);
        },
        onDisconnected: (l) => {
          t.drops.add(l);
          return () => t.drops.delete(l);
        },
        root: async () => '/home/emmaw/.double0',
        runtime: () =>
          ({
            which: async (bin: string) => (bin === 'gopls' ? '/home/emmaw/go/bin/gopls' : null),
          }) as never,
        putTransfer: async () => 't-1',
      } as import('./language-server-install').HostLspTarget;
    },
  },
});

const WC_ID = 1;
const trustedEvent = (() => {
  const mainFrame = { url: `${APP_ORIGIN}/index.html` };
  return {
    senderFrame: mainFrame,
    sender: { mainFrame, id: WC_ID, isDestroyed: () => false, send: vi.fn() },
  };
})();

type StartResult = { serverId?: string; error?: string; code?: string };

const start = (root = '/repo/acme'): Promise<StartResult> =>
  handlers.get('lsp:start')!(trustedEvent, { language: 'python', root }) as Promise<StartResult>;

const stop = (serverId: string): void => {
  listeners.get('lsp:stop')!(trustedEvent, { serverId });
};

beforeEach(() => {
  vi.useFakeTimers();
  spawned.length = 0;
  disposeLanguageServersForWindow(WC_ID);
  trustedEvent.sender.send.mockClear();
  hostRoots = [];
  targets.clear();
  hostInstall.getInstalledOnHost.mockReset().mockResolvedValue(null);
  hostInstall.installServerOnHost.mockClear();
  hostInstall.removeServerOnHost.mockClear();
});

afterEach(() => {
  disposeLanguageServersForWindow(WC_ID);
  vi.useRealTimers();
});

describe('lsp:start / lsp:stop', () => {
  it('reuses one server for the same language and root, and refcounts it', async () => {
    const first = await start();
    const second = await start();
    expect(second.serverId).toBe(first.serverId);
    expect(spawned).toHaveLength(1);

    // One consumer going away must not take the server with it.
    stop(first.serverId!);
    vi.advanceTimersByTime(120_000);
    expect(spawned[0].killed).toBe(false);

    // …the last one does, after the idle window.
    stop(first.serverId!);
    vi.advanceTimersByTime(120_000);
    expect(spawned[0].killed).toBe(true);
  });

  it('spawns separate servers per project root', async () => {
    await start('/repo/acme');
    await start('/repo/production-pipeline');
    expect(spawned).toHaveLength(2);
  });

  /**
   * The regression this file was written for. The idle kill means an unused
   * server is torn down after 60s, so ordinary open/close cycles each need a
   * fresh spawn. Charging those to the crash budget (as incrementing on every
   * spawn did) left the language permanently dead on the 4th open, with
   * 'Server restarted too often', until the window reloaded.
   */
  it('does not charge ordinary open/close cycles to the crash budget', async () => {
    for (let cycle = 0; cycle < 6; cycle++) {
      const result = await start();
      expect(result.error).toBeUndefined();
      expect(result.serverId).toBeDefined();
      stop(result.serverId!);
      // Idle timeout: we kill it, which is not a crash.
      vi.advanceTimersByTime(IDLE_PLUS);
    }
    expect(spawned).toHaveLength(6);
    expect(spawned.every((c) => c.killed)).toBe(true);
  });

  it('duplicate stops do not drive the refcount negative', async () => {
    const first = await start();
    // Three stops against a single acquire. A negative count would leave the
    // NEXT start's refs++ at zero-or-less, so nothing could ever release it.
    stop(first.serverId!);
    stop(first.serverId!);
    stop(first.serverId!);
    vi.advanceTimersByTime(IDLE_PLUS);
    expect(spawned[0].killed).toBe(true);

    const second = await start();
    expect(second.serverId).toBeDefined();
    stop(second.serverId!);
    vi.advanceTimersByTime(IDLE_PLUS);
    expect(spawned[1].killed).toBe(true);
  });
});

describe('crash budget', () => {
  it('stops respawning a server that keeps dying immediately', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await start();
      expect(result.serverId).toBeDefined();
      // Dies on its own, straight away - a real crash loop.
      spawned[spawned.length - 1].crash();
    }
    const blocked = await start();
    expect(blocked.code).toBe('RESTART_LIMIT');
    expect(spawned).toHaveLength(3);
  });

  it('resets the budget when a server ran healthily before crashing', async () => {
    // Two quick crashes - one away from the limit.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await start();
      spawned[spawned.length - 1].crash();
      expect(result.serverId).toBeDefined();
    }
    // A third that does real work for a while before dying: not a crash loop,
    // so it must not count against the budget.
    const healthy = await start();
    expect(healthy.serverId).toBeDefined();
    vi.advanceTimersByTime(HEALTHY_PLUS);
    spawned[spawned.length - 1].crash();

    const after = await start();
    expect(after.error).toBeUndefined();
    expect(after.serverId).toBeDefined();
  });

  it('clears the budget when the window reloads', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await start();
      spawned[spawned.length - 1].crash();
    }
    expect((await start()).code).toBe('RESTART_LIMIT');

    disposeLanguageServersForWindow(WC_ID);
    const afterReload = await start();
    expect(afterReload.error).toBeUndefined();
    expect(afterReload.serverId).toBeDefined();
  });
});

describe('sender trust', () => {
  it('refuses a start from an untrusted sender', async () => {
    const foreign = { url: 'https://evil.example' };
    const result = (await handlers.get('lsp:start')!(
      { senderFrame: foreign, sender: { mainFrame: foreign, id: 2 } },
      { language: 'python', root: '/repo/acme' },
    )) as StartResult;
    expect(result.error).toBe('Untrusted sender');
    expect(spawned).toHaveLength(0);
  });

  it('refuses to drive a server owned by another window', async () => {
    const first = await start();
    const otherFrame = { url: `${APP_ORIGIN}/index.html` };
    listeners.get('lsp:stop')!(
      { senderFrame: otherFrame, sender: { mainFrame: otherFrame, id: 99 } },
      { serverId: first.serverId },
    );
    // The foreign stop was ignored, so the server is still held by its owner.
    vi.advanceTimersByTime(IDLE_PLUS);
    expect(spawned[0].killed).toBe(false);
  });
});

/** Comfortably past the module's 60s idle kill. */
const IDLE_PLUS = 61_000;
/** Comfortably past the module's 30s "ran healthily" window. */
const HEALTHY_PLUS = 31_000;

describe('servers on a remote host (plan 29 › M9)', () => {
  const ROOT = '/home/emmaw/acme';
  const onHost = (...hosts: string[]): FakeTarget[] => {
    hostRoots = [{ prefix: ROOT, hostId: hosts[0] }];
    return hosts.map((h) => {
      const t = fakeTarget(h);
      targets.set(h, t);
      return t;
    });
  };
  const startPy = (root = ROOT, language = 'python'): Promise<StartResult> =>
    handlers.get('lsp:start')!(trustedEvent, { language, root }) as Promise<StartResult>;
  const sent = (channel: string) =>
    trustedEvent.sender.send.mock.calls
      .filter((c: unknown[]) => c[0] === channel)
      .map((c: unknown[]) => c[1]);

  it('keys a server by window, machine, language and root', () => {
    expect(languageServerKey(1, 'h1', 'python', ROOT)).toBe(`1::h1::python::${ROOT}`);
    expect(languageServerKey(1, null, 'python', ROOT)).toBe(`1::local::python::${ROOT}`);
  });

  /** The load-bearing rule: whatever is installed here, a host root never spawns locally. */
  it('starts a host root on the host - never a local spawn', async () => {
    const [h1] = onHost('h1');
    hostInstall.getInstalledOnHost.mockResolvedValue({ version: '1.0.0' });
    const res = await startPy();
    expect(res.serverId).toBeDefined();
    expect(spawned).toHaveLength(0);
    expect(h1.calls[0]).toEqual({
      op: 'lspOpen',
      args: expect.objectContaining({
        kind: 'installed',
        version: '1.0.0',
        languageId: 'python',
        args: ['--stdio'],
        root: ROOT,
      }),
    });
  });

  it('falls back to a PATH server on the host when nothing is installed there', async () => {
    const [h1] = onHost('h1');
    await startPy(ROOT, 'go');
    expect(h1.calls[0].args).toMatchObject({ kind: 'path', bin: 'gopls', languageId: 'go' });
    await startPy();
    expect(h1.calls[1].args).toMatchObject({ kind: 'path', bin: 'pyright-langserver' });
  });

  it('keeps separate servers for the same path on two hosts and on this machine', async () => {
    const [h1, h2] = onHost('h1', 'h2');
    await startPy();
    hostRoots = [{ prefix: ROOT, hostId: 'h2' }];
    await startPy();
    hostRoots = [];
    await startPy();
    expect(h1.calls.filter((c) => c.op === 'lspOpen')).toHaveLength(1);
    expect(h2.calls.filter((c) => c.op === 'lspOpen')).toHaveLength(1);
    expect(h1.calls[0].args.lspId).not.toBe(h2.calls[0].args.lspId);
    // The local one is a local process.
    expect(spawned).toHaveLength(1);
  });

  it('relays messages both ways: lsp:send as lspSend, the host lsp-message as lsp:message', async () => {
    const [h1] = onHost('h1');
    const { serverId } = await startPy();
    const lspId = h1.calls[0].args.lspId as string;
    listeners.get('lsp:send')!(trustedEvent, {
      serverId,
      message: { id: 1, method: 'initialize' },
    });
    expect(h1.casts).toEqual([
      { op: 'lspSend', args: { lspId, message: '{"id":1,"method":"initialize"}' } },
    ]);
    h1.emit({ type: 'lsp-message', lspId, message: '{"id":1,"result":{}}' });
    // Another server's message, chatter and junk never reach this window.
    h1.emit({ type: 'lsp-message', lspId: '2a6c2b1e-9b3c-4a55-8f2e-1d3c4b5a6e7f', message: '{}' });
    h1.emit({ type: 'lsp-message', lspId, message: '{"method":"window/logMessage"}' });
    h1.emit({ type: 'lsp-message', lspId, message: 'not json' });
    expect(sent('lsp:message')).toEqual([{ serverId, message: { id: 1, result: {} } }]);
  });

  it('reports a host server that died as a crash, and charges the budget', async () => {
    const [h1] = onHost('h1');
    for (let i = 0; i < 3; i++) {
      const { serverId } = await startPy();
      const lspId = h1.calls.filter((c) => c.op === 'lspOpen').pop()!.args.lspId;
      h1.emit({ type: 'lsp-exit', lspId, code: null, reason: 'oversize' });
      expect(sent('lsp:exit').pop()).toEqual({ serverId, code: -1 });
    }
    expect((await startPy()).code).toBe('RESTART_LIMIT');
  });

  /** A bridge drop is no crash: the renderer starts it again once the host is back. */
  it('ends the server on a bridge drop without charging the budget', async () => {
    const [h1] = onHost('h1');
    for (let i = 0; i < 5; i++) {
      const res = await startPy();
      expect(res.serverId).toBeDefined();
      h1.drop();
      expect(sent('lsp:exit').pop()).toEqual({ serverId: res.serverId, code: -1 });
    }
    // Nothing tried to close a server the dropped connection already took.
    expect(h1.calls.filter((c) => c.op === 'lspClose')).toHaveLength(0);
  });

  it('answers EHOSTDOWN while the host is away and UNSUPPORTED for an older runtime - never local', async () => {
    const [h1] = onHost('h1');
    h1.isConnected = false;
    expect((await startPy()).code).toBe('EHOSTDOWN');
    h1.isConnected = true;
    h1.hasLsp = false;
    expect(await startPy()).toMatchObject({ code: 'UNSUPPORTED' });
    // A host this machine does not know (the flag off: none synced).
    hostRoots = [{ prefix: ROOT, hostId: 'h9' }];
    expect((await startPy()).code).toBe('EHOSTDOWN');
    expect(spawned).toHaveLength(0);
  });

  it('closes the host server after the idle window', async () => {
    const [h1] = onHost('h1');
    const { serverId } = await startPy();
    listeners.get('lsp:stop')!(trustedEvent, { serverId });
    vi.advanceTimersByTime(IDLE_PLUS);
    expect(h1.calls.filter((c) => c.op === 'lspClose')).toEqual([
      { op: 'lspClose', args: { lspId: h1.calls[0].args.lspId } },
    ]);
  });

  describe('ls:* per machine', () => {
    const invoke = (channel: string, payload: unknown, event: unknown = trustedEvent) =>
      handlers.get(channel)!(event, payload) as Promise<Record<string, unknown>>;

    it("lists a host's servers: its installs, its PATH, its platform's hints", async () => {
      onHost('h1');
      const res = (await invoke('ls:list', { hostId: 'h1' })) as {
        languages: Array<{ id: string; status: string; path?: string; installHint?: string }>;
      };
      expect(res.languages).toEqual([
        expect.objectContaining({ id: 'python', status: 'available' }),
        expect.objectContaining({ id: 'go', status: 'on-path', path: '/home/emmaw/go/bin/gopls' }),
        expect.objectContaining({
          id: 'cpp',
          status: 'missing-tool',
          installHint: 'sudo apt install clangd',
        }),
      ]);
    });

    it('installs and uninstalls on the named host, stopping its servers first', async () => {
      const [h1] = onHost('h1');
      expect(await invoke('ls:install', { languageId: 'python', hostId: 'h1' })).toEqual({
        ok: true,
      });
      expect(hostInstall.installServerOnHost).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: 'h1' }),
        'python',
        expect.any(Function),
      );
      await startPy();
      expect(await invoke('ls:uninstall', { languageId: 'python', hostId: 'h1' })).toEqual({
        ok: true,
      });
      expect(h1.calls.filter((c) => c.op === 'lspClose')).toHaveLength(1);
      expect(hostInstall.removeServerOnHost).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: 'h1' }),
        'python',
      );
    });

    it('refuses an untrusted sender, a bad or option-shaped host, an unknown or away one', async () => {
      onHost('h1');
      const foreign = { url: 'https://evil.example' };
      const untrusted = { senderFrame: foreign, sender: { mainFrame: foreign, id: 2 } };
      expect(await invoke('ls:install', { languageId: 'python', hostId: 'h1' }, untrusted)).toEqual(
        {
          error: 'Untrusted sender',
        },
      );
      expect(await invoke('ls:list', { hostId: '-oProxyCommand=x' })).toMatchObject({
        code: 'EINVAL',
      });
      expect(await invoke('ls:list', { hostId: 42 })).toMatchObject({ code: 'EINVAL' });
      expect(await invoke('ls:install', { languageId: 'python', hostId: 'h9' })).toMatchObject({
        code: 'EINVAL',
      });
      targets.get('h1')!.isConnected = false;
      expect(await invoke('ls:uninstall', { languageId: 'python', hostId: 'h1' })).toMatchObject({
        code: 'EHOSTDOWN',
      });
      expect(await invoke('ls:install', { languageId: 'cobol', hostId: 'h1' })).toEqual({
        error: 'Unknown language',
      });
      expect(hostInstall.installServerOnHost).not.toHaveBeenCalled();
      expect(hostInstall.removeServerOnHost).not.toHaveBeenCalled();
    });
  });
});
