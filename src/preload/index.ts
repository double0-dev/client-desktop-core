import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
// The one core file allowed to import it (a private plan).
import { proPreload } from '@pro/preload';
import type { InputEntry } from '../main/terminal-inputs';
import type { HostConfig, HostState, HostStatus } from '../main/host-types';
import { DEMO_ARG, LOCAL_ENV_ARG } from '../main/window-chrome';

// Main reports full screen on every change and once the page is up (a window
// restored into full screen enters it before the page listens); the latest
// value is kept here so the header reads it on its first render.
let fullScreen = false;
ipcRenderer.on('window:fullScreen', (_e: IpcRendererEvent, value: boolean) => {
  fullScreen = value === true;
});

// Pro's preload setup (a private plan): the sign-in
// bridges as window globals. Nothing in the core build.
proPreload.setup?.();
import type { GitIgnoredEntry, GitStatus, GitRefs, GitChangeKind } from '../main/git';
import type { UploadProgress, UploadSkip, UploadError } from '../main/upload';
import type { NoticesAnswer, PlatformLicense } from '../main/third-party-notices';

/** What `fs.upload` answers (plan 29 spec › 9.3). */
/** One session daemon as Settings › Sessions lists it (src/main/daemon-migrate.ts › DaemonRow). */
export type SessionDaemonRow = {
  socketPath: string;
  buildId: string;
  current: boolean;
  terminals: number;
  busy: number;
};

export type UploadAnswer = {
  /** A name was taken and `onClash` was 'ask': nothing was written. */
  clash?: { name: string; count: number };
  ok?: boolean;
  copied?: string[];
  skipped?: UploadSkip[];
  errors?: UploadError[];
  cancelled?: true;
  unreachable?: true;
  error?: string;
  code?: string;
};
type TerminalCreateOptions = {
  id: string;
  cwd?: string | null;
  cols?: number;
  rows?: number;
  /** Command to auto-run once on first spawn (e.g. `claude`). */
  initialCommand?: string;
  /** Start the shell with integration (the Inputs list) - Settings › Terminal. */
  shellIntegration?: boolean;
};

/** A terminal tab being moved between windows (or out to a new one). */
export type TabDescriptor = {
  kind: 'terminal';
  /** Stable PTY id; the receiving window adopts the live shell by this id. */
  termId: string;
  title: string;
  cwd: string | null;
};
/**
 * A whole session being torn off into its own window. `layout` is the renderer's
 * serialized WorkspaceLayout (opaque here, at the IPC boundary) or null when the
 * session was never opened; the receiving renderer casts it back.
 */
export type SessionDescriptor = {
  kind: 'session';
  sessionId: string;
  /** The session's project - a session torn off from a project window returns there. */
  projectId: string | null;
  label: string;
  projectName: string | null;
  layout: unknown | null;
  cwd: string | null;
  /** The bottom panel's view state (opaque here); the receiving renderer casts it. */
  commandDock: unknown | null;
};
/**
 * A whole project opened in its own window (a private plan):
 * every session of the project the origin knows, with the live layout (opaque
 * here) of the ones it holds - null for one it never opened.
 */
export type ProjectDescriptor = {
  kind: 'project';
  projectId: string;
  projectName: string;
  sessions: Array<{ sessionId: string; layout: unknown | null }>;
};
/** One-shot payload a freshly-created window pulls on load. */
export type InitialPayload =
  | { kind: 'detached'; tab: TabDescriptor }
  | { kind: 'session'; session: SessionDescriptor }
  | { kind: 'project'; project: ProjectDescriptor }
  | null;
/**
 * What lives in another window, from this window's point of view: torn-off
 * sessions, and projects open in a project window other than this one (the
 * renderer expands those to their sessions).
 */
export type ExternalWindows = { sessionIds: string[]; projectIds: string[] };

/** A row change broadcast by main after a local DB write (see src/main/db/ipc.ts). */
export type DbChange =
  | { table: string; type: 'insert' | 'update'; row: unknown }
  | { table: string; type: 'delete'; id: string };

/** One directory entry in the file-explorer tree (see src/main/fs.ts). */
export type DirEntry = { name: string; path: string; isDirectory: boolean };

/** Status of one registry language (see src/main/language-servers.ts). */
export type LanguageServerStatus = {
  id: string;
  name: string;
  extensions: string[];
  status: 'builtin' | 'installed' | 'on-path' | 'installing' | 'available' | 'missing-tool';
  version?: string;
  path?: string;
  updateTo?: string;
  installHint?: string;
  approxMb?: number;
};

/** Install progress push (see src/main/language-server-install.ts). */
export type LanguageServerInstallProgress = {
  languageId: string;
  /** The host the install runs on; absent = this machine. */
  hostId?: string;
  phase: 'download' | 'done' | 'error';
  done: number;
  total: number;
  error?: string;
};

/** One file in the cross-project Search Everywhere index (see src/main/search.ts). */
export type SearchFileEntry = {
  path: string;
  name: string;
  projectId: string;
  projectName: string;
  /** The remote host the file lives on (plan 29 › M5), null = this computer. */
  hostId: string | null;
  /** From a host that is unreachable now - its last list. */
  stale?: true;
};

/**
 * Terminal output/exit fan-out: ONE channel listener routing by id, instead of
 * a filtering listener per terminal - with a dozen terminals open, per-chunk
 * delivery is one Map lookup rather than twelve predicate calls. One handler
 * per id (each TerminalView owns its ptyId exclusively); unsubscribe is
 * identity-guarded so a StrictMode re-subscribe can't be torn down by the stale
 * cleanup running after it.
 */
/** PTY grid size attached to an adoption replay (see `adopt` in main/terminal.ts). */
export type TerminalReplaySize = { cols: number; rows: number };

/** A host as the renderer's store keeps it, and its state as main reports it. */
export type HostConfigPayload = HostConfig;
export type HostStatusPayload = HostStatus;
export type HostStatePayload = HostState;
const terminalDataHandlers = new Map<
  string,
  (data: string, replaySize?: TerminalReplaySize) => void
>();
const terminalExitHandlers = new Map<string, (exitCode: number) => void>();
// A parallel, display-independent observer of output (one per id) used to derive
// session activity status. Kept separate from the single data handler that pipes
// to xterm, so observing activity never disturbs the terminal display. Receives the
// output chunk so the deriver can spot an attention BEL (\x07) in the stream.
const terminalActivityHandlers = new Map<string, (data: string, info?: { replay: true }) => void>();
// Parallel exit observer (one per id) for session status - separate from the
// single display exit handler, so both fire instead of clobbering each other.
const terminalActivityExitHandlers = new Map<string, () => void>();
ipcRenderer.on(
  'terminal:data',
  (_e, payload: { id: string; data: string; replaySize?: TerminalReplaySize }) => {
    terminalDataHandlers.get(payload.id)?.(payload.data, payload.replaySize);
    // An adopt replay (it carries `replaySize`) is history - the ring, old
    // status markers included - and is flagged so session status never
    // reads it as the program working now.
    const onActivity = terminalActivityHandlers.get(payload.id);
    if (payload.replaySize) onActivity?.(payload.data, { replay: true });
    else onActivity?.(payload.data);
  },
);
ipcRenderer.on('terminal:exit', (_e, payload: { id: string; exitCode: number }) => {
  terminalExitHandlers.get(payload.id)?.(payload.exitCode);
  terminalActivityExitHandlers.get(payload.id)?.();
});

// Language-server message/exit fan-out (see `api.lsp`): one handler per
// serverId, routed with a Map lookup like the terminal channels above.
const lspMessageHandlers = new Map<string, (message: unknown) => void>();
const lspExitHandlers = new Map<string, (code: number) => void>();
ipcRenderer.on('lsp:message', (_e, payload: { serverId: string; message: unknown }) => {
  lspMessageHandlers.get(payload.serverId)?.(payload.message);
});
ipcRenderer.on('lsp:exit', (_e, payload: { serverId: string; code: number }) => {
  lspExitHandlers.get(payload.serverId)?.(payload.code);
});

// Database change fan-out (see `api.db.onChange`): every collection subscribes,
// and one ipcRenderer listener per callback passed Node's 10-listener leak
// warning (11 collections, 2026-10-29) - one listener feeds them all instead.
const dbChangeSubscribers = new Set<(change: DbChange) => void>();
ipcRenderer.on('db:change', (_e, change: DbChange) => {
  for (const cb of dbChangeSubscribers) cb(change);
});

const api = {
  /** Open a native folder picker; resolves to the chosen path or null if cancelled. */
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:openDirectory'),
  /** Save text via the native save dialog (Settings → General → Export). */
  saveTextFile: (
    defaultName: string,
    content: string,
  ): Promise<{ path?: string; canceled?: true; error?: string }> =>
    ipcRenderer.invoke('dialog:saveFile', { defaultName, content }),
  /** Pick + read a JSON text file via the native open dialog (Import). */
  openTextFile: (): Promise<{ path?: string; content?: string; canceled?: true; error?: string }> =>
    ipcRenderer.invoke('dialog:openFile'),
  /** App version (package.json via app.getVersion), shown in Settings → General. */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  /** Settings → General → Open-source licences: the notices the build wrote, and Electron's own files. */
  notices: {
    list: (): Promise<NoticesAnswer | null> => ipcRenderer.invoke('notices:list'),
    /** Opens Electron's or Chromium's licence file in the system viewer; false when it is not there. */
    openPlatform: (which: PlatformLicense): Promise<boolean> =>
      ipcRenderer.invoke('notices:openPlatform', which),
  },
  /** Sync the native window appearance (title bar / traffic lights) with the app theme. */
  setNativeTheme: (theme: 'light' | 'dark'): void => ipcRenderer.send('native-theme', theme),
  /**
   * Workspace terminal tabs. The renderer owns the id; main spawns a real shell
   * (node-pty) and streams output back. `onData`/`onExit` return an unsubscribe.
   */
  terminal: {
    // Fire-and-forget on the same channel as input/resize/dispose so the main
    // process processes create → … → dispose in order (avoids a StrictMode
    // remount disposing a terminal after its re-create).
    create: (opts: TerminalCreateOptions): void => ipcRenderer.send('terminal:create', opts),
    write: (id: string, data: string): void => ipcRenderer.send('terminal:input', { id, data }),
    /**
     * `kind` (a remote host several apps share, spec 14): `claim` when the
     * user interacted, `passive` for a refit nobody asked for; absent = claim.
     */
    resize: (id: string, cols: number, rows: number, kind?: 'claim' | 'passive'): void =>
      ipcRenderer.send('terminal:resize', kind ? { id, cols, rows, kind } : { id, cols, rows }),
    dispose: (id: string): void => ipcRenderer.send('terminal:dispose', { id }),
    /** The terminal light/dark tone changed (or its first report): main nudges
     * every program that asked for colour-scheme notifications (DECSET 2031, e.g.
     * Claude Code under theme "auto") to re-detect, the one case xterm can't. */
    setTone: (dark: boolean): void => ipcRenderer.send('terminal:setTone', { dark }),
    /** Flow control: block/unblock the PTY while xterm catches up on writes. */
    pause: (id: string): void => ipcRenderer.send('terminal:pause', { id }),
    resume: (id: string): void => ipcRenderer.send('terminal:resume', { id }),
    onData: (
      id: string,
      cb: (data: string, replaySize?: TerminalReplaySize) => void,
    ): (() => void) => {
      terminalDataHandlers.set(id, cb);
      return () => {
        if (terminalDataHandlers.get(id) === cb) terminalDataHandlers.delete(id);
      };
    },
    /**
     * A terminal main moved off an older build's daemon: the tab starts it
     * again (a fresh create) - its agent resumes the conversation there.
     */
    onRelaunch: (cb: (id: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: { id: string }): void => cb(payload.id);
      ipcRenderer.on('terminal:relaunch', handler);
      return () => ipcRenderer.removeListener('terminal:relaunch', handler);
    },
    onExit: (id: string, cb: (exitCode: number) => void): (() => void) => {
      terminalExitHandlers.set(id, cb);
      return () => {
        if (terminalExitHandlers.get(id) === cb) terminalExitHandlers.delete(id);
      };
    },
    /** Fires whenever this terminal produces output, with the output chunk - for
     * deriving session activity status (and spotting an attention BEL), independent
     * of (and harmless to) the display data handler. `info.replay` marks an
     * adopt replay: the terminal's recent history, not new output. */
    onActivity: (id: string, cb: (data: string, info?: { replay: true }) => void): (() => void) => {
      terminalActivityHandlers.set(id, cb);
      return () => {
        if (terminalActivityHandlers.get(id) === cb) terminalActivityHandlers.delete(id);
      };
    },
    /** Fires when this terminal's shell exits - parallel to (and independent of)
     * the display exit handler, so deriving status never disturbs the display. */
    onActivityExit: (id: string, cb: () => void): (() => void) => {
      terminalActivityExitHandlers.set(id, cb);
      return () => {
        if (terminalActivityExitHandlers.get(id) === cb) terminalActivityExitHandlers.delete(id);
      };
    },
    /** Fires when any terminal owned by this window reports a title (OSC 0/2,
     * parsed in main/terminal-modes.ts) - the callback gets the terminal id and
     * the raw title. Not id-keyed like onData: the session auto-namer watches
     * every conversation shell at once, so it subscribes once and routes by id. */
    onTitleChange: (cb: (id: string, title: string) => void): (() => void) => {
      const listener = (_e: unknown, payload: { id: string; title: string }): void =>
        cb(payload.id, payload.title);
      ipcRenderer.on('terminal:title', listener);
      return () => {
        ipcRenderer.removeListener('terminal:title', listener);
      };
    },
    /**
     * Every input the terminal was given (commands, agent prompts, lines),
     * oldest first - asked once per terminal; later changes arrive through
     * `onInputs`. Empty for a terminal this window can't drive.
     */
    inputList: (id: string): Promise<InputEntry[]> =>
      ipcRenderer.invoke('terminal:inputList', { id }),
    // Dev servers (Pro, a private plan › M5): `serverList`, `onServers`.
    ...proPreload.terminalServers,
    /** A line entered into a program that reports nothing itself, read off
     * the screen at Enter; `ref` comes back on the entry main creates. */
    noteInput: (id: string, text: string, ref: number): void =>
      ipcRenderer.send('terminal:noteInput', { id, text, ref }),
    /** Fires when entries of any terminal this window owns are added or
     * changed (a command's exit status, a run ending) - routed by id. */
    onInputs: (cb: (id: string, entries: InputEntry[]) => void): (() => void) => {
      const listener = (_e: unknown, payload: { id: string; entries: InputEntry[] }): void =>
        cb(payload.id, payload.entries);
      ipcRenderer.on('terminal:inputs', listener);
      return () => {
        ipcRenderer.removeListener('terminal:inputs', listener);
      };
    },
    /**
     * The PTY's real grid, or null if this window can't drive that terminal.
     * Used to verify (and heal) the invariant that the xterm and its shell agree
     * on the size - a divergence is permanent and garbles every TUI frame, so it
     * is checked whenever a terminal is revealed or focused.
     */
    size: (id: string): Promise<{ cols: number; rows: number } | null> =>
      ipcRenderer.invoke('terminal:size', { id }),
    /** Whether a program is running in this terminal's foreground (not just the
     * idle shell prompt) - used to tell 'needs-input' from 'idle'. */
    foregroundBusy: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('terminal:foregroundBusy', { id }),
    /** Which of these terminals main launched through an agent adapter - their
     * program speaks the status-marker protocol from the start, so the renderer
     * skips the output/quiet heuristics for them (see observeSessionStatus). */
    markerDriven: (ids: string[]): Promise<string[]> =>
      ipcRenderer.invoke('terminal:markerDriven', { ids }),
    /** What each marker-driven terminal's agent is doing as main read it off
     * the stream - seeds the tab states of a renderer that starts observing
     * mid-turn (a reload, a tear-off). Terminals without the protocol are
     * left out. */
    agentStatus: (
      ids: string[],
    ): Promise<{ id: string; status: 'running' | 'needs-input' | 'idle' }[]> =>
      ipcRenderer.invoke('terminal:agentStatus', { ids }),
    /** The keys of a session's shells outside its layout (`commands:<sessionId>:*`)
     * that currently exist and are drivable by this window - a bottom panel uses
     * it to re-mount (adopt) a torn-off / returned session's running commands. */
    sessionCommandIds: (sessionId: string): Promise<string[]> =>
      ipcRenderer.invoke('terminal:sessionCommandIds', { sessionId }),
    /**
     * This window dropped its xterm for a shell it still owns (a hidden session
     * evicted from the mounted cache) and will re-attach with a fresh one later:
     * ask main to replay the scrollback on the next `create` for this id.
     */
    requestReplay: (id: string): void => ipcRenderer.send('terminal:requestReplay', { id }),
    /**
     * A terminal's remote host dropped (a private plan ›
     * 9.4): the shell runs on there; the tab keeps its last screen under an
     * overlay. Never an exit.
     */
    onUnreachable: (
      cb: (payload: { id: string; hostId: string; since: number }) => void,
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        payload: { id: string; hostId: string; since: number },
      ): void => cb(payload);
      ipcRenderer.on('terminal:unreachable', handler);
      return () => ipcRenderer.removeListener('terminal:unreachable', handler);
    },
    /** The host is back: rebuild the tab's xterm, whose next create replays what it missed. */
    onReachable: (cb: (id: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: { id: string }): void => cb(payload.id);
      ipcRenderer.on('terminal:reachable', handler);
      return () => ipcRenderer.removeListener('terminal:reachable', handler);
    },
    /**
     * The grid a terminal shared with another computer runs at (a remote
     * host, spec 14): `own: false` = the other computer's claim set it - fit
     * the xterm to it and never resize the pty back; `own: true` = ours again.
     */
    onGrid: (
      cb: (grid: { id: string; cols: number; rows: number; own: boolean }) => void,
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        payload: { id: string; cols: number; rows: number; own: boolean },
      ): void => cb(payload);
      ipcRenderer.on('terminal:grid', handler);
      return () => ipcRenderer.removeListener('terminal:grid', handler);
    },
  },
  /** Cross-window tab transfer (tear-off / merge). */
  tab: {
    /**
     * Released a tab outside this window; main routes it by the cursor's screen
     * point. `newWindow` skips that routing and always opens a fresh window -
     * for menu-triggered tear-offs, where the cursor never left this window.
     */
    dropExternal: (descriptor: TabDescriptor, opts?: { newWindow?: boolean }): void =>
      ipcRenderer.send('tab:dropExternal', { descriptor, newWindow: opts?.newWindow === true }),
    /**
     * While dragging a tab over another window (mid-tear-off), ping main so it can
     * draw a live drop preview in the window under the cursor. Main reads the
     * cursor's screen point itself; we only pass the descriptor.
     */
    dragOver: (descriptor: TabDescriptor): void => ipcRenderer.send('tab:dragOver', { descriptor }),
    /** The cross-window drag ended (released or re-entered the source window). */
    dragEnd: (): void => ipcRenderer.send('tab:dragEnd'),
    /**
     * A detached tab window reports its live layout so main can hand its
     * terminals back to the app window when this window closes.
     */
    syncLayout: (layout: unknown): void => ipcRenderer.send('tab:syncLayout', { layout }),
    /**
     * This window should insert an incoming tab at the given client point.
     * `transferId` correlates the required ack - reply via `insertExternalResult`
     * whether the tab was actually inserted; main only removes the origin's tab
     * on a positive ack (and rolls the transfer back otherwise).
     */
    onInsertExternal: (
      cb: (descriptor: TabDescriptor, clientX: number, clientY: number, transferId: string) => void,
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        payload: {
          descriptor: TabDescriptor;
          clientX: number;
          clientY: number;
          transferId: string;
        },
      ): void => cb(payload.descriptor, payload.clientX, payload.clientY, payload.transferId);
      ipcRenderer.on('tab:insertExternal', handler);
      return () => ipcRenderer.removeListener('tab:insertExternal', handler);
    },
    /** Ack for `onInsertExternal`: whether this window actually took the tab. */
    insertExternalResult: (transferId: string, accepted: boolean): void =>
      ipcRenderer.send('tab:insertExternalResult', { transferId, accepted }),
    /** A tab of this window moved out; drop it (without killing its shell). */
    onRemoved: (cb: (termId: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: { termId: string }): void =>
        cb(payload.termId);
      ipcRenderer.on('tab:removed', handler);
      return () => ipcRenderer.removeListener('tab:removed', handler);
    },
    /**
     * A tab from another window is being dragged over this one: show a live drop
     * preview at the given client point (cleared by `onDragPreviewEnd`).
     */
    onDragPreview: (
      cb: (descriptor: TabDescriptor, clientX: number, clientY: number) => void,
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        payload: { descriptor: TabDescriptor; clientX: number; clientY: number },
      ): void => cb(payload.descriptor, payload.clientX, payload.clientY);
      ipcRenderer.on('tab:dragPreview', handler);
      return () => ipcRenderer.removeListener('tab:dragPreview', handler);
    },
    /** The cross-window drag left this window (or ended); clear its drop preview. */
    onDragPreviewEnd: (cb: () => void): (() => void) => {
      const handler = (): void => cb();
      ipcRenderer.on('tab:dragPreviewEnd', handler);
      return () => ipcRenderer.removeListener('tab:dragPreviewEnd', handler);
    },
    /** Main's reply to `dragOver`: whether the cursor is over another window. */
    onDragOverAck: (cb: (overWindow: boolean) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: { overWindow: boolean }): void =>
        cb(payload.overWindow);
      ipcRenderer.on('tab:dragOverAck', handler);
      return () => ipcRenderer.removeListener('tab:dragOverAck', handler);
    },
  },
  /** Cross-window session transfer (tear a whole session into its own window). */
  session: {
    /** Released a session outside this window; main opens a window for it. */
    dropExternal: (descriptor: SessionDescriptor): void =>
      ipcRenderer.send('session:dropExternal', { descriptor }),
    /** A session of this window moved out; release it (keep its shells alive). */
    onRemoved: (cb: (sessionId: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: { sessionId: string }): void =>
        cb(payload.sessionId);
      ipcRenderer.on('session:removed', handler);
      return () => ipcRenderer.removeListener('session:removed', handler);
    },
    /**
     * A detached session window streams its live layout to main on every change,
     * so when it closes main can hand the up-to-date session back to the app.
     * `layout` is the renderer's serialized WorkspaceLayout (opaque at this boundary).
     */
    syncLayout: (sessionId: string, layout: unknown): void =>
      ipcRenderer.send('session:syncLayout', { sessionId, layout }),
    /** A torn-off session's window closed; take it (and its shells) back into the app. */
    onReturnToList: (cb: (sessionId: string, layout: unknown) => void): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        payload: { sessionId: string; layout: unknown },
      ): void => cb(payload.sessionId, payload.layout);
      ipcRenderer.on('session:returnToList', handler);
      return () => ipcRenderer.removeListener('session:returnToList', handler);
    },
    /** Raise the window hosting a torn-off session (may be on another Space/monitor). */
    focusWindow: (sessionId: string): void =>
      ipcRenderer.send('session:focusWindow', { sessionId }),
    /** Ask main to close a session's window, returning the session to the app. */
    bringBack: (sessionId: string): void => ipcRenderer.send('session:bringBack', { sessionId }),
    /** A session was deleted while open in its own window: close it and kill its shells. */
    destroy: (sessionId: string): void => ipcRenderer.send('session:destroy', { sessionId }),
    /**
     * Whether THIS window holds the session-cleanup lease: the hourly
     * auto-archive / auto-delete sweep runs only where this resolves true
     * (the main window - window-ownership.ts), so two full-chrome windows can
     * never both delete a worktree.
     */
    sweepLease: (): Promise<boolean> => ipcRenderer.invoke('session:sweepLease'),
  },
  /** Project windows: a whole project in its own window (a private plan). */
  project: {
    /** Open a project in its own window; main releases it from this one. */
    openInWindow: (descriptor: ProjectDescriptor): void =>
      ipcRenderer.send('project:dropExternal', { descriptor }),
    /** A project of this window moved out; release its sessions (keep their shells alive). */
    onRemoved: (cb: (projectId: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: { projectId: string }): void =>
        cb(payload.projectId);
      ipcRenderer.on('project:removed', handler);
      return () => ipcRenderer.removeListener('project:removed', handler);
    },
    /**
     * A project window streams the live layout of each session it has open, so
     * closing it hands every session back with its current tabs/splits.
     */
    syncLayout: (sessionId: string, layout: unknown): void =>
      ipcRenderer.send('project:syncLayout', { sessionId, layout }),
    /** A project's window closed; take it (and its sessions' shells) back into this window. */
    onReturnToList: (
      cb: (projectId: string, sessions: Array<{ sessionId: string; layout: unknown }>) => void,
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        payload: { projectId: string; sessions: Array<{ sessionId: string; layout: unknown }> },
      ): void => cb(payload.projectId, payload.sessions);
      ipcRenderer.on('project:returnToList', handler);
      return () => ipcRenderer.removeListener('project:returnToList', handler);
    },
    /** Raise the window hosting a project. */
    focusWindow: (projectId: string): void =>
      ipcRenderer.send('project:focusWindow', { projectId }),
    /** Ask main to close a project's window, returning the project to the main window. */
    bringBack: (projectId: string): void => ipcRenderer.send('project:bringBack', { projectId }),
    /** A project was deleted while open in its own window: close it and kill its shells. */
    destroy: (projectId: string): void => ipcRenderer.send('project:destroy', { projectId }),
    /**
     * From a project window: show a project in the MAIN window, or (null) its
     * New project dialog - with the machine `hostId` preselected when given.
     */
    openInMain: (projectId: string | null, hostId?: string | null): void =>
      ipcRenderer.send('project:openInMain', hostId ? { projectId, hostId } : { projectId }),
    /** The main window is asked to show a project (null = its New project dialog). */
    onNavigate: (cb: (projectId: string | null, hostId: string | null) => void): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        payload: { projectId: string | null; hostId?: string },
      ): void => cb(payload.projectId, payload.hostId ?? null);
      ipcRenderer.on('project:navigate', handler);
      return () => ipcRenderer.removeListener('project:navigate', handler);
    },
  },
  window: {
    /** One-shot bootstrap payload for a freshly-created window (read-and-clear). */
    getInitialPayload: (): Promise<InitialPayload> =>
      ipcRenderer.invoke('window:getInitialPayload'),
    /** What lives in other windows right now (authoritative, from main). */
    listExternal: (): Promise<ExternalWindows> => ipcRenderer.invoke('window:listExternal'),
    /** Fires whenever the set of sessions/projects hosted by other windows changes. */
    onExternalChanged: (cb: (external: ExternalWindows) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: ExternalWindows): void => cb(payload);
      ipcRenderer.on('window:externalChanged', handler);
      return () => ipcRenderer.removeListener('window:externalChanged', handler);
    },
  },
  /**
   * What the app's header needs to stand in for the OS title bar
   * (main/window-chrome.ts): the platform (traffic lights on the left vs the
   * controls overlay on the right), the DEV badge, and full screen (macOS
   * hides the traffic lights there, so their room goes too).
   */
  windowChrome: {
    platform: (): NodeJS.Platform => process.platform,
    isLocal: (): boolean => process.argv.includes(LOCAL_ENV_ARG),
    /** The seeded marketing instance: no traffic lights, so no room for them. */
    isDemo: (): boolean => process.argv.includes(DEMO_ARG),
    /** Latest state main reported - kept from preload load, before the page subscribes. */
    isFullScreen: (): boolean => fullScreen,
    onFullScreenChange: (cb: (fullScreen: boolean) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, value: boolean): void => cb(value);
      ipcRenderer.on('window:fullScreen', handler);
      return () => ipcRenderer.removeListener('window:fullScreen', handler);
    },
  },
  /** OS power/session events forwarded from main (see src/main/index.ts). */
  system: {
    /**
     * Fires when the machine wakes from sleep or the screen unlocks. The terminal
     * layer re-cycles its renderers then: a GPU reset across sleep can strand
     * xterm's WebGL canvas painting solid black (see terminal-pool.ts).
     */
    onResume: (cb: () => void): (() => void) => {
      const handler = (): void => cb();
      ipcRenderer.on('system:resume', handler);
      return () => ipcRenderer.removeListener('system:resume', handler);
    },
  },
  /**
   * Per-session workspace layout persistence (split tree + open terminal tabs and
   * their placement). Read once on launch to restore each session's tabs/splits;
   * saved (fire-and-forget) whenever a session's layout changes. The `layout` blob
   * is the renderer's serialized WorkspaceLayout, opaque at this boundary.
   */
  layout: {
    list: (): Promise<{ sessionId: string; layout: unknown }[]> =>
      ipcRenderer.invoke('layout:list'),
    save: (sessionId: string, layout: unknown): void => {
      void ipcRenderer.invoke('layout:save', { sessionId, layout });
    },
  },
  /**
   * Filesystem access for the workspace file explorer + editor, rooted at a
   * session's project directory. Every call resolves to a result object (never
   * rejects), so callers branch on `error` instead of catching. Error results
   * also carry a stable machine `code` (Node errno like 'ENOENT'/'EACCES', or
   * the app-level 'TOO_LARGE' | 'BINARY' | 'CONFLICT'), so callers shouldn't
   * need to match message substrings.
   */
  fs: {
    /** `dirsOnly` drops file entries; `markRepos` sets `isRepo` on directories
     * that are a git checkout of their own (both used by the folder picker). */
    readDir: (
      path: string,
      opts?: { dirsOnly?: boolean; markRepos?: boolean },
    ): Promise<{ entries?: DirEntry[]; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:readDir', { path, ...opts }),
    /** On success also returns the file's `mtimeMs` - pass it back to `writeFile`
     * as `expectedMtimeMs` to detect the file changing on disk in between. */
    readFile: (
      path: string,
    ): Promise<{ content?: string; mtimeMs?: number; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:readFile', { path }),
    /**
     * A text file on a named host, wherever it lies there (plan 29 spec › 14):
     * a language server's jump into the host's own library folders, which no
     * project root covers. Opened read-only.
     */
    readFileOnHost: (
      hostId: string,
      path: string,
    ): Promise<{ content?: string; mtimeMs?: number; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:readFileOnHost', { hostId, path }),
    /** Read a file's raw bytes (the image viewer) - no size/encoding checks
     * beyond a 32 MB cap; the Buffer arrives as a Uint8Array. */
    readFileBinary: (
      path: string,
    ): Promise<{ bytes?: Uint8Array; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:readFileBinary', { path }),
    /**
     * Atomically overwrite a file. If `expectedMtimeMs` (from `readFile` or a
     * previous save) is given and the file changed on disk since, fails with
     * `code: 'CONFLICT'` without writing. On success returns the new `mtimeMs`.
     */
    writeFile: (
      path: string,
      content: string,
      expectedMtimeMs?: number,
    ): Promise<{ ok?: true; mtimeMs?: number; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:writeFile', { path, content, expectedMtimeMs }),
    createFile: (
      path: string,
    ): Promise<{ ok?: true; path?: string; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:createFile', { path }),
    createDir: (
      path: string,
    ): Promise<{ ok?: true; path?: string; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:createDir', { path }),
    rename: (
      from: string,
      to: string,
    ): Promise<{ ok?: true; path?: string; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:rename', { from, to }),
    delete: (path: string): Promise<{ ok?: true; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:delete', { path }),
    /** Open the OS file manager on the folder holding `path`, the item selected. */
    showInFolder: (path: string): Promise<{ ok?: true; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:showInFolder', { path }),
    /** Start a recursive watch on a directory (ref-counted per window + root). */
    /**
     * `mode` is `poll` when a remote host watches the tree by polling (a Linux
     * host past its inotify budget - the explorer says "polling (large tree)").
     */
    watch: (
      root: string,
    ): Promise<{ ok?: true; mode?: 'native' | 'poll'; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:watch', { root }),
    /** Release a watch started with `watch`. */
    unwatch: (root: string): Promise<{ ok?: true; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:unwatch', { root }),
    /**
     * Subscribe to debounced change bursts from watched directories. `mode`
     * rides along when a remote watch switched strategy (to polling).
     */
    onChanged: (
      cb: (root: string, paths: string[], mode?: 'native' | 'poll') => void,
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        payload: { root: string; paths: string[]; mode?: 'native' | 'poll' },
      ): void => cb(payload.root, payload.paths, payload.mode);
      ipcRenderer.on('fs:changed', handler);
      return () => ipcRenderer.removeListener('fs:changed', handler);
    },
    /**
     * Copy files and folders from this computer (absolute local paths, from
     * `files.pathOf` on a drop) into `destDir` - on this machine, or uploaded
     * to a host (plan 29 spec › 9.3). `onClash: 'ask'` answers `{ clash }`
     * without writing anything when a name is taken; call again with the
     * user's choice. Progress arrives through `onUploadProgress`.
     */
    upload: (args: {
      uploadId: string;
      paths: string[];
      destDir: string;
      onClash: 'ask' | 'replace' | 'skip' | 'keep-both';
    }): Promise<UploadAnswer> => ipcRenderer.invoke('fs:upload', args),
    /** Stop an upload: files in flight are dropped, files already in place stay. */
    uploadCancel: (uploadId: string): Promise<{ ok?: boolean; error?: string; code?: string }> =>
      ipcRenderer.invoke('fs:uploadCancel', { uploadId }),
    onUploadProgress: (cb: (p: { uploadId: string } & UploadProgress) => void): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        payload: { uploadId: string } & UploadProgress,
      ): void => cb(payload);
      ipcRenderer.on('fs:uploadProgress', handler);
      return () => ipcRenderer.removeListener('fs:uploadProgress', handler);
    },
  },
  /**
   * Files dropped onto the window (plan 29 spec › 9.3): the renderer never
   * reads their bytes - it hands main their paths, and main reads them.
   */
  files: {
    /** The local path of a dropped `File` ('' for one that has none). */
    pathOf: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    /** This computer's `<os>-<arch>`, spelled as a host's facts spell it. */
    thisMachine: (): string => `${process.platform}-${process.arch}`,
  },
  /**
   * Language-server bridge for the Monaco editor (see src/main/language-servers.ts).
   * Main frames stdio and forwards parsed LSP JSON both ways; the renderer's
   * MonacoLanguageClient owns the protocol. Message/exit delivery uses the same
   * one-listener-per-channel fan-out as the terminal bridge - one Map lookup
   * per message instead of a predicate per server.
   */
  lsp: {
    start: (
      language: string,
      root: string,
    ): Promise<{ serverId?: string; error?: string; code?: string }> =>
      ipcRenderer.invoke('lsp:start', { language, root }),
    /** Fire-and-forget: correlation ids live inside the LSP messages. */
    send: (serverId: string, message: unknown): void => {
      ipcRenderer.send('lsp:send', { serverId, message });
    },
    stop: (serverId: string): void => {
      ipcRenderer.send('lsp:stop', { serverId });
    },
    onMessage: (serverId: string, cb: (message: unknown) => void): (() => void) => {
      lspMessageHandlers.set(serverId, cb);
      return () => {
        if (lspMessageHandlers.get(serverId) === cb) lspMessageHandlers.delete(serverId);
      };
    },
    onExit: (serverId: string, cb: (code: number) => void): (() => void) => {
      lspExitHandlers.set(serverId, cb);
      return () => {
        if (lspExitHandlers.get(serverId) === cb) lspExitHandlers.delete(serverId);
      };
    },
  },
  /**
   * Language-server registry + installer (see language-server-install.ts):
   * statuses for Settings → Languages and the editor's install banner, and
   * the install/uninstall actions. Progress arrives on a single subscription
   * (`onProgress`) while an install runs.
   */
  ls: {
    /** One machine's servers: this computer, or a connected host (plan 29 › M9). */
    list: (
      hostId?: string | null,
    ): Promise<{ languages?: LanguageServerStatus[]; error?: string; code?: string }> =>
      ipcRenderer.invoke('ls:list', hostId ? { hostId } : {}),
    install: (
      languageId: string,
      hostId?: string | null,
    ): Promise<{ ok?: true; error?: string; code?: string }> =>
      ipcRenderer.invoke('ls:install', { languageId, ...(hostId ? { hostId } : {}) }),
    uninstall: (
      languageId: string,
      hostId?: string | null,
    ): Promise<{ ok?: true; error?: string; code?: string }> =>
      ipcRenderer.invoke('ls:uninstall', { languageId, ...(hostId ? { hostId } : {}) }),
    onProgress: (cb: (p: LanguageServerInstallProgress) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, payload: LanguageServerInstallProgress): void =>
        cb(payload);
      ipcRenderer.on('ls:progress', handler);
      return () => ipcRenderer.removeListener('ls:progress', handler);
    },
  },
  /**
   * Settings › Sessions › After quit (a private plan): the
   * "Keep sessions running after quit" switch, mirrored into main on boot and
   * on every change so the quit sequence knows it; and "Stop all sessions",
   * which ends every live terminal now (tabs stay open and show the exit).
   */
  sessions: {
    setKeepRunning: (value: boolean): Promise<void> =>
      ipcRenderer.invoke('sessions:setKeepRunning', value),
    /**
     * Stop every terminal on one machine: null / absent = this one, a host id
     * = that remote host (plan 28 › spec 16 - Stop all is per host).
     */
    stopAll: (hostId?: string | null): Promise<boolean> =>
      ipcRenderer.invoke('sessions:stopAll', hostId ?? null),
    /**
     * The once-ever "sessions kept running while double0 was closed" notice:
     * the terminals the daemon kept across the last quit, or null - shown
     * before on this machine, nothing kept, or not the main window asking.
     * Answering spends it: main flips the flag as it replies.
     */
    launchNotice: (): Promise<{ terminalIds: string[] } | null> =>
      ipcRenderer.invoke('sessions:launchNotice'),
    /** This machine's session daemons, current build first, with how many terminals each holds and how many are busy. */
    daemons: (): Promise<SessionDaemonRow[]> => ipcRenderer.invoke('sessions:daemons'),
    /**
     * Move an older daemon's terminals onto this build's. Busy tabs, and idle
     * agents whose conversation cannot resume, only once `confirmed`; until
     * then such a daemon answers `{ moved: 0, busy, unresumable }` so the
     * caller can ask. Null for an unknown or the current daemon.
     */
    moveDaemon: (
      socketPath: string,
      confirmed = false,
    ): Promise<{ moved: number; busy: number; unresumable: number; kept: number } | null> =>
      ipcRenderer.invoke('sessions:moveDaemon', socketPath, confirmed),
  },
  /**
   * Git bridge for the workspace's git surfaces (see src/main/git.ts). Runs
   * the user's `git` CLI in the project directory. Reads resolve typed payloads;
   * every call resolves to a result object (never rejects) - branch on `error`.
   */
  git: {
    ...proPreload.gitClient,
    status: (cwd: string): Promise<{ status?: GitStatus; error?: string; code?: string }> =>
      ipcRenderer.invoke('git:status', { cwd }),
    /** Root of the repo containing `cwd`; `root: null` when it's in no repo. */
    repoRoot: (cwd: string): Promise<{ root?: string | null; error?: string; code?: string }> =>
      ipcRenderer.invoke('git:repoRoot', { cwd }),
    /** The checkouts directly under `cwd` when `cwd` is in no repo (a
     * folder-of-repos project); empty inside a repo. */
    childRepos: (
      cwd: string,
    ): Promise<{ repos?: { name: string; path: string }[]; error?: string; code?: string }> =>
      ipcRenderer.invoke('git:childRepos', { cwd }),
    /** Added/removed line counts of a session's uncommitted work (worktree vs
     * HEAD, staged included - same basis as the session-changes drawer).
     * Untracked files don't count. */
    sessionStats: (
      cwd: string,
    ): Promise<{ stats?: { add: number; del: number }; error?: string; code?: string }> =>
      ipcRenderer.invoke('git:sessionStats', { cwd }),
    refs: (cwd: string): Promise<{ refs?: GitRefs; error?: string; code?: string }> =>
      ipcRenderer.invoke('git:refs', { cwd }),
    /** Index version of a file (editor-gutter diff base). `content: null` = not
     * in the index (untracked) - i.e. every line is new. */
    show: (
      cwd: string,
      path: string,
    ): Promise<{ content?: string | null; binary?: boolean; error?: string; code?: string }> =>
      ipcRenderer.invoke('git:show', { cwd, path }),
    /** Create a branch from `from` (a commit sha) or HEAD; `checkout` also switches to it. */
    createBranch: (
      cwd: string,
      name: string,
      checkout: boolean,
      from?: string,
    ): Promise<{ ok?: true; error?: string }> =>
      ipcRenderer.invoke('git:createBranch', { cwd, name, checkout, from }),
    /** Delete a local branch (`force` = -D for unmerged branches). */
    deleteBranch: (
      cwd: string,
      name: string,
      force: boolean,
    ): Promise<{ ok?: true; error?: string }> =>
      ipcRenderer.invoke('git:deleteBranch', { cwd, name, force }),
    /** Create a git worktree at `path` on a new branch `branch` (off current HEAD). */
    worktreeAdd: (
      cwd: string,
      path: string,
      branch?: string,
    ): Promise<{ ok?: true; error?: string; code?: string }> =>
      ipcRenderer.invoke('git:worktreeAdd', { cwd, path, branch }),
    /** Remove the worktree at `path` (resolved against the main worktree); `force` for a dirty tree. */
    worktreeRemove: (
      cwd: string,
      path: string,
      force?: boolean,
    ): Promise<{ ok?: true; error?: string; code?: string }> =>
      ipcRenderer.invoke('git:worktreeRemove', { cwd, path, force }),
    /** Everything git ignores in the checkout containing `cwd` (from its
     * .gitignore files), relative to the repo root - folders with a trailing
     * slash, the ones the app never copies marked `locked`. `sizes` adds folder
     * sizes (a `du` per folder - slow on a big tree). `root: null` outside a repo. */
    ignoredEntries: (
      cwd: string,
      opts?: { sizes?: boolean; fileSizes?: boolean },
    ): Promise<{
      root?: string | null;
      entries?: GitIgnoredEntry[];
      error?: string;
      code?: string;
    }> =>
      ipcRenderer.invoke('git:ignoredEntries', {
        cwd,
        sizes: opts?.sizes === true,
        ...(opts?.fileSizes ? { fileSizes: true } : {}),
      }),
    /** Copy `paths` (repo-relative, as listed by ignoredEntries) from the checkout
     * at `repoRoot` into the worktree at `worktreePath`, same relative paths.
     * Best-effort per path - see `skipped`/`errors`; never rejects. */
    worktreeSeed: (
      repoRoot: string,
      worktreePath: string,
      paths: string[],
    ): Promise<{
      copied?: string[];
      skipped?: string[];
      errors?: { path: string; message: string }[];
      error?: string;
      code?: string;
    }> => ipcRenderer.invoke('git:worktreeSeed', { repoRoot, worktreePath, paths }),
    /**
     * Copy `paths` (repo-relative, ticked in New Session) from THIS computer's
     * checkout at `sourceRoot` into a new worktree on a host - 0600, build
     * output refused across platforms (plan 29 spec › 9.2). Never rejects.
     */
    seedFromLocal: (
      sourceRoot: string,
      worktreePath: string,
      paths: string[],
    ): Promise<{
      copied?: string[];
      skipped?: string[];
      errors?: { path: string; message: string }[];
      error?: string;
      code?: string;
    }> => ipcRenderer.invoke('git:seedFromLocal', { sourceRoot, worktreePath, paths }),
    /** Watch the repo's git dir (ref-counted); fires `git:changed` on commits/stages/checkouts. */
    watch: (root: string): Promise<{ ok?: true; error?: string; code?: string }> =>
      ipcRenderer.invoke('git:watch', { root }),
    unwatch: (root: string): Promise<{ ok?: true; error?: string }> =>
      ipcRenderer.invoke('git:unwatch', { root }),
    /** `kind` scopes the refresh: 'status' = only the working tree / index
     * moved; 'history' = refs or HEAD may have moved too. */
    onChanged: (cb: (root: string, kind: GitChangeKind) => void): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        payload: { root: string; kind?: GitChangeKind },
      ): void => cb(payload.root, payload.kind ?? 'history');
      ipcRenderer.on('git:changed', handler);
      return () => ipcRenderer.removeListener('git:changed', handler);
    },
  },
  /** Local embedded database (PGlite in main). Replaces the Electric read path. */
  db: {
    list: (table: string): Promise<unknown[]> => ipcRenderer.invoke('db:list', { table }),
    insert: (table: string, row: unknown): Promise<unknown> =>
      ipcRenderer.invoke('db:insert', { table, row }),
    update: (table: string, id: string, patch: unknown): Promise<unknown> =>
      ipcRenderer.invoke('db:update', { table, id, patch }),
    remove: (table: string, id: string): Promise<unknown> =>
      ipcRenderer.invoke('db:delete', { table, id }),
    onChange: (cb: (change: DbChange) => void): (() => void) => {
      dbChangeSubscribers.add(cb);
      return () => dbChangeSubscribers.delete(cb);
    },
  },
  /**
   * Cross-project file index for the Search Everywhere palette. One call returns
   * the (TTL-cached, main-side) flat list of files across every project; the
   * renderer fuzzy-ranks it locally. Resolves to a result object - branch on `error`.
   */
  search: {
    /**
     * `pending`: hosts whose project walk is running (the list lands later,
     * `onIndexChanged` says when); `unreachable`: hosts not connected, whose
     * last list is included (`stale`) - plan 29 spec › 5.
     */
    listFiles: (): Promise<{
      files?: SearchFileEntry[];
      pending?: string[];
      unreachable?: string[];
      error?: string;
    }> => ipcRenderer.invoke('search:listFiles'),
    /** A host's index landed - ask `listFiles` again while the palette is open. */
    onIndexChanged: (cb: () => void): (() => void) => {
      const handler = (): void => cb();
      ipcRenderer.on('search:indexChanged', handler);
      return () => ipcRenderer.removeListener('search:indexChanged', handler);
    },
  },
  /**
   * Installed external IDEs (see src/main/editors.ts). `list` returns the subset
   * of known editors detected on this machine (empty off-macOS); `open` launches
   * one on a folder (a session's worktree, or its project folder) in a new window.
   */
  editors: {
    list: (): Promise<{ editors: { id: string; name: string }[] }> =>
      ipcRenderer.invoke('editors:list'),
    open: (editorId: string, path: string): Promise<{ ok?: true; error?: string }> =>
      ipcRenderer.invoke('editors:open', { editorId, path }),
  },
  /**
   * Browser tabs (a private plan, src/main/browser/). Every
   * call names the tab's guest webContents id (`webview.getWebContentsId()`);
   * main only acts on guests attached to this window.
   */
  browser: {
    /** A workspace file inside `root` as a URL a browser tab can load. */
    previewUrl: (root: string, file: string): Promise<string | null> =>
      ipcRenderer.invoke('browser:previewUrl', { root, file }),
    // Browser tabs (Pro, a private plan › M5): DevTools, emulation, zoom,
    // screenshots, picks, the agent's requests.
    ...proPreload.browserTabs,
  },
  // Pro's bridges (a private plan): none in the core
  // build, so `DesktopApi` carries only core's channels there.
  ...proPreload.bridges,
};

// Expose ONLY the curated `api` surface. The raw `@electron-toolkit/preload`
// electronAPI (arbitrary-channel ipcRenderer + process.env) is deliberately not
// exposed - it would hand any renderer compromise the master key.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api;
}

export type DesktopApi = typeof api;
