import { app, ipcMain } from 'electron';
import { join } from 'node:path';
import { isTrustedSender } from './ipc-util';
import {
  SESSION_DAEMON_STATE_FILE,
  launchNoticeDue,
  loadSessionDaemonState,
  writeSessionDaemonState,
  type SessionDaemonState,
} from './session-daemon-state';
import type { DaemonRow } from './daemon-migrate';
import type { TerminalBackend } from './terminal-backend';

/**
 * The `sessions:*` IPC behind Settings › Sessions › "After quit"
 * (a private plan): the Keep-running switch the renderer
 * mirrors into main (session-daemon-state.ts), "Stop all sessions", which
 * kills every live terminal in the daemon without quitting, and the
 * once-ever launch notice ("N sessions kept running while double0 was
 * closed") the main window shows the first time terminals outlive a quit,
 * and the daemons list (one per build that still holds terminals) with Move
 * now for an older build's (daemon-migrate.ts).
 * The quit sequence (index.ts) reads `keepSessionsOnQuit()` to decide
 * whether to let the daemon keep its shells.
 */
const CHANNELS = [
  'sessions:setKeepRunning',
  'sessions:stopAll',
  'sessions:launchNotice',
  'sessions:daemons',
  'sessions:moveDaemon',
] as const;

let state: SessionDaemonState | null = null;
let statePath: string | null = null;

function current(): SessionDaemonState {
  if (!state) {
    statePath = join(app.getPath('userData'), SESSION_DAEMON_STATE_FILE);
    state = loadSessionDaemonState(statePath);
  }
  return state;
}

function save(next: SessionDaemonState): void {
  state = next;
  if (statePath) writeSessionDaemonState(statePath, next);
}

/** Whether quitting the app should leave the daemon's terminals running. */
export function keepSessionsOnQuit(): boolean {
  return current().keepRunning;
}

export type SessionDaemonIpcDeps = {
  /** The main window's webContents id (window-ownership.ts) - the only one that shows the launch notice. */
  isMainWindow: (wcId: number) => boolean;
  /**
   * Stop every terminal (terminal.ts › `stopAllTerminals`): main's records
   * end and each window hears its tabs exit BEFORE the backend kills them -
   * the backend's `killAll` alone reports nothing, and the tabs sat as if
   * alive on dead shells.
   */
  /** False when the machine could not be reached (its sessions keep running). */
  stopAll: (hostId: string | null) => Promise<void | boolean>;
  /** terminal.ts › daemonOverview. */
  daemons?: () => Promise<DaemonRow[]>;
  /** terminal.ts › moveDaemonTerminals: null for an unknown or current daemon. */
  moveDaemon?: (
    socketPath: string,
    confirmed: boolean,
  ) => Promise<{ moved: number; busy: number; unresumable: number; kept: number } | null>;
};

/** A daemon's socket path as the renderer hands it back - main re-checks it is a known one. */
const isSocketPath = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 1024 && !v.startsWith('-');

/** A host id as Stop all takes it (hosts-ipc.ts's rule) - never option-shaped. */
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export function registerSessionDaemonIpc(
  backend: TerminalBackend,
  deps: SessionDaemonIpcDeps = {
    isMainWindow: () => true,
    stopAll: (hostId) => backend.killAll(hostId),
  },
): () => void {
  // The terminals that outlived the last run: the daemon lists them while the
  // backend boots (`discovered` fires before `ready()` settles). A daemon
  // reconnecting later re-lists the same terminals - not news, not counted.
  const discoveredAtBoot = new Set<string>();
  let booting = true;
  const offEvents = backend.onEvent((ev) => {
    if (ev.type !== 'discovered' || !booting) return;
    for (const t of ev.terminals) discoveredAtBoot.add(t.id);
  });
  void backend.ready().then(() => {
    booting = false;
  });

  ipcMain.handle('sessions:setKeepRunning', (event, value: unknown) => {
    if (!isTrustedSender(event)) return;
    if (typeof value !== 'boolean') return;
    const next = { ...current(), keepRunning: value };
    if (next.keepRunning === state?.keepRunning) return;
    save(next);
  });

  // Ends every running terminal and agent now; the tabs stay open and show
  // the exit (each terminal's exit reaches its window as usual). Per machine
  // (a private plan › 16): null / absent = this one, a
  // host id = that remote host's sessions.
  ipcMain.handle('sessions:stopAll', async (event, hostId: unknown) => {
    if (!isTrustedSender(event)) return false;
    if (
      hostId !== undefined &&
      hostId !== null &&
      !(typeof hostId === 'string' && HOST_ID.test(hostId))
    ) {
      return false;
    }
    return (await deps.stopAll(typeof hostId === 'string' ? hostId : null)) !== false;
  });

  // The launch notice, answered once ever on this machine: the ids of the
  // terminals the daemon kept across the last quit (the renderer maps them to
  // sessions and words the notice), or null - already shown, nothing kept, or
  // not the main window asking. Answering IS showing: the flag flips here, so
  // a second window or a reload can never show it twice.
  ipcMain.handle('sessions:launchNotice', async (event) => {
    if (!isTrustedSender(event)) return null;
    if (!deps.isMainWindow(event.sender.id)) return null;
    await backend.ready();
    if (!launchNoticeDue(current(), discoveredAtBoot.size)) return null;
    save({ ...current(), launchNoticeShown: true });
    return { terminalIds: [...discoveredAtBoot] };
  });

  // Settings › Sessions › Session daemons. Every answer comes from main's own
  // table: the renderer only ever names a daemon it was listed.
  ipcMain.handle('sessions:daemons', async (event) => {
    if (!isTrustedSender(event)) return [];
    await backend.ready();
    return (await deps.daemons?.()) ?? [];
  });

  // `confirmed` = the user said yes to restarting busy or unresumable tabs;
  // only a literal true counts.
  ipcMain.handle('sessions:moveDaemon', async (event, socketPath: unknown, confirmed: unknown) => {
    if (!isTrustedSender(event)) return null;
    if (!isSocketPath(socketPath)) return null;
    return (await deps.moveDaemon?.(socketPath, confirmed === true)) ?? null;
  });

  return () => {
    offEvents();
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}
