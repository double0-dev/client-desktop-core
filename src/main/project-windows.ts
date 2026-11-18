import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { isTrustedSender } from './ipc-util';
import {
  externalFor,
  holdsSweepLease,
  mainWindowId,
  maySettleProject,
  projectReturnTarget,
  projectWindowId,
  type WindowRecord,
} from './window-ownership';

/**
 * The IPC behind project windows (a private plan): opening a
 * project in its own window, the layouts it reports, raising / bringing back /
 * destroying it, routing a project click back to the main window, and the two
 * window-level asks every full-chrome window makes - what lives elsewhere, and
 * whether it holds the session-cleanup lease. The ownership rules are
 * window-ownership.ts; index.ts owns the BrowserWindows and the window table
 * and hands them in through `ProjectWindowDeps`, so this module runs against
 * the real `ipcMain` handlers in tests without Electron.
 */

/** Just enough of a serialized WorkspaceLayout to enumerate its PTY ids. */
export type SerializedLayout = { tabs: Record<string, { ptyId?: string; title?: string }> };

/**
 * A whole project opened in its own window. `sessions` lists every session of
 * the project the origin knows, with the live layout of the ones it holds
 * (null for one it never opened - its eager shells are routed by id).
 */
export type ProjectDescriptor = {
  kind: 'project';
  projectId: string;
  projectName: string;
  sessions: Array<{ sessionId: string; layout: SerializedLayout | null }>;
};

export type ProjectWindowDeps = {
  /** What each live window hosts, by webContents id - index.ts keeps it current. */
  table: Map<number, WindowRecord>;
  /** Open the project window at `bounds`; returns its webContents id. */
  createProjectWindow: (
    descriptor: ProjectDescriptor,
    bounds: { x: number; y: number; width: number; height: number },
  ) => number;
  /** Open a main window (one was missing when a project window needed it). */
  createMainWindow: () => void;
  /** Where a new project window goes: near the cursor, on that display's work area. */
  windowBounds: () => { x: number; y: number; width: number; height: number };
  raise: (wcId: number) => void;
  close: (wcId: number) => void;
  /** A live window's push channel, or null once it is gone. */
  sendTo: (wcId: number) => { send: (channel: string, payload: unknown) => void } | null;
  isQuitting: () => boolean;
  terminal: {
    isTerminalOwnedBy: (termId: string, wcId: number) => boolean;
    setPendingTerminalOwner: (termId: string, wcId: number) => void;
    reassignSessionShells: (sessionId: string, fromWcId: number, toWcId: number) => void;
    reassignWindowShells: (fromWcId: number, toWcId: number) => void;
  };
};

const CHANNELS = [
  'window:listExternal',
  'session:sweepLease',
  'project:dropExternal',
  'project:syncLayout',
  'project:focusWindow',
  'project:bringBack',
  'project:destroy',
  'project:openInMain',
] as const;

const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * What the main window is asked to show: a project, or (null) its New project
 * dialog - with the machine `hostId` preselected when an "add a project on
 * <host>" asked. A host id only rides with a null project.
 */
export type MainNavigation = { projectId: string | null; hostId?: string };

export function mainNavigation(payload: unknown): MainNavigation {
  const { projectId, hostId } = (payload ?? {}) as { projectId?: unknown; hostId?: unknown };
  if (isNonEmptyStr(projectId)) return { projectId };
  return isNonEmptyStr(hostId) && hostId.length <= 200
    ? { projectId: null, hostId }
    : { projectId: null };
}

/** Extract the `tabs` map from an opaque serialized layout, or null if malformed. */
export function layoutTabs(layout: unknown): SerializedLayout['tabs'] | null {
  if (typeof layout !== 'object' || layout === null) return null;
  const tabs = (layout as { tabs?: unknown }).tabs;
  if (typeof tabs !== 'object' || tabs === null) return null;
  return tabs as SerializedLayout['tabs'];
}

/**
 * A project descriptor's shape, with its session list reduced to the
 * well-formed entries (a non-empty id; a layout only when it has a tabs map).
 * Null when the descriptor itself is malformed - the renderer is untrusted
 * across the boundary.
 */
export function sanitizeProjectDescriptor(d: unknown): ProjectDescriptor | null {
  if (typeof d !== 'object' || d === null) return null;
  const { kind, projectId, projectName, sessions } = d as {
    kind?: unknown;
    projectId?: unknown;
    projectName?: unknown;
    sessions?: unknown;
  };
  if (kind !== 'project' || !isNonEmptyStr(projectId) || !Array.isArray(sessions)) return null;
  const entries: ProjectDescriptor['sessions'] = [];
  for (const s of sessions) {
    if (typeof s !== 'object' || s === null) continue;
    const { sessionId, layout } = s as { sessionId?: unknown; layout?: unknown };
    if (!isNonEmptyStr(sessionId)) continue;
    entries.push({ sessionId, layout: layoutTabs(layout) ? (layout as SerializedLayout) : null });
  }
  return {
    kind: 'project',
    projectId,
    projectName: typeof projectName === 'string' ? projectName : '',
    sessions: entries,
  };
}

export type ProjectWindowIpc = {
  dispose: () => void;
  /**
   * A project window is closing (or being brought back): route everything it
   * owns to the main window - every session of the project with the layout it
   * had there - so the project reappears there exactly as it was left, the
   * same hand-off a session window makes. Shells of sessions the window never
   * opened were never adopted by it and are re-routed to their owner as a
   * replay mark (see reassignWindowShells). Skipped while quitting and for a
   * project being destroyed (deleted): its shells then die with the window.
   */
  returnProjectToMain: (projectId: string, wcId: number) => void;
  /** The project window is gone: drop what main held for it. */
  forgetProjectWindow: (projectId: string, wcId: number) => void;
  /**
   * The descriptor a project window boots from, with each session's latest
   * synced layout: a reload must not restore the layouts it was opened with
   * (review, 2026-10-06).
   */
  currentDescriptor: (wcId: number, opened: ProjectDescriptor) => ProjectDescriptor;
};

export function registerProjectWindowIpc(deps: ProjectWindowDeps): ProjectWindowIpc {
  const { table, terminal } = deps;
  /**
   * Latest layout of every session each project window opened (keyed by its
   * webContents id, then session id): seeded from the descriptor it was opened
   * with and refreshed via project:syncLayout, handed back with the project
   * when the window closes.
   */
  const layouts = new Map<number, Map<string, SerializedLayout>>();
  /**
   * Projects whose windows are being destroyed (the project was deleted), so
   * the hand-back is skipped - the window keeps owning its shells, which the
   * `closed` sweep then kills.
   */
  const destroying = new Set<string>();
  /**
   * A navigation the main window owes once it exists: a project window asked
   * to open a project in the main window while there was none (closed on
   * macOS). Delivered when the recreated main window seeds its external set,
   * which is the first moment its workspace host can navigate.
   */
  let pendingMainNavigation: MainNavigation | null = null;

  const projectWindow = (projectId: string): number | null => projectWindowId(table, projectId);
  const trustedProjectId = (event: IpcMainEvent, payload: unknown): string | null => {
    if (!isTrustedSender(event)) return null;
    const projectId = (payload as { projectId?: unknown } | null | undefined)?.projectId;
    return isNonEmptyStr(projectId) ? projectId : null;
  };

  // Seed for the sidebar's "open elsewhere" flags: which sessions and projects
  // are hosted by another window right now, from the asking window's point of
  // view. Changes stream via window:externalChanged (index.ts).
  ipcMain.handle('window:listExternal', (event: IpcMainInvokeEvent) => {
    if (!isTrustedSender(event)) return { sessionIds: [], projectIds: [] };
    const external = externalFor(table, event.sender.id);
    if (pendingMainNavigation && table.get(event.sender.id)?.kind === 'main') {
      const navigation = pendingMainNavigation;
      pendingMainNavigation = null;
      deps.sendTo(event.sender.id)?.send('project:navigate', navigation);
    }
    return external;
  });

  // The session-cleanup sweep (auto-archive + auto-delete, which removes
  // worktrees) must run in exactly one window - the main window holds the
  // lease; a project window's host asks and is refused.
  ipcMain.handle(
    'session:sweepLease',
    (event: IpcMainInvokeEvent): boolean =>
      isTrustedSender(event) && holdsSweepLease(table, event.sender.id),
  );

  // A project was opened in its own window from the main window. One window per
  // project: a project already in one has that window raised instead. Otherwise
  // a full app window scoped to the project opens near the cursor, every shell
  // the origin owns for the project's sessions is pre-assigned to it (the
  // layout tabs per id, the Commands-dock and eager shells per session - the
  // same dance a session tear-off does, for the whole set), and the origin is
  // told to release the project. Sized like the app window, never from
  // window-state.json (user decision 2026-10-03: no per-project geometry in v1).
  ipcMain.on('project:dropExternal', (event: IpcMainEvent, payload: { descriptor?: unknown }) => {
    if (!isTrustedSender(event)) return;
    const originWcId = event.sender.id;
    const descriptor = sanitizeProjectDescriptor(payload?.descriptor);
    if (!descriptor) return;
    // A project window hosts one project and never opens another; only the
    // main window opens project windows.
    if (table.get(originWcId)?.kind !== 'main') return;
    const existing = projectWindow(descriptor.projectId);
    if (existing != null) {
      deps.raise(existing);
      return;
    }
    const wcId = deps.createProjectWindow(descriptor, deps.windowBounds());
    layouts.set(
      wcId,
      new Map(
        descriptor.sessions
          .filter((s): s is { sessionId: string; layout: SerializedLayout } => s.layout != null)
          .map((s) => [s.sessionId, s.layout]),
      ),
    );
    for (const s of descriptor.sessions) {
      // Only pre-assign shells the origin actually owns, guarding against a
      // malformed/hostile layout.
      const tabs = s.layout ? layoutTabs(s.layout) : null;
      if (tabs) {
        for (const tab of Object.values(tabs)) {
          if (
            tab &&
            isNonEmptyStr(tab.ptyId) &&
            terminal.isTerminalOwnedBy(tab.ptyId, originWcId)
          ) {
            terminal.setPendingTerminalOwner(tab.ptyId, wcId);
          }
        }
      }
      terminal.reassignSessionShells(s.sessionId, originWcId, wcId);
    }
    deps.sendTo(originWcId)?.send('project:removed', { projectId: descriptor.projectId });
  });

  // A project window reports the live layout of a session it has open, so main
  // holds the current one to hand back when the window closes. The surface
  // there persists to the database itself; nothing is saved here. Only a
  // window created as a project window is tracked - nothing else can enrol.
  ipcMain.on(
    'project:syncLayout',
    (event: IpcMainEvent, payload: { sessionId?: unknown; layout?: unknown }) => {
      if (!isTrustedSender(event)) return;
      const own = layouts.get(event.sender.id);
      if (!own) return;
      const sessionId = payload?.sessionId;
      if (!isNonEmptyStr(sessionId) || !layoutTabs(payload?.layout)) return;
      own.set(sessionId, payload.layout as SerializedLayout);
    },
  );

  // Raise the window hosting a project - a click on its row in any window.
  ipcMain.on('project:focusWindow', (event: IpcMainEvent, payload: unknown) => {
    const projectId = trustedProjectId(event, payload);
    if (!projectId) return;
    const wcId = projectWindow(projectId);
    if (wcId != null) deps.raise(wcId);
  });

  // "Bring to this window" / the placeholder's "Bring it back here": close the
  // project's window, which hands the project back via index.ts's 'close'
  // handler (returnProjectToMain below).
  ipcMain.on('project:bringBack', (event: IpcMainEvent, payload: unknown) => {
    const projectId = trustedProjectId(event, payload);
    if (!projectId || !maySettleProject(table, event.sender.id, projectId)) return;
    const wcId = projectWindow(projectId);
    if (wcId != null) deps.close(wcId);
  });

  // The project was deleted while open in its own window (from either window):
  // close that window destructively - its sessions went with the project, so
  // the hand-back is skipped and the `closed` sweep kills the shells.
  ipcMain.on('project:destroy', (event: IpcMainEvent, payload: unknown) => {
    const projectId = trustedProjectId(event, payload);
    if (!projectId || !maySettleProject(table, event.sender.id, projectId)) return;
    const wcId = projectWindow(projectId);
    if (wcId == null) return;
    destroying.add(projectId);
    deps.close(wcId);
  });

  // A project window's Projects panel: a click on a project that lives in no
  // window of its own focuses the MAIN window on it (null = its New project
  // dialog - the panel's "+", or New Session's "Add a project on <host>" with
  // that host picked). A project window never navigates away from its project.
  // With the main window closed (macOS) one is recreated and owes the navigation.
  ipcMain.on(
    'project:openInMain',
    (event: IpcMainEvent, payload: { projectId?: unknown; hostId?: unknown }) => {
      if (!isTrustedSender(event)) return;
      if (table.get(event.sender.id)?.kind !== 'project') return;
      const navigation = mainNavigation(payload);
      const main = mainWindowId(table);
      if (main == null) {
        pendingMainNavigation = navigation;
        deps.createMainWindow();
        return;
      }
      deps.raise(main);
      // Recreated but not listening yet (it has not listed its external set):
      // the newest click is the navigation it owes - a send now would be lost
      // and the older one delivered instead (review, 2026-10-06).
      if (pendingMainNavigation) {
        pendingMainNavigation = navigation;
        return;
      }
      deps.sendTo(main)?.send('project:navigate', navigation);
    },
  );

  return {
    dispose: () => {
      for (const channel of CHANNELS) {
        ipcMain.removeHandler(channel);
        ipcMain.removeAllListeners(channel);
      }
    },
    returnProjectToMain: (projectId, wcId) => {
      if (deps.isQuitting() || destroying.has(projectId)) return;
      const target = projectReturnTarget(table);
      if (target == null) return;
      terminal.reassignWindowShells(wcId, target);
      const own = layouts.get(wcId) ?? new Map<string, SerializedLayout>();
      deps.sendTo(target)?.send('project:returnToList', {
        projectId,
        sessions: [...own].map(([sessionId, layout]) => ({ sessionId, layout })),
      });
    },
    currentDescriptor: (wcId, opened) => {
      const own = layouts.get(wcId);
      if (!own) return opened;
      return {
        ...opened,
        sessions: opened.sessions.map((s) => ({ ...s, layout: own.get(s.sessionId) ?? s.layout })),
      };
    },
    forgetProjectWindow: (projectId, wcId) => {
      layouts.delete(wcId);
      destroying.delete(projectId);
    },
  };
}
