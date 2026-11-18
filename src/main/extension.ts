import type { BrowserWindow, WebContents } from 'electron';
import type { FeatureRegistrar, IpcRegistrar } from './pro-ipc';
import type { RemoteHostsContext, RemoteHostsStarted } from './remote-hosts';
import type { RuntimeSessionsContext, RuntimeSessionsStarted } from './runtime-sessions';
import type { ProtocolExtension } from './daemon/protocol';
import type { AttachedDaemon } from './daemon/extension-channel';
import type { RemoteHosts } from './remote-hosts';
import type { DeleteCascade } from './db/delete-cascade';
import type { TableDef } from './db/row-schemas';
import type { AgentStatusLine } from './launch-materialize';

/**
 * The main process's Pro slot (a private plan ›
 * Extension points). `main/index.ts` is the only core file that imports
 * `@pro/main`; everything Pro does in main goes through what this type lets
 * it reach. It grows milestone by milestone - a field is added when the
 * first feature that moves needs it, never ahead.
 */
export type Edition = 'pro' | 'core';

/**
 * A feature as the extension's entitlements name it - its own vocabulary;
 * core only passes the name back (`entitled`, `ipcFor`, `gate`).
 */
export type Feature = string;

/** The phases of "Restart to update" (core's quit plumbing owns the flags). */
export type RestartPhase = 'start' | 'aborted' | 'failed';

/** What Pro may reach at module load, before `app.whenReady`. */
export type BootContext = {
  /** The last focused window, for flows the extension parents to one. */
  focusedWindow: () => BrowserWindow | null;
};

export type MainContext = {
  userData: string;
  appVersion: string;
  /** The IPC registrar for one feature: its handlers answer ELOCKED while it is not entitled. */
  ipcFor: (feature: Feature) => FeatureRegistrar;
  /**
   * The platform a REMOTE folder's commands run on (its host's), null for this
   * machine's - a command detector picks `npm` vs `npm.cmd` by it.
   */
  hostPlatformOf: (root: string) => NodeJS.Platform | null;
  /** Every live app window. */
  windows: () => Iterable<BrowserWindow>;
  /** The main app window, if open. */
  mainWindow: () => BrowserWindow | null;
  /**
   * A restart to install an update is a quit: core's quit plumbing confirms
   * it (busy sessions) and tracks its phases.
   */
  restart: {
    confirm: () => Promise<boolean>;
    onPhase: (phase: RestartPhase) => void;
  };
  /**
   * Restart the app with every session on this machine stopped - for a flow
   * that changes what the app opens with. Asks first while something is busy
   * (the "Quit and Stop All Sessions" confirm). True once the quit started;
   * false when they cancelled or a quit is already under way. Unsaved
   * editor changes are DISCARDED - every window closes over them (the caller
   * tells the user so); a window's "Discard unsaved changes?" would
   * otherwise call the restart off. `beforeRelaunch` runs only when the quit
   * can no longer be called off (from `will-quit`); if something else calls
   * it off, `onAborted` runs and nothing else does.
   */
  restartStoppingSessions: (beforeRelaunch: () => void, onAborted?: () => void) => Promise<boolean>;
};

export type MainRegistration = {
  /** Called from `will-quit`'s disposer, beside the core modules' own. */
  dispose?(): void;
  /** A window closed or reloaded: drop what it held (feeds, watchers). */
  forgetWindow?(wcId: number): void;
};

export type MainExtension = {
  edition: Edition;
  /**
   * At module load: before `app.whenReady` and before any window exists. A
   * `whenReady` callback registered here runs ahead of main's own.
   */
  boot?(ctx: BootContext): void;
  /**
   * Crash reporting, at module load right after user-data.ts moved the data
   * folder: before `protocol.registerSchemesAsPrivileged` (the SDK registers
   * its own scheme and proxies that call) and before `app.whenReady`. Absent
   * in the core build - it reports nothing anywhere.
   */
  startCrashReporting?(): void;
  /**
   * At module load, once this instance holds the single-instance lock and
   * right before the database worker starts - before anything opens a file
   * under userData (Chromium's profile opens at `ready`). Synchronous.
   */
  beforeDataOpens?(userData: string): void;
  /**
   * A link on the app's scheme arrived (open-url, a second launch's argv, the
   * cold-start argv). Core has already focused the app; the extension takes
   * what it understands. Returns whether it took the link.
   */
  handleDeepLink?(url: string, window: BrowserWindow | null): boolean;
  /**
   * The extension's tables on the generic DB bridge (main/db/row-schemas.ts ›
   * registerTables) and its part of every delete's cascade (db/ipc.ts). They
   * live in the one migration history; the public export drops them from it.
   */
  db?: { tables: Record<string, TableDef>; cascade?: DeleteCascade };
  /** Whether a feature may run now. */
  entitled(feature: Feature): boolean;
  /**
   * Terminal ids that start the extension's work, by id prefix and the
   * feature they need: a new one is refused while that feature is not
   * entitled - a renderer cannot start the work by naming the id.
   */
  terminalFeatures?: readonly (readonly [prefix: string, feature: Feature])[];
  /** Synchronous - runs inside `app.whenReady` before any renderer message (boot-order rule). */
  register(ctx: MainContext): MainRegistration;
  /**
   * The remote hosts (M7): started where main builds its terminal backend,
   * before the terminal IPC. Absent = every terminal is this machine's.
   */
  remoteHosts?(ctx: RemoteHostsContext): RemoteHostsStarted;
  /**
   * The runtime sessions (agents outside a terminal): started right after the
   * terminal IPC, over the backend and hosts above. Absent = none runs in this build.
   */
  runtimeSessions?(ctx: RuntimeSessionsContext): RuntimeSessionsStarted;
  /**
   * The agents' status line on this machine (launch-materialize.ts ›
   * AgentStatusLine: Claude Code's `statusLine` command and a capture file per
   * tab) and whatever reads the captures - started right before the terminal
   * IPC. Absent = no status line is injected (the user's own stays) and no
   * capture is made.
   */
  statusLine?(ctx: StatusLineContext): StatusLineStarted;
  /** Its ops, casts and events on the session daemon's wire - registered before the backends start. */
  daemonProtocol?: ProtocolExtension;
  /** Its own flags on the session daemon's command line (the daemon hands them back to it). */
  daemonArgs?(userData: string): string[];
  /** Its look at every session daemon main attaches - an older build's still running its work, say. */
  onDaemonAttach?(daemon: AttachedDaemon): void;
  /**
   * Page tabs and the agent tools that drive them: the tab IPC, the agents'
   * socket and every terminal's tools, the hosts' relayed requests. Absent =
   * no page tab and no agent tools (the editor's file preview and
   * `browser:previewUrl` are core's).
   */
  browser?(ctx: BrowserContext): { dispose(): void };
};

/** What a slot started outside `register` gets to gate its work on its feature. */
export type Gated = {
  /** The gate for one of the extension's features. */
  gate: (feature: Feature) => FeatureGate;
};

/** What `index.ts` hands the status line when it starts it. */
export type StatusLineContext = Gated & {
  hosts: RemoteHosts;
  /** Every live app window. */
  windows: () => Iterable<BrowserWindow>;
  /** The terminals alive (the session daemon's, once it answered): their captures stay. */
  liveTerminalIds: () => Promise<string[]>;
};

export type StatusLineStarted = {
  /** For this machine's launches, plus dropping the capture of a pty that is gone. */
  statusLine: AgentStatusLine & { forget(ptyId: string): void };
  dispose(): void;
};

/** What `index.ts` hands the page tabs when it starts them. */
export type BrowserContext = Gated & {
  hosts: RemoteHosts;
  runtimeSessions: RuntimeSessionsStarted;
  /** The windows that show a session (a runtime agent's tools ask there). */
  sessionWindows: (sessionId: string) => WebContents[];
};

/**
 * A slot's entitlement (a private plan › Entitlement):
 * its IPC registrar, every handler answering ELOCKED while the feature is not
 * entitled, and the same question for what is not IPC (a socket, a daemon).
 */
export type FeatureGate = {
  ipc: IpcRegistrar;
  entitled: () => boolean;
};
