import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './ipc-util';
import type { BackendEvent, TerminalBackend } from './terminal-backend';

/**
 * The `sessions:*` IPC (a private plan) through the real
 * ipcMain handlers (the git.test.ts pattern): the Keep-running mirror, Stop
 * all, and the once-ever launch notice - which lists the terminals the daemon
 * kept across the last quit, to the main window, exactly once on this machine.
 */

const { handlers, userData } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  userData: { dir: '' },
}));

// ipc-util imports the real toolkit, which imports the real electron binding.
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: { getPath: () => userData.dir },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

const mainFrame = { url: `${APP_ORIGIN}/index.html` };
const mainWindow = { senderFrame: mainFrame, sender: { mainFrame, id: 1 } };
const projectWindow = { senderFrame: mainFrame, sender: { mainFrame, id: 2 } };
const untrusted = {
  senderFrame: { url: 'https://evil.example' },
  sender: { mainFrame: {}, id: 1 },
};

const invoke = async <T>(channel: string, event: unknown, payload?: unknown): Promise<T> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return (await handler(event, payload)) as T;
};

/** A backend whose boot the test drives: `discover` lists terminals, `boot` settles `ready()`. */
function fakeBackend() {
  const listeners = new Set<(ev: BackendEvent) => void>();
  let boot!: () => void;
  const ready = new Promise<void>((r) => {
    boot = r;
  });
  const killAll = vi.fn(async () => {});
  const backend = {
    ready: () => ready,
    onEvent: (l: (ev: BackendEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    killAll,
  } as unknown as TerminalBackend;
  return {
    backend,
    killAll,
    boot,
    discover: (ids: string[]) => {
      for (const l of listeners)
        l({
          type: 'discovered',
          terminals: ids.map((id) => ({
            id,
            cols: 80,
            rows: 24,
            markerDriven: false,
            agentStatus: 'idle' as const,
          })),
        });
    },
  };
}

const stateFile = (): string => join(userData.dir, 'session-daemon.json');
/** The persisted state, or `{}` while the module has not touched the file yet (it loads lazily). */
const readState = (): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
};

let dispose: (() => void) | null = null;
/** What index.ts injects for Stop all (terminal.ts › stopAllTerminals). */
const stopAll = vi.fn(async () => {});
/** What index.ts injects for the older-version list (terminal.ts). */
const daemons = vi.fn(async () => [
  {
    socketPath: '/tmp/d/daemon-v1-0.7.7.sock',
    buildId: '0.7.7',
    current: true,
    terminals: 2,
    busy: 0,
  },
  {
    socketPath: '/tmp/d/daemon-v1-0.7.6.sock',
    buildId: '0.7.6',
    current: false,
    terminals: 3,
    busy: 1,
  },
]);
const moveDaemon = vi.fn(async (_path: string, includeBusy: boolean) =>
  includeBusy
    ? { moved: 3, busy: 0, unresumable: 0, kept: 0 }
    : { moved: 0, busy: 1, unresumable: 0, kept: 0 },
);

async function register(
  fake: ReturnType<typeof fakeBackend>,
  isMainWindow = (id: number) => id === 1,
) {
  // Module state (the cached file) must start fresh per test.
  vi.resetModules();
  const { registerSessionDaemonIpc } = await import('./session-daemon');
  dispose = registerSessionDaemonIpc(fake.backend, { isMainWindow, stopAll, daemons, moveDaemon });
}

beforeEach(() => {
  daemons.mockClear();
  moveDaemon.mockClear();
  userData.dir = mkdtempSync(join(tmpdir(), 'double0-sessions-ipc-'));
});
afterEach(() => {
  dispose?.();
  dispose = null;
  handlers.clear();
  rmSync(userData.dir, { recursive: true, force: true });
});

describe('sessions:setKeepRunning', () => {
  it('persists a boolean from a trusted window and ignores anything else', async () => {
    const fake = fakeBackend();
    await register(fake);
    await invoke('sessions:setKeepRunning', mainWindow, false);
    expect(readState()).toMatchObject({ keepRunning: false });
    await invoke('sessions:setKeepRunning', mainWindow, 'yes');
    expect(readState()).toMatchObject({ keepRunning: false });
    await invoke('sessions:setKeepRunning', untrusted, true);
    expect(readState()).toMatchObject({ keepRunning: false });
  });
});

describe('sessions:stopAll', () => {
  it('stops every terminal through main (which tells the tabs), for a trusted window only', async () => {
    const fake = fakeBackend();
    stopAll.mockClear();
    await register(fake);
    expect(await invoke('sessions:stopAll', untrusted)).toBe(false);
    expect(stopAll).not.toHaveBeenCalled();
    expect(await invoke('sessions:stopAll', mainWindow)).toBe(true);
    expect(stopAll).toHaveBeenCalledTimes(1);
    // Never the backend's bare killAll: it reports no exit, so main's records
    // and the renderer's tabs would stay as if alive on dead shells.
    expect(fake.killAll).not.toHaveBeenCalled();
  });

  it('stops one machine at a time: this one by default, a host by id, never an option-shaped id', async () => {
    const fake = fakeBackend();
    stopAll.mockClear();
    await register(fake);
    expect(await invoke('sessions:stopAll', mainWindow)).toBe(true);
    expect(stopAll).toHaveBeenLastCalledWith(null);
    expect(await invoke('sessions:stopAll', mainWindow, 'build-box-1')).toBe(true);
    expect(stopAll).toHaveBeenLastCalledWith('build-box-1');
    // A host id reaches an ssh-facing path: anything not id-shaped is refused.
    expect(await invoke('sessions:stopAll', mainWindow, '--all')).toBe(false);
    expect(await invoke('sessions:stopAll', mainWindow, { id: 'x' })).toBe(false);
    expect(stopAll).toHaveBeenCalledTimes(2);
    // A host that could not be reached: the window hears false, not "stopped".
    stopAll.mockResolvedValueOnce(false as never);
    expect(await invoke('sessions:stopAll', mainWindow, 'build-box-1')).toBe(false);
  });
});

describe('sessions:launchNotice', () => {
  it('lists the terminals the daemon kept, to the main window, once ever', async () => {
    const fake = fakeBackend();
    await register(fake);
    fake.discover(['conversation:s1', 'commands:s1:lint', '7f3a']);
    fake.boot();

    // A project window asking first must not use the one answer up.
    expect(await invoke('sessions:launchNotice', projectWindow)).toBeNull();
    expect(readState().launchNoticeShown).not.toBe(true);

    expect(await invoke('sessions:launchNotice', mainWindow)).toEqual({
      terminalIds: ['conversation:s1', 'commands:s1:lint', '7f3a'],
    });
    // Answering is showing: the flag flips on disk at once.
    expect(readState()).toMatchObject({ launchNoticeShown: true });
    // A reload, a second main window of a later run: never again.
    expect(await invoke('sessions:launchNotice', mainWindow)).toBeNull();
  });

  it('waits for the daemon list before answering, in case the window asks first', async () => {
    const fake = fakeBackend();
    await register(fake);
    const asked = invoke<unknown>('sessions:launchNotice', mainWindow);
    let settled = false;
    void asked.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    fake.discover(['conversation:s2']);
    fake.boot();
    expect(await asked).toEqual({ terminalIds: ['conversation:s2'] });
  });

  it('is null when nothing outlived the last run, and keeps the notice for a later launch', async () => {
    const fake = fakeBackend();
    await register(fake);
    fake.boot();
    expect(await invoke('sessions:launchNotice', mainWindow)).toBeNull();
    // Not shown, so a launch that does find kept terminals still gets to show it.
    expect(readState().launchNoticeShown).toBe(false);
  });

  it('does not count a daemon that reconnects after boot - those terminals were not kept across a quit', async () => {
    const fake = fakeBackend();
    await register(fake);
    fake.boot();
    await fake.backend.ready();
    fake.discover(['conversation:s3']);
    expect(await invoke('sessions:launchNotice', mainWindow)).toBeNull();
  });

  it('is null for good once shown on this machine', async () => {
    writeFileSync(stateFile(), JSON.stringify({ keepRunning: true, launchNoticeShown: true }));
    const fake = fakeBackend();
    await register(fake);
    fake.discover(['conversation:s1']);
    fake.boot();
    expect(await invoke('sessions:launchNotice', mainWindow)).toBeNull();
  });

  it('refuses an untrusted sender without spending the answer', async () => {
    const fake = fakeBackend();
    await register(fake);
    fake.discover(['conversation:s1']);
    fake.boot();
    expect(await invoke('sessions:launchNotice', untrusted)).toBeNull();
    expect(await invoke('sessions:launchNotice', mainWindow)).toEqual({
      terminalIds: ['conversation:s1'],
    });
  });

  it('is torn down with the rest of the module', async () => {
    const fake = fakeBackend();
    await register(fake);
    dispose?.();
    dispose = null;
    expect(handlers.has('sessions:launchNotice')).toBe(false);
    expect(handlers.has('sessions:setKeepRunning')).toBe(false);
    expect(handlers.has('sessions:stopAll')).toBe(false);
    expect(handlers.has('sessions:daemons')).toBe(false);
    expect(handlers.has('sessions:moveDaemon')).toBe(false);
  });
});

describe('sessions:daemons / sessions:moveDaemon', () => {
  const move = (event: unknown, ...args: unknown[]) =>
    (handlers.get('sessions:moveDaemon') as (e: unknown, ...a: unknown[]) => unknown)(
      event,
      ...args,
    );

  it("lists this machine's daemons once the backend is up, to a trusted window only", async () => {
    const fake = fakeBackend();
    await register(fake);
    expect(await invoke('sessions:daemons', untrusted)).toEqual([]);
    const listed = invoke<unknown[]>('sessions:daemons', mainWindow);
    fake.boot();
    expect(await listed).toHaveLength(2);
  });

  it('moves only when asked again for the busy ones, and refuses anything not path-shaped', async () => {
    const fake = fakeBackend();
    await register(fake);
    const path = '/tmp/d/daemon-v1-0.7.6.sock';
    // The first ask never restarts a working session: it reports them.
    expect(await move(mainWindow, path)).toEqual({ moved: 0, busy: 1, unresumable: 0, kept: 0 });
    expect(moveDaemon).toHaveBeenLastCalledWith(path, false);
    // Only a literal true counts as the user's yes.
    await move(mainWindow, path, 'true');
    expect(moveDaemon).toHaveBeenLastCalledWith(path, false);
    expect(await move(mainWindow, path, true)).toEqual({
      moved: 3,
      busy: 0,
      unresumable: 0,
      kept: 0,
    });
    expect(moveDaemon).toHaveBeenLastCalledWith(path, true);
    moveDaemon.mockClear();
    expect(await move(untrusted, path, true)).toBeNull();
    expect(await move(mainWindow, '--all', true)).toBeNull();
    expect(await move(mainWindow, { path }, true)).toBeNull();
    expect(await move(mainWindow, '', true)).toBeNull();
    expect(moveDaemon).not.toHaveBeenCalled();
  });
});
