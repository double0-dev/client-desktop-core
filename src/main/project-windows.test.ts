import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './ipc-util';
import {
  registerProjectWindowIpc,
  sanitizeProjectDescriptor,
  type ProjectDescriptor,
  type ProjectWindowDeps,
  type ProjectWindowIpc,
} from './project-windows';
import type { WindowRecord } from './window-ownership';

/**
 * The project-window IPC, driven through the REAL ipcMain handlers (the
 * git.test.ts pattern): who may open, sync, raise, bring back and destroy a
 * project window, what a malformed or hostile message does (nothing), and the
 * shell hand-off in both directions - every shell the main window owned for
 * the project is routed to the new window, and routed back when it closes.
 */

const { onHandlers, invokeHandlers } = vi.hoisted(() => ({
  onHandlers: new Map<string, (event: unknown, payload: unknown) => void>(),
  invokeHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, fn: (event: unknown, payload: unknown) => void) => {
      onHandlers.set(channel, fn);
    },
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      invokeHandlers.set(channel, fn);
    },
    removeHandler: (channel: string) => invokeHandlers.delete(channel),
    removeAllListeners: (channel: string) => onHandlers.delete(channel),
  },
}));

const MAIN = 1;
const PROJECT_WIN = 2;
const SESSION_WIN = 3;
const PIPELINE = 'project-production-pipeline';
const DASHBOARD = 'project-web-dashboard';
const S1 = 'session-1';
const S2 = 'session-2';
const PTY_OWNED = 'pty-owned-by-main';
const PTY_FOREIGN = 'pty-owned-elsewhere';

const mainFrame = { url: `${APP_ORIGIN}/index.html` };
const from = (wcId: number): unknown => ({
  senderFrame: mainFrame,
  sender: { id: wcId, mainFrame },
});
const untrustedFrom = (wcId: number): unknown => ({
  senderFrame: { url: 'https://evil.example.com/' },
  sender: { id: wcId, mainFrame: { url: 'https://evil.example.com/' } },
});

const descriptor = (over: Partial<ProjectDescriptor> = {}): ProjectDescriptor => ({
  kind: 'project',
  projectId: PIPELINE,
  projectName: 'production-pipeline',
  sessions: [
    { sessionId: S1, layout: { tabs: { t1: { ptyId: PTY_OWNED }, t2: { ptyId: PTY_FOREIGN } } } },
    { sessionId: S2, layout: null },
  ],
  ...over,
});

describe('project window IPC', () => {
  let table: Map<number, WindowRecord>;
  let deps: ProjectWindowDeps;
  let ipc: ProjectWindowIpc;
  let nextWcId: number;
  let quitting: boolean;
  /** Every push main made: (wcId, channel, payload). */
  const sent = vi.fn<(wcId: number, channel: string, payload: unknown) => void>();

  beforeEach(() => {
    table = new Map([[MAIN, { kind: 'main' }]]);
    nextWcId = 10;
    quitting = false;
    sent.mockClear();
    deps = {
      table,
      createProjectWindow: vi.fn((d: ProjectDescriptor) => {
        const wcId = nextWcId++;
        table.set(wcId, { kind: 'project', projectId: d.projectId });
        return wcId;
      }),
      createMainWindow: vi.fn(() => {
        table.set(MAIN, { kind: 'main' });
      }),
      windowBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
      raise: vi.fn(),
      close: vi.fn(),
      sendTo: (wcId: number) => ({
        send: (channel: string, payload: unknown) => sent(wcId, channel, payload),
      }),
      isQuitting: () => quitting,
      terminal: {
        isTerminalOwnedBy: vi.fn((id: string, wcId: number) => id === PTY_OWNED && wcId === MAIN),
        setPendingTerminalOwner: vi.fn(),
        reassignSessionShells: vi.fn(),
        reassignWindowShells: vi.fn(),
      },
    };
    ipc = registerProjectWindowIpc(deps);
  });
  afterEach(() => ipc.dispose());

  const open = (payload: unknown, event: unknown = from(MAIN)): void =>
    onHandlers.get('project:dropExternal')!(event, payload);
  const openPipeline = (): number => {
    open({ descriptor: descriptor() });
    return nextWcId - 1;
  };

  describe('sanitizeProjectDescriptor', () => {
    it('keeps well-formed sessions and drops the rest', () => {
      const d = sanitizeProjectDescriptor({
        kind: 'project',
        projectId: PIPELINE,
        projectName: 42,
        sessions: [
          { sessionId: S1, layout: { tabs: {} } },
          { sessionId: S2, layout: 'nope' },
          { sessionId: '' },
          null,
          'junk',
        ],
      });
      expect(d).toEqual({
        kind: 'project',
        projectId: PIPELINE,
        projectName: '',
        sessions: [
          { sessionId: S1, layout: { tabs: {} } },
          { sessionId: S2, layout: null },
        ],
      });
    });

    it('rejects anything that is not a project descriptor', () => {
      expect(sanitizeProjectDescriptor(null)).toBeNull();
      expect(sanitizeProjectDescriptor({ kind: 'session', projectId: PIPELINE })).toBeNull();
      expect(
        sanitizeProjectDescriptor({ kind: 'project', projectId: '', sessions: [] }),
      ).toBeNull();
      expect(sanitizeProjectDescriptor({ kind: 'project', projectId: PIPELINE })).toBeNull();
      expect(
        sanitizeProjectDescriptor({ kind: 'project', projectId: { toString: () => PIPELINE } }),
      ).toBeNull();
    });
  });

  describe('opening a project in its own window', () => {
    it('opens the window, routes the shells the origin owns to it and releases the project there', () => {
      const wcId = openPipeline();
      expect(deps.createProjectWindow).toHaveBeenCalledWith(descriptor(), {
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
      });
      // Per-tab: only a shell the main window actually owns is pre-assigned -
      // a layout naming another window's pty must not hijack it.
      expect(deps.terminal.setPendingTerminalOwner).toHaveBeenCalledTimes(1);
      expect(deps.terminal.setPendingTerminalOwner).toHaveBeenCalledWith(PTY_OWNED, wcId);
      // Per-session: the Commands-dock and eager shells, for every session,
      // including the one the origin never opened (no layout).
      expect(deps.terminal.reassignSessionShells).toHaveBeenCalledWith(S1, MAIN, wcId);
      expect(deps.terminal.reassignSessionShells).toHaveBeenCalledWith(S2, MAIN, wcId);
      expect(sent).toHaveBeenCalledWith(MAIN, 'project:removed', { projectId: PIPELINE });
    });

    it('raises the existing window instead of opening a second one', () => {
      // One window per project (user decision 2026-10-03).
      const wcId = openPipeline();
      vi.mocked(deps.createProjectWindow).mockClear();
      openPipeline();
      expect(deps.createProjectWindow).not.toHaveBeenCalled();
      expect(deps.raise).toHaveBeenCalledWith(wcId);
    });

    it('ignores an untrusted sender, a malformed descriptor and an option-shaped argument', () => {
      open({ descriptor: descriptor() }, untrustedFrom(MAIN));
      open({ descriptor: { kind: 'project', sessions: [] } });
      open({ descriptor: { kind: 'project', projectId: PIPELINE, sessions: 'all' } });
      open({ projectId: PIPELINE });
      open(null);
      expect(deps.createProjectWindow).not.toHaveBeenCalled();
      expect(sent).not.toHaveBeenCalled();
    });

    it('only lets the main window open project windows', () => {
      // A project window hosts one project and never opens another; a session
      // window has no project list at all.
      table.set(PROJECT_WIN, { kind: 'project', projectId: DASHBOARD });
      table.set(SESSION_WIN, { kind: 'session', sessionId: S1, projectId: PIPELINE });
      open({ descriptor: descriptor() }, from(PROJECT_WIN));
      open({ descriptor: descriptor() }, from(SESSION_WIN));
      expect(deps.createProjectWindow).not.toHaveBeenCalled();
    });
  });

  describe('handing the project back', () => {
    it('routes every shell the window owns to the main window with the layouts it reported', () => {
      const wcId = openPipeline();
      // The window opened S1 and changed its layout, and opened S2 afresh.
      const updated = { tabs: { t1: { ptyId: PTY_OWNED }, t3: { ptyId: 'pty-new' } } };
      onHandlers.get('project:syncLayout')!(from(wcId), { sessionId: S1, layout: updated });
      onHandlers.get('project:syncLayout')!(from(wcId), { sessionId: S2, layout: { tabs: {} } });
      sent.mockClear();
      ipc.returnProjectToMain(PIPELINE, wcId);
      expect(deps.terminal.reassignWindowShells).toHaveBeenCalledWith(wcId, MAIN);
      expect(sent).toHaveBeenCalledWith(MAIN, 'project:returnToList', {
        projectId: PIPELINE,
        sessions: [
          { sessionId: S1, layout: updated },
          { sessionId: S2, layout: { tabs: {} } },
        ],
      });
    });

    it('boots a reloaded window on the layouts it synced, not the ones it opened with', () => {
      const wcId = openPipeline();
      const updated = { tabs: { t3: { ptyId: 'pty-new' } } };
      onHandlers.get('project:syncLayout')!(from(wcId), { sessionId: S1, layout: updated });
      const booted = ipc.currentDescriptor(wcId, descriptor() as never);
      expect(booted.sessions.find((x) => x.sessionId === S1)?.layout).toEqual(updated);
    });

    it('hands back the tear-off layout of a session the window never opened', () => {
      const wcId = openPipeline();
      sent.mockClear();
      ipc.returnProjectToMain(PIPELINE, wcId);
      const payload = sent.mock.calls[0][2] as { sessions: unknown[] };
      expect(payload.sessions).toEqual([
        { sessionId: S1, layout: descriptor().sessions[0].layout },
      ]);
    });

    it('takes a layout only from the project window itself, and only a well-formed one', () => {
      const wcId = openPipeline();
      onHandlers.get('project:syncLayout')!(from(MAIN), { sessionId: S1, layout: { tabs: {} } });
      onHandlers.get('project:syncLayout')!(untrustedFrom(wcId), {
        sessionId: S1,
        layout: { tabs: {} },
      });
      onHandlers.get('project:syncLayout')!(from(wcId), { sessionId: S1, layout: 'junk' });
      onHandlers.get('project:syncLayout')!(from(wcId), { sessionId: '', layout: { tabs: {} } });
      sent.mockClear();
      ipc.returnProjectToMain(PIPELINE, wcId);
      const payload = sent.mock.calls[0][2] as { sessions: unknown[] };
      expect(payload.sessions).toEqual([
        { sessionId: S1, layout: descriptor().sessions[0].layout },
      ]);
    });

    it('hands nothing back while quitting, or once the project was destroyed', () => {
      // Quit: every window is going away and will-quit kills the shells.
      // Destroy: the project was deleted - its shells die with the window.
      const wcId = openPipeline();
      sent.mockClear();
      quitting = true;
      ipc.returnProjectToMain(PIPELINE, wcId);
      quitting = false;
      onHandlers.get('project:destroy')!(from(MAIN), { projectId: PIPELINE });
      expect(deps.close).toHaveBeenCalledWith(wcId);
      ipc.returnProjectToMain(PIPELINE, wcId);
      expect(deps.terminal.reassignWindowShells).not.toHaveBeenCalled();
      expect(sent).not.toHaveBeenCalled();
    });

    it('hands nothing back when no main window exists to take it', () => {
      const wcId = openPipeline();
      table.delete(MAIN);
      sent.mockClear();
      ipc.returnProjectToMain(PIPELINE, wcId);
      expect(deps.terminal.reassignWindowShells).not.toHaveBeenCalled();
      expect(sent).not.toHaveBeenCalled();
    });

    it('forgets a closed window, so a reopened project starts from a fresh descriptor', () => {
      const wcId = openPipeline();
      ipc.forgetProjectWindow(PIPELINE, wcId);
      table.delete(wcId);
      // Destroyed-flag cleared too: a later window of the same project hands back.
      const again = openPipeline();
      sent.mockClear();
      ipc.returnProjectToMain(PIPELINE, again);
      expect(sent).toHaveBeenCalledWith(
        MAIN,
        'project:returnToList',
        expect.objectContaining({ projectId: PIPELINE }),
      );
    });
  });

  describe('raise, bring back, destroy', () => {
    it('raises the window on focusWindow from any trusted window', () => {
      const wcId = openPipeline();
      table.set(SESSION_WIN, { kind: 'session', sessionId: S1, projectId: PIPELINE });
      onHandlers.get('project:focusWindow')!(from(SESSION_WIN), { projectId: PIPELINE });
      expect(deps.raise).toHaveBeenCalledWith(wcId);
    });

    it('closes the window on bringBack from the main window or the window itself', () => {
      const wcId = openPipeline();
      onHandlers.get('project:bringBack')!(from(MAIN), { projectId: PIPELINE });
      onHandlers.get('project:bringBack')!(from(wcId), { projectId: PIPELINE });
      expect(deps.close).toHaveBeenCalledTimes(2);
      expect(deps.close).toHaveBeenCalledWith(wcId);
    });

    it('refuses bringBack and destroy from any other window', () => {
      openPipeline();
      table.set(PROJECT_WIN, { kind: 'project', projectId: DASHBOARD });
      table.set(SESSION_WIN, { kind: 'session', sessionId: S1, projectId: PIPELINE });
      for (const channel of ['project:bringBack', 'project:destroy']) {
        onHandlers.get(channel)!(from(PROJECT_WIN), { projectId: PIPELINE });
        onHandlers.get(channel)!(from(SESSION_WIN), { projectId: PIPELINE });
        onHandlers.get(channel)!(untrustedFrom(MAIN), { projectId: PIPELINE });
      }
      expect(deps.close).not.toHaveBeenCalled();
    });

    it('ignores a missing project, a non-string id and an untrusted sender', () => {
      openPipeline();
      for (const channel of ['project:focusWindow', 'project:bringBack', 'project:destroy']) {
        onHandlers.get(channel)!(from(MAIN), { projectId: DASHBOARD });
        onHandlers.get(channel)!(from(MAIN), { projectId: 42 });
        onHandlers.get(channel)!(from(MAIN), { projectId: { toString: () => PIPELINE } });
        onHandlers.get(channel)!(from(MAIN), null);
        onHandlers.get(channel)!(untrustedFrom(MAIN), { projectId: PIPELINE });
      }
      expect(deps.raise).not.toHaveBeenCalled();
      expect(deps.close).not.toHaveBeenCalled();
    });
  });

  describe('a project window pointing the main window at a project', () => {
    it('raises the main window and sends it the navigation', () => {
      const wcId = openPipeline();
      sent.mockClear();
      onHandlers.get('project:openInMain')!(from(wcId), { projectId: DASHBOARD });
      expect(deps.raise).toHaveBeenCalledWith(MAIN);
      expect(sent).toHaveBeenCalledWith(MAIN, 'project:navigate', { projectId: DASHBOARD });
      // null = the main window's New project dialog (the Projects panel's "+").
      onHandlers.get('project:openInMain')!(from(wcId), { projectId: null });
      expect(sent).toHaveBeenCalledWith(MAIN, 'project:navigate', { projectId: null });
    });

    it('carries the host of "Add a project on <host>" with a null project only', () => {
      // An Add host dialog in a project window: the project is created in the
      // main window, with that host preselected.
      const wcId = openPipeline();
      sent.mockClear();
      onHandlers.get('project:openInMain')!(from(wcId), { projectId: null, hostId: 'host-1' });
      expect(sent).toHaveBeenLastCalledWith(MAIN, 'project:navigate', {
        projectId: null,
        hostId: 'host-1',
      });
      // A project to show never takes a host along; a junk host is dropped.
      onHandlers.get('project:openInMain')!(from(wcId), { projectId: DASHBOARD, hostId: 'host-1' });
      expect(sent).toHaveBeenLastCalledWith(MAIN, 'project:navigate', { projectId: DASHBOARD });
      onHandlers.get('project:openInMain')!(from(wcId), { projectId: null, hostId: { x: 1 } });
      expect(sent).toHaveBeenLastCalledWith(MAIN, 'project:navigate', { projectId: null });
      onHandlers.get('project:openInMain')!(from(wcId), {
        projectId: null,
        hostId: 'h'.repeat(201),
      });
      expect(sent).toHaveBeenLastCalledWith(MAIN, 'project:navigate', { projectId: null });
    });

    it('recreates a missing main window and delivers the navigation on its first seed', () => {
      // macOS: the main window was closed while the project window stayed open.
      const wcId = openPipeline();
      table.delete(MAIN);
      sent.mockClear();
      onHandlers.get('project:openInMain')!(from(wcId), { projectId: DASHBOARD });
      expect(deps.createMainWindow).toHaveBeenCalledTimes(1);
      expect(sent).not.toHaveBeenCalled();
      // The new main window's host seeds its external set - its first ask.
      const external = invokeHandlers.get('window:listExternal')!(from(MAIN), undefined);
      expect(external).toEqual({ sessionIds: [], projectIds: [PIPELINE] });
      expect(sent).toHaveBeenCalledWith(MAIN, 'project:navigate', { projectId: DASHBOARD });
      // Delivered once.
      sent.mockClear();
      invokeHandlers.get('window:listExternal')!(from(MAIN), undefined);
      expect(sent).not.toHaveBeenCalled();
    });

    it('a second click while the recreated main window loads replaces the navigation it owes', () => {
      const wcId = openPipeline();
      const mainRecord = table.get(MAIN)!;
      table.delete(MAIN);
      sent.mockClear();
      onHandlers.get('project:openInMain')!(from(wcId), { projectId: DASHBOARD });
      // The new window is in the table, its renderer not listening yet.
      table.set(MAIN, mainRecord);
      onHandlers.get('project:openInMain')!(from(wcId), { projectId: null });
      expect(sent).not.toHaveBeenCalled();
      invokeHandlers.get('window:listExternal')!(from(MAIN), undefined);
      expect(sent).toHaveBeenCalledTimes(1);
      expect(sent).toHaveBeenCalledWith(MAIN, 'project:navigate', { projectId: null });
    });

    it('only honours a project window, never the main window, a session window or an untrusted sender', () => {
      const wcId = openPipeline();
      table.set(SESSION_WIN, { kind: 'session', sessionId: S1, projectId: PIPELINE });
      sent.mockClear();
      onHandlers.get('project:openInMain')!(from(MAIN), { projectId: DASHBOARD });
      onHandlers.get('project:openInMain')!(from(SESSION_WIN), { projectId: DASHBOARD });
      onHandlers.get('project:openInMain')!(untrustedFrom(wcId), { projectId: DASHBOARD });
      expect(sent).not.toHaveBeenCalled();
      expect(deps.raise).not.toHaveBeenCalledWith(MAIN);
    });
  });

  describe('the window-level asks', () => {
    it("answers each window's own view of what lives elsewhere", () => {
      const wcId = openPipeline();
      table.set(SESSION_WIN, { kind: 'session', sessionId: S1, projectId: PIPELINE });
      const ask = (w: number): unknown =>
        invokeHandlers.get('window:listExternal')!(from(w), undefined);
      expect(ask(MAIN)).toEqual({ sessionIds: [S1], projectIds: [PIPELINE] });
      expect(ask(wcId)).toEqual({ sessionIds: [S1], projectIds: [] });
      expect(invokeHandlers.get('window:listExternal')!(untrustedFrom(MAIN), undefined)).toEqual({
        sessionIds: [],
        projectIds: [],
      });
    });

    it('grants the cleanup sweep lease to the main window only', () => {
      // The regression this guards: two full-chrome windows both sweeping and
      // double-deleting a worktree.
      const wcId = openPipeline();
      const lease = (event: unknown): unknown =>
        invokeHandlers.get('session:sweepLease')!(event, undefined);
      expect(lease(from(MAIN))).toBe(true);
      expect(lease(from(wcId))).toBe(false);
      expect(lease(untrustedFrom(MAIN))).toBe(false);
    });
  });
});
