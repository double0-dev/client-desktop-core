import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './ipc-util';
import type { HostSpawnRequest, TerminalSummary } from './pty-host';
import type { BackendEvent, TerminalBackend } from './terminal-backend';

/**
 * terminal.ts over a scripted backend standing in for the session daemon
 * (a private plan): what main does with the terminals a
 * daemon still holds when the app comes back, with a daemon that dies, and
 * at quit. The in-process behaviour is terminal.test.ts; the daemon itself is
 * daemon/daemon-server.test.ts.
 */

const { onHandlers, invokeHandlers } = vi.hoisted(() => ({
  onHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  invokeHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp/double0-terminal-daemon-test' },
  ipcMain: {
    on: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      onHandlers.set(channel, fn);
    },
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      invokeHandlers.set(channel, fn);
    },
  },
}));
vi.mock('@homebridge/node-pty-prebuilt-multiarch', () => ({ spawn: () => ({}) }));

const summary = (id: string): TerminalSummary => ({
  id,
  cols: 100,
  rows: 30,
  markerDriven: true,
  agentStatus: 'running',
});

/** A backend whose daemon list, answers and events the test scripts. */
function scriptedBackend(discovered: string[]) {
  const listeners = new Set<(ev: BackendEvent) => void>();
  let release!: () => void;
  const ready = new Promise<void>((r) => {
    release = r;
  });
  const spawned: HostSpawnRequest[] = [];
  const adopted: string[] = [];
  const killed: string[] = [];
  const shutdowns: Array<{ stopSessions: boolean }> = [];
  let killedAll = 0;
  const backend: TerminalBackend = {
    ready: () => ready,
    onEvent: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    spawn: async (req) => {
      spawned.push(req);
      return true;
    },
    list: async () => discovered.map(summary),
    adopt: async (id) => {
      adopted.push(id);
      return { data: `screen of ${id}`, cols: 100, rows: 30 };
    },
    input: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: (id) => {
      killed.push(id);
    },
    setTone: vi.fn(),
    noteLine: vi.fn(),
    size: async () => ({ cols: 100, rows: 30 }),
    foregroundBusy: async () => false,
    markerDriven: async (ids) => ids,
    agentStatus: async (ids) => ids.map((id) => ({ id, status: 'running' as const })),
    inputList: async () => [],
    killAll: async () => {
      killedAll += 1;
    },
    shutdown: async (opts) => {
      shutdowns.push(opts);
    },
  };
  const emit = (ev: BackendEvent): void => {
    for (const l of listeners) l(ev);
  };
  const open = (): void => {
    emit({ type: 'discovered', terminals: discovered.map(summary) });
    release();
  };
  return {
    backend,
    emit,
    open,
    spawned,
    adopted,
    killed,
    shutdowns,
    killedAll: () => killedAll,
  };
}

const mainFrame = { url: `${APP_ORIGIN}/index.html` };
const sender = { id: 7, mainFrame, isDestroyed: () => false, send: vi.fn() };
const trusted = { senderFrame: mainFrame, sender };
const SESSION = '5b0c3a1e-7f2d-4c8e-9a61-2d4f8e0b7c13';
const CONVERSATION = `conversation:${SESSION}`;
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe.skipIf(process.platform === 'win32')('terminals a daemon kept across a restart', () => {
  it('queues the first create behind the daemon list and adopts the live terminal with its screen', async () => {
    const script = scriptedBackend([CONVERSATION, `commands:${SESSION}:dev`]);
    const terminal = await import('./terminal');
    const dispose = terminal.registerTerminalIpc(script.backend);
    // The renderer restores its tabs at once - before the daemon has answered -
    // with the start command it always sends. Nothing may spawn for it.
    onHandlers.get('terminal:create')!(trusted, {
      id: CONVERSATION,
      cwd: '/tmp',
      initialCommand: 'claude',
    });
    onHandlers.get('terminal:resize')!(trusted, { id: CONVERSATION, cols: 120, rows: 40 });
    await settle();
    expect(script.spawned).toEqual([]);
    expect(script.adopted).toEqual([]);
    script.open();
    await vi.waitFor(() => expect(script.adopted).toEqual([CONVERSATION]));
    expect(script.spawned).toEqual([]);
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalled());
    expect(sender.send).toHaveBeenCalledWith('terminal:data', {
      id: CONVERSATION,
      data: `screen of ${CONVERSATION}`,
      replaySize: { cols: 100, rows: 30 },
    });
    // The resize that followed the create reached the terminal after the adopt.
    expect(script.backend.resize).toHaveBeenCalledWith(CONVERSATION, 120, 40);
    expect(terminal.isTerminalOwnedBy(CONVERSATION, sender.id)).toBe(true);
    // Status for the restored tab comes from the daemon's tracker.
    expect(
      await invokeHandlers.get('terminal:agentStatus')!(trusted, { ids: [CONVERSATION] }),
    ).toEqual([{ id: CONVERSATION, status: 'running' }]);
    // The session's bottom panel finds the ownerless command shell and can adopt it.
    expect(
      await invokeHandlers.get('terminal:sessionCommandIds')!(trusted, { sessionId: SESSION }),
    ).toEqual(['dev']);
    // Live output after the adopt flows to the window; output for an ownerless
    // terminal has nowhere to go.
    sender.send.mockClear();
    script.emit({ type: 'data', id: CONVERSATION, data: 'more' });
    script.emit({ type: 'data', id: `commands:${SESSION}:dev`, data: 'nobody' });
    await new Promise((r) => setTimeout(r, 10));
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith('terminal:data', { id: CONVERSATION, data: 'more' });
    // Quit keeps the sessions: nothing is killed, the backend just lets go.
    await dispose({ stopSessions: false });
    expect(script.killed).toEqual([]);
    expect(script.shutdowns).toEqual([{ stopSessions: false }]);
    expect(terminal.liveTerminalIds()).toContain(CONVERSATION);
  });

  it('spawns a tab whose terminal is gone, and ends the tabs of a daemon that died', async () => {
    vi.resetModules();
    onHandlers.clear();
    sender.send.mockClear();
    const script = scriptedBackend([]);
    const terminal = await import('./terminal');
    const dispose = terminal.registerTerminalIpc(script.backend);
    script.open();
    onHandlers.get('terminal:create')!(trusted, { id: CONVERSATION, cwd: '/tmp' });
    // The spawn waits on the cwd check (a real stat).
    await vi.waitFor(() => expect(script.spawned.map((r) => r.id)).toEqual([CONVERSATION]));
    expect(script.adopted).toEqual([]);
    // Its daemon dies: no exit event will come, the backend says so.
    script.emit({ type: 'lost', ids: [CONVERSATION] });
    expect(sender.send).toHaveBeenCalledWith('terminal:exit', { id: CONVERSATION, exitCode: -1 });
    expect(terminal.liveTerminalIds()).toEqual([]);
    // "Quit and stop all sessions" / the switch off: the backend stops them.
    await dispose({ stopSessions: true });
    expect(script.shutdowns).toEqual([{ stopSessions: true }]);
  });

  it('Stop all sessions tells every tab its shell exited and lets the same id spawn again', async () => {
    vi.resetModules();
    onHandlers.clear();
    sender.send.mockClear();
    const script = scriptedBackend([`commands:${SESSION}:dev`]);
    const terminal = await import('./terminal');
    terminal.registerTerminalIpc(script.backend);
    script.open();
    onHandlers.get('terminal:create')!(trusted, { id: CONVERSATION, cwd: '/tmp' });
    await vi.waitFor(() => expect(script.spawned.map((r) => r.id)).toEqual([CONVERSATION]));
    await terminal.stopAllTerminals();
    // The backend's `kill` reports no exit, so main says it: the owned tab
    // hears its shell end (an ownerless one has nobody to tell), and the
    // records are gone - a bare backend killAll left them, and a tab reopened
    // later found its id "owned" and never spawned (2026-10-04).
    expect(sender.send).toHaveBeenCalledWith('terminal:exit', { id: CONVERSATION, exitCode: 0 });
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(script.killedAll()).toBe(1);
    expect(terminal.liveTerminalIds()).toEqual([]);
    onHandlers.get('terminal:create')!(trusted, { id: CONVERSATION, cwd: '/tmp' });
    await vi.waitFor(() =>
      expect(script.spawned.map((r) => r.id)).toEqual([CONVERSATION, CONVERSATION]),
    );
  });
});

describe.skipIf(process.platform === 'win32')(
  "moving terminals off an older build's daemon",
  () => {
    const OLD = '/tmp/d/daemon-v1-0.7.6.sock';
    const OTHER = `conversation:9e1f5a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b`;
    const SETUP = `setup:${SESSION}`;
    // app.getPath('userData') in this file's electron mock.
    const userData = '/tmp/double0-terminal-daemon-test';
    /** The tab's Claude resume record: what makes a fresh start resume it. */
    const recordFor = (sessionId: string): void => {
      mkdirSync(join(userData, 'claude-sessions'), { recursive: true });
      writeFileSync(
        join(userData, 'claude-sessions', sessionId),
        '0f9a3c2e-1b4d-4e6f-8a7b-9c0d1e2f3a4b',
      );
    };
    afterEach(() => rmSync(userData, { recursive: true, force: true }));

    /** The scripted backend, its terminals held by an older daemon beside this build's. */
    async function withOlderDaemon(status: Record<string, 'running' | 'needs-input' | 'idle'>) {
      vi.resetModules();
      onHandlers.clear();
      invokeHandlers.clear();
      sender.send.mockClear();
      const ids = Object.keys(status);
      const script = scriptedBackend(ids);
      const held = new Set(ids);
      script.backend.kill = (id) => {
        script.killed.push(id);
        held.delete(id);
      };
      script.backend.agentStatus = async (asked) =>
        asked.filter((id) => status[id]).map((id) => ({ id, status: status[id] }));
      script.backend.daemons = () => [
        { socketPath: '/tmp/d/daemon-v1-0.7.7.sock', buildId: '0.7.7', current: true, ids: [] },
        { socketPath: OLD, buildId: '0.7.6', current: false, ids: [...held] },
      ];
      const terminal = await import('./terminal');
      const { AUTO_MOVE_IDLE_MS } = await import('./daemon-migrate');
      terminal.registerTerminalIpc(script.backend);
      script.open();
      await settle();
      return { script, terminal, AUTO_MOVE_IDLE_MS };
    }

    it('moves an idle agent no window shows once the wait is over, and its tab then starts fresh', async () => {
      recordFor(SESSION);
      const { script, terminal, AUTO_MOVE_IDLE_MS } = await withOlderDaemon({
        [CONVERSATION]: 'idle',
        [SETUP]: 'idle',
        [OTHER]: 'running',
      });
      const t0 = 5_000_000;
      // Seen idle for the first time: the wait starts, nothing moves.
      expect(await terminal.moveIdleTerminalsOffOlderDaemons(t0)).toEqual([]);
      expect(script.killed).toEqual([]);
      expect(await terminal.moveIdleTerminalsOffOlderDaemons(t0 + AUTO_MOVE_IDLE_MS)).toEqual([
        CONVERSATION,
      ]);
      // Ended on the old daemon; the working agent and the setup shell stay.
      expect(script.killed).toEqual([CONVERSATION]);
      expect(terminal.liveTerminalIds()).not.toContain(CONVERSATION);
      expect(terminal.liveTerminalIds()).toEqual(expect.arrayContaining([SETUP, OTHER]));
      // The next open finds nothing to adopt: a fresh start with its command,
      // which resumes the conversation (agent-resume.ts).
      onHandlers.get('terminal:create')!(trusted, {
        id: CONVERSATION,
        cwd: '/tmp',
        initialCommand: 'claude',
      });
      await vi.waitFor(() => expect(script.spawned.map((r) => r.id)).toEqual([CONVERSATION]));
      expect(script.adopted).toEqual([]);
    });

    // Codex has no continuity yet, and an agent typed by hand has no record:
    // moved, its conversation would simply be gone.
    it('never moves by itself an agent its fresh start could not resume', async () => {
      const { script, terminal, AUTO_MOVE_IDLE_MS } = await withOlderDaemon({
        [CONVERSATION]: 'idle',
      });
      await terminal.moveIdleTerminalsOffOlderDaemons(1);
      expect(await terminal.moveIdleTerminalsOffOlderDaemons(1 + AUTO_MOVE_IDLE_MS)).toEqual([]);
      expect(script.killed).toEqual([]);
    });

    it('never moves by itself a terminal a window has open', async () => {
      recordFor(SESSION);
      const { script, terminal, AUTO_MOVE_IDLE_MS } = await withOlderDaemon({
        [CONVERSATION]: 'idle',
      });
      onHandlers.get('terminal:create')!(trusted, { id: CONVERSATION, cwd: '/tmp' });
      await vi.waitFor(() => expect(script.adopted).toEqual([CONVERSATION]));
      await terminal.moveIdleTerminalsOffOlderDaemons(1);
      expect(await terminal.moveIdleTerminalsOffOlderDaemons(1 + AUTO_MOVE_IDLE_MS)).toEqual([]);
      expect(script.killed).toEqual([]);
    });

    it('never runs two passes at once - a wedged older daemon must not pile probes up', async () => {
      const { script, terminal } = await withOlderDaemon({ [CONVERSATION]: 'idle' });
      let asked = 0;
      script.backend.markerDriven = () => {
        asked += 1;
        return new Promise(() => {}); // never answers
      };
      const first = terminal.moveIdleTerminalsOffOlderDaemons(1);
      expect(await terminal.moveIdleTerminalsOffOlderDaemons(2)).toEqual([]);
      expect(asked).toBe(1);
      // The unanswered probe times out as busy: nothing moves.
      expect(await first).toEqual([]);
      expect(script.killed).toEqual([]);
    }, 15_000);

    it('Move now asks before restarting a working session, then relaunches the open tab in place', async () => {
      recordFor(SESSION);
      const { script, terminal } = await withOlderDaemon({
        [CONVERSATION]: 'running',
        [SETUP]: 'idle',
      });
      onHandlers.get('terminal:create')!(trusted, { id: CONVERSATION, cwd: '/tmp' });
      await vi.waitFor(() => expect(script.adopted).toEqual([CONVERSATION]));
      // Busy: reported, nothing ended.
      expect(await terminal.moveDaemonTerminals(OLD, false)).toEqual({
        moved: 0,
        busy: 1,
        unresumable: 0,
        kept: 1,
      });
      expect(script.killed).toEqual([]);
      // The user said yes.
      sender.send.mockClear();
      expect(await terminal.moveDaemonTerminals(OLD, true)).toEqual({
        moved: 1,
        busy: 0,
        unresumable: 0,
        kept: 1,
      });
      expect(script.killed).toEqual([CONVERSATION]);
      // Its window starts the tab again rather than showing an exit.
      expect(sender.send).toHaveBeenCalledWith('terminal:relaunch', { id: CONVERSATION });
      expect(sender.send).not.toHaveBeenCalledWith('terminal:exit', expect.anything());
      // The setup shell stays: a fresh one would run the setup command again.
      expect(terminal.liveTerminalIds()).toContain(SETUP);
    });

    it('Move now also asks before restarting an idle agent it cannot resume', async () => {
      const { script, terminal } = await withOlderDaemon({ [CONVERSATION]: 'idle' });
      expect(await terminal.moveDaemonTerminals(OLD, false)).toEqual({
        moved: 0,
        busy: 0,
        unresumable: 1,
        kept: 0,
      });
      expect(script.killed).toEqual([]);
    });

    it('Move now leaves a tab mid-transfer to another window - its relaunch would land in the old one', async () => {
      recordFor(SESSION);
      const { script, terminal } = await withOlderDaemon({ [CONVERSATION]: 'idle' });
      onHandlers.get('terminal:create')!(trusted, { id: CONVERSATION, cwd: '/tmp' });
      await vi.waitFor(() => expect(script.adopted).toEqual([CONVERSATION]));
      terminal.setPendingTerminalOwner(CONVERSATION, 99);
      expect(await terminal.moveDaemonTerminals(OLD, true)).toEqual({
        moved: 0,
        busy: 0,
        unresumable: 0,
        kept: 1,
      });
      expect(script.killed).toEqual([]);
    });

    it("refuses to move this build's own daemon or one it does not know", async () => {
      const { terminal } = await withOlderDaemon({ [CONVERSATION]: 'idle' });
      expect(await terminal.moveDaemonTerminals('/tmp/d/daemon-v1-0.7.7.sock', true)).toBeNull();
      expect(await terminal.moveDaemonTerminals('/tmp/elsewhere.sock', true)).toBeNull();
    });
  },
);
