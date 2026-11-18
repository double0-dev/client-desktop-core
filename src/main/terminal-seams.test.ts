import { describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './ipc-util';
import type { HostSpawnRequest, TerminalSummary } from './pty-host';
import type { BackendEvent, TerminalBackend } from './terminal-backend';

/**
 * The seams terminal.ts gives Pro instead of its record
 * (a private plan › M5): the output tap the dev-server
 * detector reads (live chunks, the adopt replay with its window, the end),
 * who drives a terminal, and each terminal's agent tools - present only while Pro
 * set it, gone again once unset.
 */

const { onHandlers } = vi.hoisted(() => ({
  onHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.6.4', getPath: () => '/tmp/double0-terminal-seams-test' },
  shell: { openExternal: vi.fn() },
  ipcMain: {
    on: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      onHandlers.set(channel, fn);
    },
    handle: vi.fn(),
  },
}));
vi.mock('@homebridge/node-pty-prebuilt-multiarch', () => ({ spawn: () => ({}) }));

const summary = (id: string): TerminalSummary => ({
  id,
  cols: 100,
  rows: 30,
  markerDriven: false,
  agentStatus: 'idle',
});

function localBackend(live: string[] = []) {
  const listeners = new Set<(ev: BackendEvent) => void>();
  const spawned: HostSpawnRequest[] = [];
  const backend: TerminalBackend = {
    ready: () => Promise.resolve(),
    onEvent: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    spawn: async (req) => {
      spawned.push(req);
      if (live.includes(req.id)) return 'existing';
      live.push(req.id);
      return true;
    },
    list: async () => live.map(summary),
    adopt: async (id) => ({ data: `ring of ${id}`, cols: 100, rows: 30 }),
    input: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    setTone: vi.fn(),
    noteLine: vi.fn(),
    size: async () => ({ cols: 100, rows: 30 }),
    foregroundBusy: async () => false,
    markerDriven: async () => [],
    agentStatus: async () => [],
    inputList: async () => [],
    killAll: async () => undefined,
    shutdown: async () => undefined,
  };
  const emit = (ev: BackendEvent): void => {
    for (const l of listeners) l(ev);
  };
  return { backend, spawned, emit };
}

const mainFrame = { url: `${APP_ORIGIN}/index.html` };
const sender = { id: 7, mainFrame, isDestroyed: () => false, send: vi.fn() };
const trusted = { senderFrame: mainFrame, sender };
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

async function setup(live: string[] = []) {
  vi.resetModules();
  onHandlers.clear();
  sender.send.mockClear();
  const local = localBackend(live);
  const terminal = await import('./terminal');
  terminal.registerTerminalIpc(local.backend);
  await settle();
  const create = (id: string, cwd = '/tmp'): void => {
    onHandlers.get('terminal:create')!(trusted, { id, cwd, cols: 120, rows: 40 });
  };
  return { local, terminal, create };
}

describe.skipIf(process.platform === 'win32')('terminal.ts seams', () => {
  it('taps every live chunk, and the end of a closed tab and of an exit', async () => {
    const { local, terminal, create } = await setup();
    const seen: string[] = [];
    const off = terminal.addTerminalTap({
      data: (id, data) => seen.push(`data ${id} ${data}`),
      gone: (id, window) => seen.push(`gone ${id} ${window ? 'told' : 'quiet'}`),
    });
    create('tab-a');
    create('tab-b');
    await vi.waitFor(() => expect(local.spawned).toHaveLength(2));
    local.emit({ type: 'data', id: 'tab-a', data: 'Local: http://localhost:5173/' });
    // A terminal main does not route is never tapped (nothing would forget it).
    local.emit({ type: 'data', id: 'stranger', data: 'x' });
    onHandlers.get('terminal:dispose')!(trusted, { id: 'tab-a' });
    local.emit({ type: 'exit', id: 'tab-b', exitCode: 0 });
    expect(seen).toEqual([
      'data tab-a Local: http://localhost:5173/',
      // A closed tab: nobody to tell.
      'gone tab-a quiet',
      // An exit: its window hears the end.
      'gone tab-b told',
    ]);
    off();
    create('tab-c');
    await vi.waitFor(() => expect(local.spawned).toHaveLength(3));
    local.emit({ type: 'data', id: 'tab-c', data: 'after' });
    expect(seen).toHaveLength(3);
  });

  it('hands the adopt replay to the tap with the window it goes to', async () => {
    const { terminal, create } = await setup(['kept']);
    const adopted: Array<[string, string, unknown]> = [];
    terminal.addTerminalTap({
      adopted: (id, replay, window) => adopted.push([id, replay, window]),
    });
    // The shell lived on in the daemon: the create adopts it.
    create('kept');
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    expect(adopted[0]).toEqual(['kept', 'ring of kept', sender]);
  });

  it('says which window drives a terminal, and nothing for one it does not route', async () => {
    const { local, terminal, create } = await setup();
    create('tab-a');
    await vi.waitFor(() => expect(local.spawned).toHaveLength(1));
    expect(terminal.terminalDrivenBy('tab-a', sender.id)).toBe(true);
    expect(terminal.terminalDrivenBy('tab-a', 99)).toBe(false);
    expect(terminal.terminalDrivenBy('nope', sender.id)).toBe(false);
    expect(terminal.hasTerminal('tab-a')).toBe(true);
    expect(terminal.routedTerminalIds()).toEqual(['tab-a']);
    expect(terminal.terminalHostOf('tab-a')).toBeNull();
    terminal.sendToTerminalWindow('tab-a', 'example:push', { id: 'tab-a', urls: [] });
    expect(sender.send).toHaveBeenCalledWith('example:push', { id: 'tab-a', urls: [] });
  });

  it("gives a terminal the agent tools' env only while they are set", async () => {
    const { local, terminal, create } = await setup();
    create('plain');
    await vi.waitFor(() => expect(local.spawned).toHaveLength(1));
    expect(local.spawned[0].env).not.toHaveProperty('GADGET_TOKEN');
    terminal.setTerminalAgentTools({
      instructionsPath: () => null,
      terminalEnv: (id) => ({ env: { GADGET_TOKEN: `token-of-${id}` }, binDir: null }),
      instructions: 'GADGET INSTRUCTIONS',
      allow: [],
    });
    create('with-tools');
    await vi.waitFor(() => expect(local.spawned).toHaveLength(2));
    expect(local.spawned[1].env.GADGET_TOKEN).toBe('token-of-with-tools');
    terminal.setTerminalAgentTools(null);
    create('again-plain');
    await vi.waitFor(() => expect(local.spawned).toHaveLength(3));
    expect(local.spawned[2].env).not.toHaveProperty('GADGET_TOKEN');
  });
});
