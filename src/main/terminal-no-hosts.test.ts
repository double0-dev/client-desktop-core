import { describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './ipc-util';
import type { HostSpawnRequest, TerminalSummary } from './pty-host';
import type { TerminalBackend } from './terminal-backend';
import { hostOfPath } from './host-of-path';

/**
 * terminal.ts in the core build (a private plan › M7):
 * no remote hosts registered - no host router, no spawn planner, no sign-in
 * flow - wired as index.ts wires it (`localOnly(readyAfter(local, roots))`
 * and the core path-to-host resolvers). A project the official build put on
 * a host must still never get a shell on THIS machine: its terminals end at
 * once and nothing spawns, here or anywhere. The same paths with the hosts
 * registered are Pro's (the official build).
 */

const { onHandlers } = vi.hoisted(() => ({
  onHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.6.4', getPath: () => '/tmp/double0-terminal-no-hosts-test' },
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

/** This machine's backend: records every spawn. */
function localBackend() {
  const spawned: HostSpawnRequest[] = [];
  const live: string[] = [];
  const backend: TerminalBackend = {
    ready: () => Promise.resolve(),
    onEvent: (() => () => undefined) as TerminalBackend['onEvent'],
    spawn: async (req) => {
      spawned.push(req);
      live.push(req.id);
      return true;
    },
    list: async () => live.map(summary),
    adopt: async (id) => ({ data: `screen of ${id}`, cols: 100, rows: 30 }),
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
  return { backend, spawned };
}

const mainFrame = { url: `${APP_ORIGIN}/index.html` };
const sender = { id: 7, mainFrame, isDestroyed: () => false, send: vi.fn() };
const trusted = { senderFrame: mainFrame, sender };
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
const sent = (channel: string): unknown[] =>
  sender.send.mock.calls.filter((c) => c[0] === channel).map((c) => c[1]);

/** A project the official build put on host build-box (its row's `hostId`). */
const ROOTS = [{ hostId: 'build-box', path: '/home/emmaw/acme' }];
const REMOTE_SID = '5b0c3a1e-7f2d-4c8e-9a61-2d4f8e0b7c13';

async function setup(rootsRead: Promise<unknown> = Promise.resolve()) {
  vi.resetModules();
  onHandlers.clear();
  sender.send.mockClear();
  const local = localBackend();
  const { localOnly, readyAfter } = await import('./remote-hosts');
  const terminal = await import('./terminal');
  let roots: typeof ROOTS = [];
  void rootsRead.then(() => {
    roots = ROOTS;
  });
  const started = localOnly(readyAfter(local.backend, rootsRead));
  terminal.setTerminalHostResolver((cwd) => hostOfPath(cwd, roots));
  terminal.setTerminalSessionHostResolver((sid) =>
    Promise.resolve(sid === REMOTE_SID ? 'build-box' : null),
  );
  terminal.registerTerminalIpc(started.backend);
  await settle();
  const create = (id: string, cwd: string, initialCommand?: string): void => {
    onHandlers.get('terminal:create')!(trusted, { id, cwd, cols: 120, rows: 40, initialCommand });
  };
  return { local, create, terminal };
}

describe.skipIf(process.platform === 'win32')(
  'terminals with no remote hosts (the core build)',
  () => {
    // A terminal id the extension marks as its work (`terminalFeatures`):
    // naming it must not start it while that feature is not entitled.
    // `gadget:` / `gadget` stand in for an extension's prefix and feature.
    const GADGET: readonly (readonly [string, string])[] = [['gadget:', 'gadget']];

    it("refuses a new terminal of the extension's work while its feature is not entitled", async () => {
      const { local, create, terminal } = await setup();
      terminal.setTerminalEntitlement(GADGET, () => false);
      create('gadget:s1:c1', '/tmp/acme', 'pnpm dev');
      await vi.waitFor(() =>
        expect(sent('terminal:exit')).toContainEqual({ id: 'gadget:s1:c1', exitCode: -1 }),
      );
      expect(local.spawned).toEqual([]);
    });

    it('starts it once the feature is entitled', async () => {
      const { local, create, terminal } = await setup();
      terminal.setTerminalEntitlement(GADGET, (feature) => feature === 'gadget');
      create('gadget:s1:c1', '/tmp/acme', 'pnpm dev');
      await vi.waitFor(() => expect(local.spawned.map((s) => s.id)).toEqual(['gadget:s1:c1']));
    });

    it('names the feature a terminal id needs by its prefix, none for core ids', async () => {
      const { terminal } = await setup();
      terminal.setTerminalEntitlement(GADGET, () => true);
      expect(terminal.terminalFeature('gadget:s1:auto:dev')).toBe('gadget');
      expect(terminal.terminalFeature(`conversation:${REMOTE_SID}`)).toBeNull();
      expect(terminal.terminalFeature('setup:s1')).toBeNull();
      expect(terminal.terminalFeature('commands:s1:c1')).toBeNull();
    });

    it("ends a remote project's terminal and a host sign-in at once, spawning nothing here", async () => {
      const { local, create } = await setup();
      create('remote-tab', '/home/emmaw/acme/src', 'claude');
      create('host-signin:build-box:claude:n1', '~');
      await vi.waitFor(() =>
        expect(sent('terminal:exit')).toEqual(
          expect.arrayContaining([
            { id: 'remote-tab', exitCode: -1 },
            { id: 'host-signin:build-box:claude:n1', exitCode: -1 },
          ]),
        ),
      );
      expect(local.spawned).toEqual([]);
    });

    it("never starts a local shell for a remote project's session, whatever folder it names", async () => {
      const { local, create } = await setup();
      // A folder outside every remote root - by path alone it is this machine's.
      create(`conversation:${REMOTE_SID}`, '/tmp/outside', 'claude');
      await vi.waitFor(() =>
        expect(sent('terminal:exit')).toContainEqual({
          id: `conversation:${REMOTE_SID}`,
          exitCode: -1,
        }),
      );
      expect(local.spawned).toEqual([]);
      // A local session's shell and a local folder spawn here as always.
      const other = '6c1d4b2f-8e3a-4d9f-8b72-3e5a9f1c8d24';
      create(`conversation:${other}`, '/tmp/outside');
      create('local-tab', '/home/emmaw/acme-old');
      await vi.waitFor(() =>
        expect(local.spawned.map((r) => r.id).sort()).toEqual(
          [`conversation:${other}`, 'local-tab'].sort(),
        ),
      );
    });

    it('waits for the remote project roots before deciding where a create runs', async () => {
      // Decided before the roots are read, the host's folder would read as
      // this machine's - a laptop shell at the host's path (readyAfter).
      let finish!: () => void;
      const rootsRead = new Promise<void>((r) => (finish = r));
      const { local, create } = await setup(rootsRead);
      create('early-tab', '/home/emmaw/acme');
      await settle();
      await settle();
      expect(local.spawned).toEqual([]);
      expect(sent('terminal:exit')).toEqual([]);
      finish();
      await vi.waitFor(() =>
        expect(sent('terminal:exit')).toContainEqual({ id: 'early-tab', exitCode: -1 }),
      );
      expect(local.spawned).toEqual([]);
    });
  },
);
