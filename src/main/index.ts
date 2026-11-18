import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  protocol,
  screen,
  session,
  dialog,
  nativeImage,
  nativeTheme,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
// FIRST: a local instance moves its data folder before any module can read it.
import './user-data';
import { join, posix, relative, isAbsolute } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { electronApp, is } from '@electron-toolkit/utils';
import { appIdFor, decorateWindowTitle, RELEASE_DESKTOP_PROTOCOL } from './app-env';
import { EDITION } from './edition';
import { appPermissionGranted } from './app-permissions';
import {
  WINDOW_STATE_FILE,
  fitWindowBounds,
  readWindowState,
  writeWindowState,
} from './window-state';
import { APP_ICON_PATH, DEMO_INSTANCE, DESKTOP_PROTOCOL_SCHEME, SHOWN_ENV } from './app-icon';
import {
  registerTerminalIpc,
  setTerminalEntitlement,
  setTerminalStatusLine,
  setTerminalHostResolver,
  setTerminalSessionHostResolver,
  createInProcessBackend,
  disposeTerminalsForWindow,
  liveTerminalIds,
  stopAllTerminals,
  daemonOverview,
  moveDaemonTerminals,
  setPendingTerminalOwner,
  isTerminalOwnedBy,
  reassignSessionShells,
  reassignWindowShells,
  requestReplayForOwner,
  type TerminalDisposeOptions,
} from './terminal';
import { createTerminalBackend } from './terminal-backend';
import { createDaemonBackend } from './daemon/daemon-launcher';
import { localRuntime, setRuntimeGate, setRuntimeResolver } from './host-runtime';
import { sessionHostOf } from './session-host';
import { currentHostRoots, hostOfPathNow, hostRootsLoading, reloadHostRoots } from './host-roots';
import { onProjectRowsChanged } from './db/ipc';
import { keepSessionsOnQuit, registerSessionDaemonIpc } from './session-daemon';
import { viewMenu } from './app-menu';
import { windowCloseKillsTerminals } from './session-daemon-state';
import { sweepStaleSessions } from './crash-recovery';
import {
  sessionWindowsInOrder,
  externalFor,
  mainWindowId,
  maySettleSession,
  sessionReturnTarget,
  sessionWindowId,
  type WindowRecord,
} from './window-ownership';
import {
  layoutTabs,
  registerProjectWindowIpc,
  type ProjectDescriptor,
  type ProjectWindowIpc,
  type SerializedLayout,
} from './project-windows';
import { getDb, closeDb, startDb } from './db/client';
import { THEME_HINT_FILE, WINDOW_BACKGROUND, readThemeHint, writeThemeHint } from './theme-hint';
import {
  DEMO_ARG,
  LOCAL_ENV_ARG,
  titleBarOverlay,
  windowChromeOptions,
  type TitleBarKind,
} from './window-chrome';
import { showWhenFirstReady } from './window-show';
import { resolveUserPath } from './user-path';
import { createWillQuitHandler } from './quit-sequence';
import {
  NO_BUSY,
  SYSTEM_ENDING_TTL_MS,
  countBusyTerminals,
  planQuitConfirm,
  quitMayNeedConfirm,
  planRuntimeQuitConfirm,
  quitStopsSessions as quitIntentStopsSessions,
  type BusyCounts,
  type QuitAction,
  type QuitDecision,
  type QuitIntent,
} from './quit-confirm';
import { registerDbIpc } from './db/ipc';
import { registerTables } from './db/row-schemas';
import { registerLayoutIpc, saveLayout } from './db/layout-ipc';
import { registerFsIpc, disposeFsWatchersForWindow } from './fs';
import { registerSearchIpc } from './search';
import { installBrowserGuards, registerPreviewIpc } from './browser/webview-host';
import { PREVIEW_SCHEME } from './browser/guard';
import { registerGitIpc, disposeGitWatchersForWindow } from './git';
// The one core file allowed to import it (a private plan).
import { createRelaunchOnQuit } from './relaunch-on-quit';
import { proMain } from '@pro/main';
import type { Feature, FeatureGate } from './extension';
import { localOnly, readyAfter } from './remote-hosts';
import { NO_RUNTIME_SESSIONS, type RuntimeSessionsStarted } from './runtime-sessions';
import { registerProtocolExtension } from './daemon/protocol';
import { featureIpc } from './pro-ipc';
import { refreshSessionBadge, applyBadgeToWindow } from './badge';
import { registerEditorsIpc } from './editors';
import { registerThirdPartyNoticesIpc } from './third-party-notices';
import { externalOpenUrl } from './external-links';
import { registerLanguageServersIpc, disposeLanguageServersForWindow } from './language-servers';
import { APP_ORIGIN, isAppUrl, isTrustedSender } from './ipc-util';
import { findAppLink } from './deep-link';

// The extension's crash reporting (the official build's), right after
// user-data.ts moved the data folder and before the scheme registration
// below - MainExtension.startCrashReporting has the why. Nothing in the core
// build.
proMain.startCrashReporting?.();

// The packaged renderer is served over this privileged custom scheme instead of
// file:// so its responses can carry real headers - onHeadersReceived never fires
// for file:// loads, which would ship production with no CSP at all. Must be
// registered before the app is ready. `codeCache` lets V8 keep compiled code
// for these scripts across launches (custom schemes opt out by default), so the
// multi-megabyte entry and editor chunks aren't re-parsed on every start.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
  // Workspace files in a browser tab (browser/preview.ts) - served on the
  // browser partition only; `stream` lets video seek.
  {
    scheme: PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// Electron builds its default menu at `ready` unless one was set by then; ours
// replaces it in the `whenReady` callback below, so skip building it at all.
Menu.setApplicationMenu(null);

/** A terminal tab being moved between windows (or out to a new one). */
type TabDescriptor = {
  kind: 'terminal';
  /** Stable PTY id; the receiving window adopts the live shell by this id. */
  termId: string;
  title: string;
  cwd: string | null;
};
/**
 * A whole session torn off into its own window. `layout` is the renderer's
 * serialized WorkspaceLayout (opaque here) or null. We only read the ptyIds out
 * of it to pre-assign ownership, via the structural shape below.
 */
type SessionDescriptor = {
  kind: 'session';
  sessionId: string;
  /** The session's project - where it returns when a project window hosts it. */
  projectId: string | null;
  label: string;
  projectName: string | null;
  layout: SerializedLayout | null;
  cwd: string | null;
};
/** One-shot payload a freshly-created window pulls on load. A project window
 * (a private plan) boots the full app scoped to its project. */
type InitialPayload =
  | { kind: 'detached'; tab: TabDescriptor }
  | { kind: 'session'; session: SessionDescriptor }
  | { kind: 'project'; project: ProjectDescriptor }
  | null;

// --- IPC payload guards -----------------------------------------------------
// The renderer is treated as untrusted across the boundary: validate the shape
// of every structured payload before acting on it, so a malformed (or hostile)
// message can't crash a handler or smuggle a bad id into a privileged op.
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function isTabDescriptor(d: unknown): d is TabDescriptor {
  return (
    typeof d === 'object' &&
    d !== null &&
    (d as { kind?: unknown }).kind === 'terminal' &&
    isNonEmptyStr((d as { termId?: unknown }).termId)
  );
}

function isSessionDescriptor(d: unknown): d is SessionDescriptor {
  if (typeof d !== 'object' || d === null) return false;
  const { kind, sessionId, projectId } = d as {
    kind?: unknown;
    sessionId?: unknown;
    projectId?: unknown;
  };
  return (
    kind === 'session' &&
    isNonEmptyStr(sessionId) &&
    (projectId == null || typeof projectId === 'string')
  );
}

/**
 * Production CSP, attached as a response header by the app:// protocol handler.
 * No 'unsafe-eval' and no 'unsafe-inline' for scripts - the Vite build needs
 * neither. Styles keep 'unsafe-inline' because xterm (and other libs) inject
 * style elements at runtime.
 */
const PROD_CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' (NOT full unsafe-eval): Monaco's TextMate tokenizer
  // compiles the bundled oniguruma WebAssembly, which Chromium gates behind
  // this keyword. Scripts themselves stay same-origin-only.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Local-first: no backend/Electric to reach. `data:` because Vite inlines
  // small assets as data: URIs in the build and Monaco FETCHES them - the
  // language configurations (brackets, comments, auto-closing), the Dark+ /
  // Light+ themes the Modern themes include, the JSON / YAML grammars. Blocked,
  // a release editor lost all of that while `pnpm dev` (files, not data:)
  // looked fine (2026-09-24).
  "connect-src 'self' data:",
  // Browser tabs (a private plan): a <webview> guest is a
  // frame of this page as far as CSP goes. The guest runs on its own
  // partition, sandboxed, with no preload (browser/guard.ts).
  `frame-src http: https: ${PREVIEW_SCHEME}:`,
].join('; ');

/**
 * Dev-only CSP, injected as a response header on the Vite dev server's pages.
 * Necessarily looser than production: React HMR needs eval, and the dev server /
 * HMR websocket need to be reachable.
 */
function installDevCSP() {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' http://localhost:* ws://localhost:*",
    `frame-src http: https: ${PREVIEW_SCHEME}:`,
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

/** How long after boot the login-shell PATH is resolved in the background. */
const USER_PATH_WARM_DELAY_MS = 5000;

/** Root of the built renderer (out/renderer), served by the app:// handler. */
const RENDERER_ROOT = join(__dirname, '../renderer');

/**
 * Serve the packaged renderer over app://renderer/… (the Electron-recommended
 * replacement for loadFile) so every response carries the production CSP header.
 * Paths are confined to the renderer build dir; anything escaping it 404s.
 */
function installAppProtocol() {
  protocol.handle('app', async (request) => {
    let target: string;
    try {
      const url = new URL(request.url);
      if (url.host !== 'renderer') return new Response('Not found', { status: 404 });
      const pathname = decodeURIComponent(url.pathname);
      target = join(RENDERER_ROOT, pathname === '/' ? '/index.html' : pathname);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const rel = relative(RENDERER_ROOT, target);
    if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Not found', { status: 404 });
    try {
      // net.fetch resolves the file with the correct Content-Type; we only add
      // the CSP on top.
      const res = await net.fetch(pathToFileURL(target).toString());
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', PROD_CSP);
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// Last-resort safety net: a stray throw/rejection in an IPC handler or async
// path shouldn't silently take down the main process (and with it every shell).
process.on('uncaughtException', (err) => console.error('main uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('main unhandledRejection:', reason));

// A second launch hands its argv (a deep link on Windows / Linux) to the
// running instance inside requestSingleInstanceLock, then must stop at once:
// `app.quit()` here still ran the whole `whenReady` boot - PGlite opened on the
// live database, a session daemon client, every IPC module - before quitting
// (every link on Linux, 2026-10-29). macOS routes links without a launch.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
} else {
  // The extension's last word on the data folder before anything opens it
  // (MainExtension.beforeDataOpens) - this instance holds the lock, so no
  // other one has the database open either.
  try {
    proMain.beforeDataOpens?.(app.getPath('userData'));
  } catch (err) {
    console.error('beforeDataOpens failed:', err);
  }
  // The database opens in its worker thread now, beside the window's creation
  // and load - on main it blocked the renderer's script requests (db/client.ts).
  startDb(join(__dirname, 'db-worker.js'));
}

// All open windows. The first is the full app; later ones are detached terminal
// windows (and any spawned via tear-off). `lastFocused` drives second-instance
// focus and dialog parenting.
const windows = new Set<BrowserWindow>();
/** Which header each window renders - the controls overlay's height (window-chrome.ts). */
const titleBarKinds = new WeakMap<BrowserWindow, TitleBarKind>();
let lastFocused: BrowserWindow | null = null;

// --- The app's link scheme ----------------------------------------------------
// Register our deep-link scheme (com.double0.desktop://, `-dev` for a local
// instance - app-env.ts › resolveDesktopProtocol) so a web page can bring the
// app to the front and hand it a link the extension understands. The scheme
// needs no renderer privileges (it never loads content), so it stays out of
// registerSchemesAsPrivileged above.
if (process.defaultApp) {
  // Dev: `electron .` - the protocol must point back at this invocation.
  if (process.argv.length >= 2 && typeof process.argv[1] === 'string') {
    app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME, process.execPath, [process.argv[1]]);
  }
} else {
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME);
  // The installer declares only the release scheme (electron-builder.yml):
  // a packaged build against a loopback API answers `-dev`, which macOS
  // will not route to it - its links go nowhere.
  if (DESKTOP_PROTOCOL_SCHEME === `${RELEASE_DESKTOP_PROTOCOL}-dev`) {
    console.warn(
      `[deep-link] this build answers ${DESKTOP_PROTOCOL_SCHEME}, which its installer does not declare - set VITE_DESKTOP_PROTOCOL for a packaged build against a local API`,
    );
  }
}
// A dev Electron registered before the `-dev` scheme existed still owns the
// release scheme, so the production dashboard kept opening it: hand it back.
if (
  DESKTOP_PROTOCOL_SCHEME !== RELEASE_DESKTOP_PROTOCOL &&
  process.defaultApp &&
  typeof process.argv[1] === 'string' &&
  app.isDefaultProtocolClient(RELEASE_DESKTOP_PROTOCOL, process.execPath, [process.argv[1]])
) {
  app.removeAsDefaultProtocolClient(RELEASE_DESKTOP_PROTOCOL, process.execPath, [process.argv[1]]);
}

// The extension's boot (a private plan), before any
// window exists. Nothing in the core build.
proMain.boot?.({
  focusedWindow: () => (lastFocused && !lastFocused.isDestroyed() ? lastFocused : null),
});

/**
 * A link on our scheme: bring the app to the front, then let the extension
 * take what it understands. A link nobody takes (`com.double0.desktop://open`)
 * only focuses.
 */
function handleDeepLink(url: string): void {
  if (!url.startsWith(`${DESKTOP_PROTOCOL_SCHEME}:`)) return;
  const w = lastFocused && !lastFocused.isDestroyed() ? lastFocused : [...windows][0];
  if (w) {
    if (w.isMinimized()) w.restore();
    // A link is the user asking for the app ("Open double0", the sign-in
    // callback). `focus()` alone only makes the window key: on macOS it asks
    // to activate the app without forcing it, and macOS 26 refuses while the
    // browser that sent the link is in front - "Open double0" did nothing
    // visible (2026-11-14). `show()` activates the app over it
    // (window-show.ts); never for anything the user did not ask for.
    w.show();
    w.focus();
  }
  proMain.handleDeepLink?.(url, w ?? null);
}

// macOS delivers deep links here (app running or cold start).
app.on('open-url', (_event, url) => {
  handleDeepLink(url);
});
/**
 * What each live window hosts, by webContents id (window-ownership.ts holds
 * the pure rules over it): the main window (created without a payload, where
 * projects return), a project window, a torn-off session's window, or a tab
 * window. Kept current in createWindow / 'closed'.
 */
const windowTable = new Map<number, WindowRecord>();
/** The live BrowserWindow behind a webContents id, or null. */
function windowOf(wcId: number | null): BrowserWindow | null {
  if (wcId == null) return null;
  for (const w of windows) {
    if (!w.isDestroyed() && w.webContents.id === wcId) return w;
  }
  return null;
}
/** The full app window (created without a tear-off payload); projects return here. */
const mainWindow = (): BrowserWindow | null => windowOf(mainWindowId(windowTable));
const sessionWindow = (sessionId: string): BrowserWindow | null =>
  windowOf(sessionWindowId(windowTable, sessionId));
/** Latest layout each torn-off session reported, used to hand it back when its window closes. */
const sessionLayouts = new Map<string, SerializedLayout>();
/** The project-window IPC + hand-back (project-windows.ts), wired once the app is ready. */
let projectWindowIpc: ProjectWindowIpc | null = null;
/**
 * Latest layout each detached TAB window reported (keyed by webContents id),
 * plus its fixed cwd - used to hand its terminals back to the app window when
 * it closes, mirroring how sessions return.
 */
const detachedTabWindows = new Map<number, { layout: SerializedLayout; cwd: string | null }>();
/**
 * Sessions whose windows are being destroyed (the session was deleted), so the
 * `close` handler skips handing them back - the window keeps owning its shells,
 * which the `closed` handler then kills.
 */
const destroyingSessions = new Set<string>();
/** True once the app is quitting, so closing windows don't try to hand sessions back. */
let isQuitting = false;
/**
 * Bootstrap payloads, keyed by webContents.id. Kept for the window's lifetime
 * (cleared in its 'closed' handler) rather than read-and-cleared: a reload
 * (Cmd+R, dev-server full reload) re-reads it, and without it the window would
 * re-boot as a second full app window - sidebar and all - able to double-open
 * sessions whose shells other windows own.
 */
const pendingPayloads = new Map<number, InitialPayload>();
/**
 * The window currently showing a cross-window tab-drag preview (the destination
 * the cursor is hovering mid-tear-off), so we can clear it when the cursor moves
 * to a different window, leaves all windows, or the drag ends.
 */
let dragPreviewWin: BrowserWindow | null = null;
/**
 * Tab transfers into an EXISTING window awaiting the target renderer's ack.
 * The target may have no workspace mounted (e.g. it has no project yet),
 * in which case inserting silently fails renderer-side - so the origin must NOT
 * drop its tab until the target confirms it actually took it, or a live PTY ends
 * up with no tab in any window. Keyed by a per-transfer correlation id.
 */
type PendingTabTransfer = {
  termId: string;
  originWcId: number;
  targetWcId: number;
  timeout: NodeJS.Timeout;
};
const pendingTabTransfers = new Map<string, PendingTabTransfer>();
let nextTabTransferId = 1;
/** How long the target gets to ack an insert before the transfer is rolled back. */
const TAB_TRANSFER_ACK_TIMEOUT_MS = 1500;
let disposeTerminals: ((opts?: TerminalDisposeOptions) => Promise<void>) | null = null;
/**
 * "Quit and Stop All Sessions" was chosen: this quit kills the daemon's
 * terminals whatever the Keep-running switch says (a private plan).
 */
let quitStopsSessions = false;
/**
 * The quit confirm (quit-confirm.ts, a private plan › Quit).
 * `quitConfirmed`: the quit in flight has been through it - asked and
 * answered, or found nothing to ask - so the `app.quit()` re-issued after the
 * answer (and the quit-sequence's own re-issue) pass without asking again.
 * `quitConfirmOpen`: a confirm is on screen - a second quit request meanwhile
 * is held, never a second dialog. `quitKeepsSessionsOnce`: "Keep them running
 * and quit" was chosen with the Keep-running switch off - this quit alone
 * leaves the sessions to the daemon.
 */
let quitConfirmed = false;
let quitConfirmOpen = false;
/** A restart the extension asked for, run from `will-quit` (relaunch-on-quit.ts). */
const relaunchOnQuit = createRelaunchOnQuit(() => app.relaunch());
let quitKeepsSessionsOnce = false;
/** "Keep them running and restart" was chosen; applied when the restart starts (`onRestart`). */
let restartKeepsSessionsOnce = false;
/** Busy counts off the terminal backend; bound once the backend exists. */
let busyTerminals: () => Promise<BusyCounts> = async () => NO_BUSY;
/** The extension's runtime sessions (`MainExtension.runtimeSessions`); bound once the terminals are up. */
let runtimeSessions: RuntimeSessionsStarted = NO_RUNTIME_SESSIONS;
const busyRuntimeCount = (): number => {
  const b = runtimeSessions.busy();
  return b.working + b.waiting;
};
/**
 * Runtime agents run in this process (no session daemon) and one is busy: any
 * quit ends it, whatever the Keep-running switch says - worth a confirm of its own.
 */
// Busy runtime agents that would die with an in-process quit - never a reason to hold
// a quit the OS started (logout / shutdown): the hold cancels it.
const runtimesDieOnQuit = (): boolean =>
  !systemEnding && runtimeSessions.inProcess() && busyRuntimeCount() > 0;
/**
 * The OS is ending the session (quit-confirm.ts › `QuitContext`): a quit
 * that follows is the system's, never held or asked about - a held quit
 * cancels a macOS logout, a dialog blocks it everywhere. Reported by
 * `powerMonitor` 'shutdown' (macOS, Linux) and a window's
 * 'query-session-end' / 'session-end' (Windows), and forgotten after
 * SYSTEM_ENDING_TTL_MS: the notice comes as the logout is REQUESTED, which
 * another app may still cancel, and a quit that never follows must not
 * silence the user's own next Cmd/Ctrl+Q.
 */
let systemEnding = false;
let systemEndingTimer: ReturnType<typeof setTimeout> | null = null;
function noteSystemEnding(source: string): void {
  systemEnding = true;
  if (systemEndingTimer) clearTimeout(systemEndingTimer);
  systemEndingTimer = setTimeout(() => {
    systemEnding = false;
    systemEndingTimer = null;
  }, SYSTEM_ENDING_TTL_MS);
  systemEndingTimer.unref();
  console.log(`[quit] the system is ending the session (${source})`);
}
/** What `quitMayNeedConfirm` reads off main right now. */
/**
 * Whether main knows which terminals are live yet: until the daemon list
 * lands (up to the boot deadline) the map is empty, and a stopping quit read
 * as "nothing live" passed unheld - then exited before the daemon was told
 * to stop them (review, 2026-10-06).
 */
let terminalsKnown = false;
/** Whether a terminal runs on a remote host (set once the host router exists). */
let isRemoteTerminalId: (id: string) => boolean = () => false;

const quitContext = (): { liveTerminals: number; systemEnding: boolean } => ({
  // A busy runtime agent counts like a live terminal: a stopping quit ends it.
  // Not known yet: assume one, so the quit is held and the confirm (which
  // awaits the backend) decides.
  // This machine's terminals only: a quit stops nothing on a remote host
  // (spec 16), so a remote shell alone never holds the quit.
  liveTerminals: Math.max(
    terminalsKnown ? 0 : 1,
    liveTerminalIds().filter((id) => !isRemoteTerminalId(id)).length + busyRuntimeCount(),
  ),
  systemEnding,
});

/** The quit in flight, as quit-confirm.ts reads it. */
function quitIntent(): QuitIntent {
  return {
    stopRequested: quitStopsSessions,
    keepRunning: keepSessionsOnQuit() || quitKeepsSessionsOnce,
  };
}

/**
 * Whether the quit in flight ends the daemon's terminals. The windows'
 * 'closed' handlers and `will-quit`'s disposer both read this, so they agree.
 */
function quitStopsTerminals(): boolean {
  return quitIntentStopsSessions(quitIntent());
}

/**
 * A quit that was called off - Cancel on the confirm, a window refusing to
 * close over unsaved edits, a failed restart: the app is fully running again
 * and the next quit starts from scratch.
 */
function resetQuitIntent(): void {
  // A restart held for this quit (relaunch-on-quit.ts) is dropped with it.
  relaunchOnQuit.abort();
  isQuitting = false;
  quitStopsSessions = false;
  quitKeepsSessionsOnce = false;
  quitConfirmed = false;
}

/**
 * Ask before a quit that would end busy work: a native message box on the
 * focused window (the renderer may be gone, or never involved - a Dock Quit).
 * Resolves 'proceed' at once when there is nothing to ask (the quit keeps the
 * sessions, or nothing is busy), 'cancel' while another confirm is already up.
 */
async function confirmQuit(action: QuitAction): Promise<QuitDecision> {
  if (quitConfirmOpen) return 'cancel';
  const intent = quitIntent();
  if (!quitMayNeedConfirm(intent, quitContext()) && !runtimesDieOnQuit()) return 'proceed';
  quitConfirmOpen = true;
  try {
    const plan =
      (quitMayNeedConfirm(intent, quitContext())
        ? planQuitConfirm({ ...intent, action }, await busyTerminals())
        : null) ??
      (runtimesDieOnQuit()
        ? planRuntimeQuitConfirm(runtimeSessions.busy(), runtimeSessions.noun, action)
        : null);
    if (!plan) return 'proceed';
    const options = {
      type: 'warning' as const,
      message: plan.message,
      detail: plan.detail,
      buttons: plan.buttons,
      defaultId: plan.defaultId,
      cancelId: plan.cancelId,
      noLink: true,
    };
    const parent = lastFocused && !lastFocused.isDestroyed() ? lastFocused : mainWindow();
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return plan.choices[response] ?? 'cancel';
  } catch (err) {
    // The question must never block the quit.
    console.error('quit: confirm failed:', err);
    return 'proceed';
  } finally {
    quitConfirmOpen = false;
  }
}
let disposeSessionDaemonIpc: (() => void) | null = null;
let disposeHostsIpc: (() => void) | null = null;
let disposeRuntimeSessions: (() => void) | null = null;
let disposeDb: (() => void) | null = null;
let disposeLayoutIpc: (() => void) | null = null;
let disposeFsIpc: (() => void) | null = null;
let disposeSearchIpc: (() => void) | null = null;
let disposeBrowserIpc: (() => void) | null = null;
let disposeAgentBrowser: (() => void) | null = null;
let disposeGitIpc: (() => void) | null = null;
let proRegistration: ReturnType<typeof proMain.register> | null = null;
let disposeEditorsIpc: (() => void) | null = null;
let disposeNoticesIpc: (() => void) | null = null;
let disposeStatusLine: (() => void) | null = null;
let disposeLanguageServersIpc: (() => void) | null = null;

/**
 * Tell every window what lives in a separate window right now - the torn-off
 * sessions and the projects in their own windows, each window's view of it
 * (its own project is never external to a project window). The sidebar derives
 * its "open elsewhere" flags from this (seeded via window:listExternal) instead
 * of renderer-local state, so a reload can't forget that a session's shells are
 * owned by another window and double-open it.
 */
function broadcastExternalWindows(): void {
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    win.webContents.send('window:externalChanged', externalFor(windowTable, win.webContents.id));
  }
}

/**
 * A torn-off session's window is closing: instead of killing its shells, re-own
 * them to the window its project lives in (the project's own window if there is
 * one, else the main window) and hand back the up-to-date layout, so the
 * session reappears there exactly as it was left.
 */
function returnSessionToOwner(sessionId: string): void {
  if (isQuitting) return;
  const fromWcId = sessionWindowId(windowTable, sessionId);
  const record = fromWcId != null ? windowTable.get(fromWcId) : undefined;
  const projectId = record?.kind === 'session' ? record.projectId : null;
  const target = windowOf(sessionReturnTarget(windowTable, projectId));
  const layout = sessionLayouts.get(sessionId);
  if (!target || !layout) return;
  // Re-own every shell so this window's imminent 'closed' cleanup spares them.
  for (const tab of Object.values(layout.tabs)) {
    if (isNonEmptyStr(tab.ptyId)) setPendingTerminalOwner(tab.ptyId, target.webContents.id);
  }
  // Shells outside the layout (the session's own, eagerly-spawned conversation/setup)
  // come back too - re-own them from the closing window so they survive to be
  // re-adopted when the session reopens.
  if (fromWcId != null) reassignSessionShells(sessionId, fromWcId, target.webContents.id);
  target.webContents.send('session:returnToList', { sessionId, layout });
}

/**
 * A detached tab window is closing: instead of killing its shells, hand each
 * terminal tab back to the app window through the normal acknowledged transfer
 * (appended to its active pane - a window close has no drop point). On rejection
 * (the app window shows no workspace surface, e.g. it has no project yet),
 * `settleTabTransfer` re-owns the shell to this already-closed window and sweeps
 * it, so nothing leaks.
 */
function returnDetachedTabsToMain(wcId: number): void {
  if (isQuitting) return;
  const main = mainWindow();
  const entry = detachedTabWindows.get(wcId);
  if (!main || !entry) return;
  // A tab already mid-transfer to another window belongs to that transfer's
  // machinery; re-routing it here would hijack its pending ownership.
  const inFlight = new Set([...pendingTabTransfers.values()].map((p) => p.termId));
  for (const tab of Object.values(entry.layout.tabs)) {
    if (!isNonEmptyStr(tab.ptyId) || inFlight.has(tab.ptyId)) continue;
    // Only shells this window still owns can be handed back.
    if (!isTerminalOwnedBy(tab.ptyId, wcId)) continue;
    setPendingTerminalOwner(tab.ptyId, main.webContents.id);
    const transferId = `tab-transfer:${nextTabTransferId++}`;
    pendingTabTransfers.set(transferId, {
      termId: tab.ptyId,
      originWcId: wcId,
      targetWcId: main.webContents.id,
      timeout: setTimeout(() => settleTabTransfer(transferId, false), TAB_TRANSFER_ACK_TIMEOUT_MS),
    });
    main.webContents.send('tab:insertExternal', {
      descriptor: {
        kind: 'terminal',
        termId: tab.ptyId,
        title: isNonEmptyStr(tab.title) ? tab.title : 'Terminal',
        cwd: entry.cwd,
      } satisfies TabDescriptor,
      // An off-screen client point misses every strip/pane hit-test, so the
      // receiving workspace appends the tab to its active pane.
      clientX: -1,
      clientY: -1,
      transferId,
    });
  }
}

function webContentsById(id: number): WebContents | null {
  return windowOf(id)?.webContents ?? null;
}

/** Raise a window (it may sit on another Space or monitor). */
function raiseWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.moveTop();
}

/**
 * Resolve a pending cross-window tab transfer. Accepted → the target inserted
 * the tab, so NOW the origin may drop its copy (the renderer keeps a torn-off
 * tab until this `tab:removed`, so there's no optimistic UI to undo). Rejected
 * (the target had no workspace mounted, or never acked in time) → leave the
 * origin's tab in place and re-route the shell's pending ownership back to the
 * origin, undoing the pre-assignment made when the drop was dispatched.
 */
function settleTabTransfer(transferId: string, accepted: boolean): void {
  const pending = pendingTabTransfers.get(transferId);
  if (!pending) return;
  pendingTabTransfers.delete(transferId);
  clearTimeout(pending.timeout);
  if (accepted) {
    webContentsById(pending.originWcId)?.send('tab:removed', { termId: pending.termId });
    return;
  }
  // There's no "clear pending owner" API; pointing the pending owner back at the
  // origin (which still owns the shell) is equivalent - the origin's own next
  // create/close handles it like any self-routed transfer.
  setPendingTerminalOwner(pending.termId, pending.originWcId);
  // If the origin window died mid-transfer its close spared this shell (it was
  // routed elsewhere); with the transfer rejected nothing can ever adopt or kill
  // it, so sweep the origin's terminals again now that it's re-owned there.
  if (!webContentsById(pending.originWcId)) disposeTerminalsForWindow(pending.originWcId);
}

/** Tell the window currently showing a cross-window drop preview to drop it. */
function clearTabDragPreview(): void {
  if (dragPreviewWin && !dragPreviewWin.isDestroyed()) {
    dragPreviewWin.webContents.send('tab:dragPreviewEnd');
  }
  dragPreviewWin = null;
}

/**
 * Point a window at the renderer. In production it's the built bundle, served
 * over app:// (see installAppProtocol). In dev it's the Vite dev server, which
 * may not be listening yet when the Electron process (re)launches - on a hot
 * restart Electron often wins the race, so `loadURL` rejects with
 * ERR_CONNECTION_REFUSED and the window is stranded on a blank/white page with
 * nothing to reload it. Retry with a short backoff until Vite answers (capped
 * at ~15s) so a restart can't leave the app white.
 */
function loadRenderer(win: BrowserWindow, attempt = 0): void {
  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined;
  if (!devUrl) {
    void win.loadURL(`${APP_ORIGIN}/index.html`);
    return;
  }
  win.loadURL(devUrl).catch((err: Error) => {
    if (win.isDestroyed()) return;
    if (attempt >= 60) {
      console.error(`renderer dev server unreachable after ${attempt} retries:`, err.message);
      return;
    }
    setTimeout(() => loadRenderer(win, attempt + 1), 250);
  });
}

/**
 * Restore the app window's maximized / full-screen flags and keep
 * window-state.json current: saved on every move/resize (debounced, so a
 * killed process still reopens at the last size) and flushed on close.
 */
function trackWindowState(
  win: BrowserWindow,
  path: string,
  saved: ReturnType<typeof readWindowState>,
): void {
  if (saved?.fullScreen) win.setFullScreen(true);
  else if (saved?.maximized) win.maximize();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (win.isDestroyed() || win.isMinimized()) return;
    writeWindowState(path, {
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    });
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('enter-full-screen', schedule);
  win.on('leave-full-screen', schedule);
  win.on('close', save);
}

function createWindow(opts?: {
  payload?: InitialPayload;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): BrowserWindow {
  const payload = opts?.payload ?? null;
  const sessionId = payload?.kind === 'session' ? payload.session.sessionId : null;
  const projectId = payload?.kind === 'project' ? payload.project.projectId : null;
  // A project window renders the full app chrome, so it keeps the app window's
  // minimum size; detached terminal windows can be much smaller.
  const fullChrome = !payload || payload.kind === 'project';
  const minWidth = fullChrome ? 900 : 420;
  const minHeight = fullChrome ? 600 : 300;
  // The app window reopens at its last size/position (window-state.ts), fitted
  // onto the displays that exist now. Only the main window is tracked - a
  // project window is sized where it was opened and never shares the file.
  const windowStatePath = join(app.getPath('userData'), WINDOW_STATE_FILE);
  const saved = payload ? null : readWindowState(windowStatePath);
  const restored = saved
    ? fitWindowBounds(
        saved.bounds,
        [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((d) => d.workArea),
        { width: minWidth, height: minHeight },
      )
    : null;
  const width = opts?.width ?? restored?.width ?? 1280;
  const height = opts?.height ?? restored?.height ?? 800;
  const x = opts?.x ?? restored?.x;
  const y = opts?.y ?? restored?.y;
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const titleBar: TitleBarKind = fullChrome ? 'full' : 'compact';
  const win = new BrowserWindow({
    width,
    height,
    ...(x != null && y != null ? { x, y } : {}),
    minWidth,
    minHeight,
    show: false,
    // What shows until the page's first paint (and behind it on a resize) -
    // the app's own background instead of the default white.
    backgroundColor: WINDOW_BACKGROUND[theme],
    autoHideMenuBar: true,
    // No OS title bar: the app's header is the title bar (window-chrome.ts).
    ...windowChromeOptions(process.platform, titleBar, theme),
    ...(process.platform === 'linux' ? { icon: APP_ICON_PATH } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // sandbox MUST stay false here. electron-vite builds the preload as an ESM
      // module (index.mjs), but Electron's sandbox loads neither ESM preloads nor
      // external requires. Turning it on makes the preload silently fail to load,
      // so `window.api` is never exposed and every IPC feature breaks (folder
      // picker, terminals, session tear-off…). Re-enabling the sandbox would first
      // require shipping a bundled, CJS, dependency-inlined, sandbox-safe preload.
      sandbox: false,
      contextIsolation: true,
      // Keep timers/JS at full rate when the window is minimized or fully occluded,
      // so a background session still flips to "needs input" and fires its
      // notification + sound promptly, instead of Chromium throttling the deriver's
      // idle timer to ~1/min while the app isn't on top.
      backgroundThrottling: false,
      // Browser tabs are <webview> guests (a private plan);
      // every attach is vetted by browser/guard.ts and fails closed.
      webviewTag: true,
      // The header's DEV badge (app-env.ts), read by the preload before the
      // page loads - the renderer never learns the environment otherwise.
      // A demo instance's header drops the traffic-light room (app-env.ts ›
      // `isDemoInstance`).
      additionalArguments: [
        ...(SHOWN_ENV === 'local' ? [LOCAL_ENV_ARG] : []),
        ...(DEMO_INSTANCE ? [DEMO_ARG] : []),
      ],
    },
  });
  titleBarKinds.set(win, titleBar);
  // Footage of the page never captures the native buttons; hide them so the
  // demo window looks like what it films.
  if (DEMO_INSTANCE && process.platform === 'darwin') win.setWindowButtonVisibility(false);
  // The header reserves room for the traffic lights, which macOS hides in
  // full screen: tell the renderer, and repeat it once the page is up (a
  // window restored into full screen enters it before anything listens).
  const sendFullScreen = (): void => {
    if (!win.isDestroyed()) win.webContents.send('window:fullScreen', win.isFullScreen());
  };
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);
  win.webContents.on('dom-ready', sendFullScreen);

  // The environment suffix on every window title (app-env.ts): the renderer
  // owns the title (index.html's <title>, a torn-off window's document.title)
  // and main decorates it as it lands, so a local instance reads
  // "double0 - DEV" in the app switcher, the Window menu and the taskbar next
  // to the release's "double0". No OS title bar shows it any more: the
  // header's DEV badge does (window-chrome.ts, `additionalArguments`).
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    win.setTitle(decorateWindowTitle(title, SHOWN_ENV));
  });

  if (!payload) trackWindowState(win, windowStatePath, saved);

  windows.add(win);
  lastFocused = win;
  // webContents.id is assigned at construction; capture it for the closed handler
  // (win.webContents may be torn down by then).
  const wcId = win.webContents.id;
  // Register what this window hosts. The payload-less window is the full app
  // (projects and torn-off sessions return to it); a session window carries
  // its project so a session torn off from a project window returns there.
  if (!payload) windowTable.set(wcId, { kind: 'main' });
  else if (payload.kind === 'session') {
    windowTable.set(wcId, {
      kind: 'session',
      sessionId: payload.session.sessionId,
      projectId: payload.session.projectId ?? null,
    });
  } else if (payload.kind === 'project') {
    windowTable.set(wcId, { kind: 'project', projectId: payload.project.projectId });
  } else windowTable.set(wcId, { kind: 'tab' });
  // Seed a session window's layout map with what was torn off (the renderer
  // refreshes it via syncLayout). A project window's layouts live in
  // project-windows.ts, seeded by the handler that opens it.
  if (payload?.kind === 'session' && payload.session.layout) {
    sessionLayouts.set(payload.session.sessionId, payload.session.layout);
  }
  if (sessionId || projectId) broadcastExternalWindows();
  // Track a detached tab window the same way, seeded with the tab it was born
  // with (the renderer refreshes the layout via tab:syncLayout as tabs come and
  // go), so its terminals can be handed back to the app when it closes.
  if (payload?.kind === 'detached') {
    detachedTabWindows.set(win.webContents.id, {
      layout: {
        tabs: { [payload.tab.termId]: { ptyId: payload.tab.termId, title: payload.tab.title } },
      },
      cwd: payload.tab.cwd,
    });
  }
  if (payload) pendingPayloads.set(wcId, payload);

  win.on('focus', () => {
    lastFocused = win;
  });
  win.on('close', (event) => {
    // Windows / Linux: closing the last window quits the app
    // (`window-all-closed`) - but by then this window's 'closed' handler has
    // killed the shells it owned, as a plain window close does, so the daemon
    // never got to keep them and the quit confirm never saw them. Make it the
    // quit it is: the quit closes the window again with `isQuitting` raised,
    // and its shells are treated like any quit's (kept, confirmed, or stopped).
    if (process.platform !== 'darwin' && !isQuitting && windows.size === 1) {
      event.preventDefault();
      app.quit();
      return;
    }
  });
  // A renderer refusing to unload (unsaved editor edits) during a quit calls
  // the quit off - Electron just stops; nothing else tells main. Without this
  // the app kept running with `isQuitting` raised (so a closing window never
  // handed its sessions back) and the quit confirm would not ask again.
  win.webContents.on('will-prevent-unload', (event) => {
    // A restart the user agreed to with unsaved edits discarded
    // (MainContext.restartStoppingSessions): the window closes anyway -
    // otherwise the restart could never happen while a file is unsaved.
    if (isQuitting && relaunchOnQuit.held()) {
      event.preventDefault();
      return;
    }
    if (isQuitting) resetQuitIntent();
  });
  // Windows reports the end of the user's session per window
  // (WM_QUERYENDSESSION / WM_ENDSESSION): the quit that follows is the
  // system's - never held for the confirm (see `systemEnding`).
  if (process.platform === 'win32') {
    win.on('query-session-end', () => noteSystemEnding('query-session-end'));
    win.on('session-end', () => noteSystemEnding('session-end'));
  }
  win.on('closed', () => {
    // Hand the session (or project) back - only now: 'close' fires before the
    // renderer's beforeunload, which may still refuse (unsaved editor edits),
    // and a hand-back done then left the window open on shells main had
    // taken (review, 2026-10-06). Before the cleanup below: it reads the
    // window's table entry, layouts and shells. A session being destroyed
    // (deleted) keeps its shells, which die with the window. A detached tab
    // window hands its terminal tabs back to the app window the same way.
    if (sessionId && !destroyingSessions.has(sessionId)) returnSessionToOwner(sessionId);
    else if (projectId) projectWindowIpc?.returnProjectToMain(projectId, wcId);
    else if (payload?.kind === 'detached') returnDetachedTabsToMain(wcId);
    windows.delete(win);
    windowTable.delete(wcId);
    pendingPayloads.delete(wcId);
    if (dragPreviewWin === win) dragPreviewWin = null;
    if (sessionId) {
      sessionLayouts.delete(sessionId);
      destroyingSessions.delete(sessionId);
    }
    if (projectId) projectWindowIpc?.forgetProjectWindow(projectId, wcId);
    if (sessionId || projectId) broadcastExternalWindows();
    detachedTabWindows.delete(wcId);
    if (lastFocused === win) lastFocused = [...windows][windows.size - 1] ?? null;
    // Kill only the PTYs this window still owns; ones moved out (or handed back at
    // the top of this handler) were re-owned by their new window and keep running. A quit
    // that keeps sessions closes every window before `will-quit` - spare them
    // here, or they are dead before the daemon is told to keep them.
    if (
      windowCloseKillsTerminals({
        quitting: isQuitting,
        keepRunning: keepSessionsOnQuit() || quitKeepsSessionsOnce,
        stopRequested: quitStopsSessions,
      })
    )
      disposeTerminalsForWindow(wcId);
    // Close any file-explorer / git watchers this window opened.
    disposeFsWatchersForWindow(wcId);
    disposeGitWatchersForWindow(wcId);
    // And whatever the extension held for it (its feeds).
    proRegistration?.forgetWindow?.(wcId);
    // And any language servers it was talking to.
    disposeLanguageServersForWindow(wcId);
  });

  // Once only: a webview guest's page loads repeat the event on this window,
  // and a second `show()` would activate the app over the one in front.
  showWhenFirstReady(win, () => {
    // Windows taskbar overlays are per-window - give this one the current badge.
    applyBadgeToWindow(win);
  });

  // The app never navigates its top frame: any attempted navigation away from
  // the renderer's own origin (dev server / app://) is hostile or accidental -
  // block it. (Hash-route changes are in-page and don't fire this; new-window
  // attempts are handled by setWindowOpenHandler below.)
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  // A reload (Cmd+R) keeps the webContents id, so fs-watch refs taken by the old
  // page would leak forever (the renderer re-watches from scratch but never
  // releases the old refs). Drop this window's watchers whenever its main frame
  // starts a real (non-same-document) navigation.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      disposeFsWatchersForWindow(wcId);
      disposeGitWatchersForWindow(wcId);
      proRegistration?.forgetWindow?.(wcId);
      disposeLanguageServersForWindow(wcId);
    }
  });

  win.webContents.setWindowOpenHandler((details) => {
    // Never open the window in-app; only web pages and mail to an address go
    // to the OS - a file://, custom-scheme or other OS-handler URI must not
    // reach openExternal (external-links.ts).
    const url = externalOpenUrl(details.url);
    if (url) void shell.openExternal(url);
    return { action: 'deny' };
  });

  loadRenderer(win);
  return win;
}

app.on('second-instance', (_event, argv) => {
  const w = lastFocused && !lastFocused.isDestroyed() ? lastFocused : [...windows][0];
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
  // Windows/Linux deliver deep links as an argv entry of a second launch.
  const url = findAppLink(argv ?? [], DESKTOP_PROTOCOL_SCHEME);
  if (url) handleDeepLink(url);
});

/**
 * Install a minimal application menu. The renderer owns workspace shortcuts via
 * a keydown handler, but Electron's default menu reserves Cmd/Ctrl+W for "Close
 * Window" - which would swallow the renderer's close-tab shortcut. We keep the
 * standard editing/view/window roles (copy, paste, reload, devtools, zoom,
 * fullscreen, minimize, quit…) but free the close-tab combo:
 *  - macOS: close-tab is ⌘W, so window-close moves to ⇧⌘W.
 *  - Win/Linux: close-tab is Ctrl+Shift+W (bare Ctrl+W is the shell's), so we
 *    register no window-close accelerator at all - leaving Ctrl+W for the shell
 *    and Ctrl+Shift+W for the renderer (window-close stays on the title bar /
 *    Alt+F4 / the Quit item).
 */
function installApplicationMenu(): void {
  const mac = process.platform === 'darwin';
  const close: MenuItemConstructorOptions = { role: 'close', accelerator: 'Shift+Cmd+W' };
  // Quit leaves the session daemon's terminals running by default
  // (a private plan); this item is the way to end them all.
  const quitAndStop: MenuItemConstructorOptions = {
    label: mac ? 'Quit and Stop All Sessions' : 'Quit and stop all sessions',
    click: () => {
      quitStopsSessions = true;
      app.quit();
    },
  };
  // The standard app menu, spelled out so the extra quit item sits above Quit.
  const appMenu: MenuItemConstructorOptions = {
    role: 'appMenu',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      quitAndStop,
      { role: 'quit' },
    ],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [appMenu] : [{ label: 'File', submenu: [quitAndStop, { role: 'quit' as const }] }]),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(mac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: viewMenu({ mac, dev: is.dev }) },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(mac ? [close, { type: 'separator' as const }, { role: 'front' as const }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // A second instance is already exiting (see `gotTheLock`); boot nothing.
  if (!gotTheLock) return;
  electronApp.setAppUserModelId(appIdFor(EDITION));
  installApplicationMenu();

  // macOS ignores BrowserWindow's `icon`; set the dock icon explicitly.
  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(APP_ICON_PATH);
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
  }

  // Force the native window appearance to follow the app's own theme. It starts
  // from the theme the last run reported (theme-hint.ts) so a light-theme user's
  // first window doesn't open dark and flip once the renderer reports in.
  const themeHintPath = join(app.getPath('userData'), THEME_HINT_FILE);
  nativeTheme.themeSource = readThemeHint(themeHintPath);
  ipcMain.on('native-theme', (event, theme: 'light' | 'dark') => {
    if (!isTrustedSender(event)) return;
    if (theme !== 'light' && theme !== 'dark') return;
    if (nativeTheme.themeSource !== theme) void writeThemeHint(themeHintPath, theme);
    nativeTheme.themeSource = theme;
    // Windows / Linux: the OS paints the window controls over the header, so
    // they are re-tinted here (macOS's traffic lights follow themeSource).
    if (process.platform !== 'darwin') {
      for (const w of windows) {
        const kind = titleBarKinds.get(w);
        if (kind && !w.isDestroyed()) w.setTitleBarOverlay(titleBarOverlay(theme, kind));
      }
    }
  });

  // Deny every permission request but a clipboard write (app-permissions.ts).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(appPermissionGranted(permission)),
  );

  if (is.dev) installDevCSP();
  installAppProtocol();
  installBrowserGuards();

  // The app window is created here, before the ~25 IPC registrations and the
  // daemon / integrations setup below, so its renderer process starts and
  // loads while main finishes booting. Safe because this whole callback runs
  // synchronously: nothing the renderer sends is handled until it returns, by
  // which time every handler is registered. What the window needs at creation
  // - the app:// protocol, the browser guards, the shortcut hook above - is
  // already in place.
  createWindow();
  // Resolve the login shell's PATH ahead of the first runtime agent / language
  // server / account read, which otherwise each wait on `$SHELL -ilc` (up to
  // 5 s) - delayed so sourcing the user's rc files doesn't compete with boot.
  setTimeout(() => void resolveUserPath(), USER_PATH_WARM_DELAY_MS);

  // Native folder picker, parented to the window that asked.
  ipcMain.handle('dialog:openDirectory', async (event) => {
    if (!isTrustedSender(event)) return null;
    const options: Electron.OpenDialogOptions = {
      title: 'Choose project destination',
      buttonLabel: 'Select folder',
      properties: ['openDirectory', 'createDirectory'],
    };
    const win = BrowserWindow.fromWebContents(event.sender) ?? lastFocused;
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Save a text file via the native save dialog (Settings → General → Export).
  ipcMain.handle(
    'dialog:saveFile',
    async (event, payload: { defaultName?: unknown; content?: unknown }) => {
      if (!isTrustedSender(event)) return { error: 'Untrusted sender' };
      if (typeof payload?.content !== 'string') return { error: 'Nothing to save' };
      const name = typeof payload.defaultName === 'string' ? payload.defaultName : 'export.json';
      const options: Electron.SaveDialogOptions = {
        title: 'Export',
        defaultPath: join(app.getPath('documents'), name),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      };
      const win = BrowserWindow.fromWebContents(event.sender) ?? lastFocused;
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { canceled: true };
      try {
        await writeFile(result.filePath, payload.content, 'utf8');
        return { path: result.filePath };
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Could not write the file' };
      }
    },
  );

  // Pick + read a text file via the native open dialog (Settings → General → Import).
  ipcMain.handle('dialog:openFile', async (event) => {
    if (!isTrustedSender(event)) return { error: 'Untrusted sender' };
    const options: Electron.OpenDialogOptions = {
      title: 'Import',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    };
    const win = BrowserWindow.fromWebContents(event.sender) ?? lastFocused;
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    try {
      const content = await readFile(result.filePaths[0], 'utf8');
      return { path: result.filePaths[0], content };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Could not read the file' };
    }
  });

  // App version (package.json), shown in Settings → General.
  ipcMain.handle('app:getVersion', (event) => (isTrustedSender(event) ? app.getVersion() : null));

  // A window pulls its bootstrap payload here. The payload stays stored until
  // the window closes so a reload re-renders the same detached surface instead
  // of booting as a full app window; a session payload is re-read with the
  // freshest synced layout, so the reloaded window rebuilds the tabs it had and
  // re-adopts the shells it still owns (same webContents id across reloads).
  ipcMain.handle('window:getInitialPayload', (event): InitialPayload => {
    if (!isTrustedSender(event)) return null;
    const payload = pendingPayloads.get(event.sender.id) ?? null;
    if (payload?.kind === 'session') {
      const layout = sessionLayouts.get(payload.session.sessionId);
      if (layout) return { ...payload, session: { ...payload.session, layout } };
    }
    if (payload?.kind === 'project' && projectWindowIpc) {
      return {
        ...payload,
        project: projectWindowIpc.currentDescriptor(event.sender.id, payload.project),
      };
    }
    return payload;
  });

  // A tab was dropped outside its window. Route it: into the window under the
  // cursor, or into a brand-new window on the nearest display. Either way the
  // origin is told to drop the tab (the PTY survives and is re-owned on adopt).
  ipcMain.on(
    'tab:dropExternal',
    (event, payload: { descriptor?: unknown; newWindow?: unknown }) => {
      if (!isTrustedSender(event)) return;
      // The drag is over - tear down any live preview before committing the drop.
      clearTabDragPreview();
      const originWcId = event.sender.id;
      const descriptor = payload?.descriptor;
      if (!isTabDescriptor(descriptor)) return;
      // You can only tear off a tab whose shell THIS window currently owns -
      // never reassign another window's shell on a renderer-supplied id.
      if (!isTerminalOwnedBy(descriptor.termId, originWcId)) return;
      // The cursor is still at the release point on pointerup. getCursorScreenPoint
      // returns DIP coords consistent with getBounds() on every platform (unlike
      // screen.screenToDipPoint, which is Windows-only), so the hit-test below is
      // correct on mixed-DPI monitors without per-platform conversion.
      const dip = screen.getCursorScreenPoint();

      let target: BrowserWindow | null = null;
      // An explicit new-window request (the tab menu's "Open in separate window")
      // skips under-cursor routing: a menu click leaves the cursor over the origin
      // window, and a window stacked behind it must not adopt the tab.
      if (payload?.newWindow !== true) {
        for (const w of windows) {
          if (w.isDestroyed() || w.webContents.id === originWcId) continue;
          const b = w.getBounds();
          if (dip.x >= b.x && dip.x < b.x + b.width && dip.y >= b.y && dip.y < b.y + b.height) {
            target = w;
            break;
          }
        }
      }

      if (target) {
        // Convert to client coords against the CONTENT bounds (web area), not the
        // full window bounds, so the drop lands where the cursor is even with a
        // native title bar - and matches the preview, which uses the same basis.
        const cb = target.getContentBounds();
        // Pre-assign ownership to the target so the origin dropping the tab (and,
        // if it's a detached window emptying out, closing) can't kill the shell
        // before the target adopts it.
        setPendingTerminalOwner(descriptor.termId, target.webContents.id);
        target.focus();
        target.moveTop();
        // The insert is ACKNOWLEDGED: the target replies on tab:insertExternalResult
        // with this correlation id, and only a positive ack removes the origin's tab
        // (see settleTabTransfer). The timeout settles a target that never answers
        // (hung renderer, window closed mid-flight) as a rejection.
        const transferId = `tab-transfer:${nextTabTransferId++}`;
        pendingTabTransfers.set(transferId, {
          termId: descriptor.termId,
          originWcId,
          targetWcId: target.webContents.id,
          timeout: setTimeout(
            () => settleTabTransfer(transferId, false),
            TAB_TRANSFER_ACK_TIMEOUT_MS,
          ),
        });
        target.webContents.send('tab:insertExternal', {
          descriptor,
          clientX: Math.round(dip.x - cb.x),
          clientY: Math.round(dip.y - cb.y),
          transferId,
        });
      } else {
        const wa = screen.getDisplayNearestPoint(dip).workArea;
        const width = 760;
        const height = 520;
        const x = Math.round(Math.min(Math.max(dip.x - 80, wa.x), wa.x + wa.width - width));
        const y = Math.round(Math.min(Math.max(dip.y - 18, wa.y), wa.y + wa.height - height));
        const win = createWindow({
          payload: { kind: 'detached', tab: descriptor },
          x,
          y,
          width,
          height,
        });
        setPendingTerminalOwner(descriptor.termId, win.webContents.id);
        // No ack round trip here: the brand-new window renders nothing but the
        // detached surface seeded from this payload, so the insert can't miss.
        webContentsById(originWcId)?.send('tab:removed', { termId: descriptor.termId });
      }
    },
  );

  // The target renderer's reply to tab:insertExternal: whether it actually
  // inserted the tab (it can't when no workspace surface is mounted there, e.g.
  // the window has no project yet). Only the routed target may settle.
  ipcMain.on(
    'tab:insertExternalResult',
    (event, payload: { transferId?: unknown; accepted?: unknown }) => {
      if (!isTrustedSender(event)) return;
      const transferId = payload?.transferId;
      if (!isNonEmptyStr(transferId)) return;
      const pending = pendingTabTransfers.get(transferId);
      if (!pending || pending.targetWcId !== event.sender.id) return;
      settleTabTransfer(transferId, payload?.accepted === true);
    },
  );

  // Live cross-window drop preview: while a tab is dragged over another window
  // (mid-tear-off), the origin pings on every move. We hit-test the cursor's
  // screen point (same basis as the drop) and tell the window under it to draw
  // the drop indicator at that client point - so the user sees where the tab
  // will land BEFORE releasing, in the destination, just like an in-window split.
  ipcMain.on('tab:dragOver', (event, payload: { descriptor?: unknown }) => {
    if (!isTrustedSender(event)) return;
    const originWcId = event.sender.id;
    const descriptor = payload?.descriptor;
    if (!isTabDescriptor(descriptor)) return;
    if (!isTerminalOwnedBy(descriptor.termId, originWcId)) return;
    const dip = screen.getCursorScreenPoint();

    let target: BrowserWindow | null = null;
    for (const w of windows) {
      if (w.isDestroyed() || w.webContents.id === originWcId) continue;
      const b = w.getBounds();
      if (dip.x >= b.x && dip.x < b.x + b.width && dip.y >= b.y && dip.y < b.y + b.height) {
        target = w;
        break;
      }
    }

    // Let the origin's drag chip say "move here" (over a window) vs "new window".
    webContentsById(originWcId)?.send('tab:dragOverAck', { overWindow: !!target });

    // Moved off the previous destination (to another window, or to empty space) →
    // clear its now-stale preview first.
    if (target !== dragPreviewWin) clearTabDragPreview();
    if (!target) return;

    dragPreviewWin = target;
    const cb = target.getContentBounds();
    target.webContents.send('tab:dragPreview', {
      descriptor,
      clientX: Math.round(dip.x - cb.x),
      clientY: Math.round(dip.y - cb.y),
    });
  });

  // The cross-window drag ended (released or re-entered the source) - clear it.
  ipcMain.on('tab:dragEnd', (event) => {
    if (!isTrustedSender(event)) return;
    clearTabDragPreview();
  });

  // The renderer dropped its xterm for a shell it still owns (a hidden session
  // evicted from the mounted-workspace cache) and will re-attach later with a
  // FRESH xterm, which needs the scrollback replayed. A same-window re-create
  // normally skips the replay (the populated xterm would duplicate), so mark the
  // shell pending-owned by its own window: the next create then takes the adopt
  // path - rebind + replay - exactly like a cross-window transfer. Owner-guarded,
  // so a window can only ever request a replay of its own shells.
  ipcMain.on('terminal:requestReplay', (event, payload: { id?: unknown }) => {
    if (!isTrustedSender(event)) return;
    const id = payload?.id;
    if (!isNonEmptyStr(id)) return;
    // Owner-guarded AND transfer-safe: a released session's dock unmount requests
    // a replay for its command shells, but those may already be routed to the
    // window the session was torn off to - requestReplayForOwner won't steal them.
    requestReplayForOwner(id, event.sender.id);
  });

  // A whole session was dropped outside its window. A session always becomes its
  // OWN window (it never merges into another window's tabs), opened on the display
  // under the cursor. Pre-assign every existing shell to the new window so the
  // origin releasing the session can't kill one before the new window adopts it,
  // then tell the origin to let the session go.
  ipcMain.on('session:dropExternal', (event, payload: { descriptor?: unknown }) => {
    if (!isTrustedSender(event)) return;
    const originWcId = event.sender.id;
    const descriptor = payload?.descriptor;
    if (!isSessionDescriptor(descriptor)) return;
    const dip = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(dip).workArea;
    const width = 900;
    const height = 620;
    const x = Math.round(Math.min(Math.max(dip.x - 80, wa.x), wa.x + wa.width - width));
    const y = Math.round(Math.min(Math.max(dip.y - 18, wa.y), wa.y + wa.height - height));
    const win = createWindow({
      payload: { kind: 'session', session: descriptor },
      x,
      y,
      width,
      height,
    });

    // Only pre-assign shells this window actually owns, guarding against a
    // malformed/hostile layout. (No layout = the session was never opened here;
    // its eagerly-spawned shells are routed by id below.)
    const tabs = layoutTabs(descriptor.layout);
    if (tabs) {
      for (const tab of Object.values(tabs)) {
        if (tab && isNonEmptyStr(tab.ptyId) && isTerminalOwnedBy(tab.ptyId, originWcId)) {
          setPendingTerminalOwner(tab.ptyId, win.webContents.id);
        }
      }
    }
    // Shells outside the layout - the session's own, and the eager
    // conversation/setup shells of a never-opened session - are handed over by
    // id, so the new window adopts the still-running shells instead of them
    // being orphaned (or killed) in the origin.
    reassignSessionShells(descriptor.sessionId, originWcId, win.webContents.id);

    webContentsById(originWcId)?.send('session:removed', { sessionId: descriptor.sessionId });
  });

  // A detached session window reports its live layout so main always holds the
  // current one to hand back when the window closes.
  ipcMain.on('session:syncLayout', (event, payload: { sessionId?: unknown; layout?: unknown }) => {
    if (!isTrustedSender(event)) return;
    const sessionId = payload?.sessionId;
    if (!isNonEmptyStr(sessionId)) return;
    // Only the window actually hosting this torn-off session may report its
    // layout - another window can't overwrite (and have persisted) a session's
    // saved state on a guessed id.
    if (sessionWindowId(windowTable, sessionId) !== event.sender.id) return;
    // Only store a well-formed layout - returnSessionToOwner iterates its tabs.
    if (!layoutTabs(payload?.layout)) return;
    sessionLayouts.set(sessionId, payload.layout as SerializedLayout);
    // Persist it too, so a session torn off into its own window - whose in-app
    // surface is unmounted (released) and thus isn't saving - still restores its
    // tabs/splits after a quit. The in-app surface resumes saving once it returns.
    void saveLayout(sessionId, payload.layout);
  });

  // A detached tab window reports its live layout (terminals can be added/split
  // there) so main always holds the current set to hand back when the window
  // closes. Only windows created detached are tracked; anything else is ignored,
  // so a window can never enrol itself. Nothing is persisted - these windows
  // don't outlive the app.
  ipcMain.on('tab:syncLayout', (event, payload: { layout?: unknown }) => {
    if (!isTrustedSender(event)) return;
    const entry = detachedTabWindows.get(event.sender.id);
    if (!entry) return;
    // Only store a well-formed layout - returnDetachedTabsToMain iterates its tabs.
    if (!layoutTabs(payload?.layout)) return;
    entry.layout = payload.layout as SerializedLayout;
  });

  // Raise the window hosting a torn-off session (it may sit on another Space or
  // monitor) - the sidebar routes clicks on such a session here instead of
  // opening it locally.
  ipcMain.on('session:focusWindow', (event, payload: { sessionId?: unknown }) => {
    if (!isTrustedSender(event)) return;
    const sessionId = payload?.sessionId;
    if (!isNonEmptyStr(sessionId)) return;
    const win = sessionWindow(sessionId);
    if (win) raiseWindow(win);
  });

  // The app asked to pull a session back (e.g. from the "open elsewhere" placeholder):
  // close its window, which hands the session back via the 'close' handler above.
  ipcMain.on('session:bringBack', (event, payload: { sessionId?: unknown }) => {
    if (!isTrustedSender(event)) return;
    const sessionId = payload?.sessionId;
    if (!isNonEmptyStr(sessionId)) return;
    // Only the session's own window, the main window or the window hosting its
    // project may act on it.
    if (!maySettleSession(windowTable, event.sender.id, sessionId)) return;
    sessionWindow(sessionId)?.close();
  });

  // The app deleted a session that's open in its own window: close that window
  // destructively. Flagging it first makes the `close` handler skip the hand-back,
  // so the window keeps owning its shells and the `closed` handler kills them.
  ipcMain.on('session:destroy', (event, payload: { sessionId?: unknown }) => {
    if (!isTrustedSender(event)) return;
    const sessionId = payload?.sessionId;
    if (!isNonEmptyStr(sessionId)) return;
    if (!maySettleSession(windowTable, event.sender.id, sessionId)) return;
    const win = sessionWindow(sessionId);
    if (!win) return;
    destroyingSessions.add(sessionId);
    win.close();
  });

  // Project windows (a private plan): opening a project in its
  // own window and everything around it, plus the window-level asks every
  // full-chrome window makes (what lives elsewhere, the cleanup lease). The
  // module decides; this process owns the BrowserWindows it acts on.
  projectWindowIpc = registerProjectWindowIpc({
    table: windowTable,
    createProjectWindow: (descriptor, bounds) =>
      createWindow({ payload: { kind: 'project', project: descriptor }, ...bounds }).webContents.id,
    createMainWindow: () => void createWindow(),
    windowBounds: () => {
      const dip = screen.getCursorScreenPoint();
      const wa = screen.getDisplayNearestPoint(dip).workArea;
      const width = Math.min(1280, wa.width);
      const height = Math.min(800, wa.height);
      return {
        x: Math.round(Math.min(Math.max(dip.x - 80, wa.x), wa.x + wa.width - width)),
        y: Math.round(Math.min(Math.max(dip.y - 18, wa.y), wa.y + wa.height - height)),
        width,
        height,
      };
    },
    raise: (wcId) => {
      const win = windowOf(wcId);
      if (win) raiseWindow(win);
    },
    close: (wcId) => windowOf(wcId)?.close(),
    sendTo: webContentsById,
    isQuitting: () => isQuitting,
    terminal: {
      isTerminalOwnedBy,
      setPendingTerminalOwner,
      reassignSessionShells,
      reassignWindowShells,
    },
  });

  // Workspace terminal tabs: real shells via node-pty, hosted by the session
  // daemon so they outlive the app (a private plan) - or in
  // this process when no daemon can be started. The handlers queue behind the
  // daemon's answer, so the renderer's first creates find the live terminals.
  // The extension's ops are known before the first daemon frame is parsed.
  if (proMain.daemonProtocol) registerProtocolExtension(proMain.daemonProtocol);
  const localTerminalBackend = createTerminalBackend({
    daemon: createDaemonBackend({
      userData: app.getPath('userData'),
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      execPath: process.execPath,
      daemonEntry: join(__dirname, 'daemon.js'),
      log: (message) => console.log(`[session-daemon] ${message}`),
      // The extension's work in the daemon, beside its terminals: its own
      // flags, and a look at every daemon attached. A core build's daemon is
      // started with neither.
      extensionArgs: proMain.daemonArgs?.(app.getPath('userData')) ?? [],
      ...(proMain.onDaemonAttach ? { onAttach: proMain.onDaemonAttach } : {}),
    }),
    fallback: createInProcessBackend(),
    log: (message) => console.warn(`[session-daemon] ${message}`),
  });
  // Remote sessions (a private plan) - Pro since
  // a private plan › M7: every terminal goes through the
  // backend the hosts hand back (the host router - local ids to the backend
  // above, unchanged, a remote project's to that host's daemon over ssh).
  // Ready only once the remote project roots are read as well, so the first
  // creates never mistake a remote folder for a local one - in the core build
  // too, where a host's terminal is refused and never spawned here.
  // Each Pro slot's IPC answers ELOCKED while its feature is not entitled
  // (pro-ipc.ts), as `register`'s `ipcFor` does for the others.
  const gateFor = (feature: Feature): FeatureGate => ({
    ipc: featureIpc(ipcMain, () => proMain.entitled(feature)),
    entitled: () => proMain.entitled(feature),
  });
  const mainWebContents = (): WebContents | null => {
    for (const [wcId, record] of windowTable) {
      if (record.kind === 'main') return webContentsById(wcId);
    }
    return null;
  };
  const hostRootsRead = reloadHostRoots();
  const offProjectRows = onProjectRowsChanged(() => void reloadHostRoots());
  const remote =
    proMain.remoteHosts?.({
      gate: gateFor,
      localBackend: localTerminalBackend,
      hostRootsRead,
      mainWebContents,
      mainDir: __dirname,
    }) ?? localOnly(readyAfter(localTerminalBackend, hostRootsRead));
  const terminalBackend = remote.backend;
  const hosts = remote.hosts;
  isRemoteTerminalId = (id) => hosts.hostOfTerminal(id) !== null;
  // Every path under a remote project resolves to its host (spec 1.3): the
  // terminal spawn, and git / fs / the seed copy through host-runtime.ts -
  // never this machine's files under the same path, with or without Pro.
  setTerminalHostResolver(hostOfPathNow, hostRootsLoading, (hostId) =>
    hosts.status(hostId)?.facts?.platform?.startsWith('darwin') ? 'darwin' : 'linux',
  );
  // A remote project's session never spawns a shell on this machine (M4 review).
  // No remote project at all: nothing to look up (a local launch is untouched).
  setTerminalSessionHostResolver((sid) =>
    currentHostRoots().length > 0 ? sessionHostOf(sid) : null,
  );
  // A project added a moment ago: git / fs wait for its root, as a terminal
  // create does - resolved early, its folder would read as local.
  setRuntimeGate(hostRootsLoading);
  setRuntimeResolver((path) => {
    const hostId = hostOfPathNow(path ?? null);
    return hostId ? hosts.runtime(hostId) : localRuntime;
  });
  disposeHostsIpc = () => {
    offProjectRows();
    remote.dispose();
  };
  // A new terminal that starts the extension's work asks it whether that
  // feature is entitled now.
  setTerminalEntitlement(proMain.terminalFeatures ?? [], (feature) => proMain.entitled(feature));
  // The extension's status line in this machine's agents, and what reads its
  // captures - before the first spawn. A capture of a pty the session daemon
  // kept running stays.
  const statusLine = proMain.statusLine?.({
    gate: gateFor,
    hosts,
    windows: () => windows,
    liveTerminalIds: () => terminalBackend.ready().then(() => liveTerminalIds()),
  });
  setTerminalStatusLine(statusLine?.statusLine ?? null);
  disposeStatusLine = () => statusLine?.dispose();
  disposeTerminals = registerTerminalIpc(terminalBackend);
  // The extension's runtime sessions: their agents follow the terminals (in
  // the session daemon when it won, else here).
  runtimeSessions =
    proMain.runtimeSessions?.({
      gate: gateFor,
      terminalBackend,
      hosts,
      mainWebContents,
      isMainWindow: (wcId) => windowTable.get(wcId)?.kind === 'main',
    }) ?? NO_RUNTIME_SESSIONS;
  disposeRuntimeSessions = () => runtimeSessions.dispose();
  disposeSessionDaemonIpc = registerSessionDaemonIpc(terminalBackend, {
    // The once-ever "sessions kept running" notice goes to the main window only.
    isMainWindow: (wcId) => windowTable.get(wcId)?.kind === 'main',
    // Settings › Sessions › Stop all: the tabs hear their shells exit, then
    // the backend kills them (a bare backend killAll tells no window anything).
    // Runtime agents stop with them.
    stopAll: async (hostId) => {
      // That machine's runtime agents too (a host's run in its daemon, plan 29 › M6).
      await runtimeSessions.stopAllOn(hostId ?? null);
      return stopAllTerminals(hostId);
    },
    daemons: daemonOverview,
    moveDaemon: moveDaemonTerminals,
  });
  // What the quit confirm counts: every live terminal main knows, owned or not.
  void terminalBackend.ready().then(() => {
    terminalsKnown = true;
  });
  busyTerminals = async () => {
    // A quit before the daemon list landed waits for it (capped).
    await Promise.race([terminalBackend.ready(), new Promise((r) => setTimeout(r, 4000))]);
    // Windows asks a PowerShell whether a plain shell runs a program
    // (win-children.ts): a cold one needs longer than the default cap.
    // This machine's terminals: a quit never stops a remote host's (spec 16).
    const local = liveTerminalIds().filter((id) => !hosts.hostOfTerminal(id));
    const counts = await countBusyTerminals(local, terminalBackend, {
      timeoutMs: process.platform === 'win32' ? 4000 : undefined,
    });
    // Runtime agents mid-turn or blocked on the user end with a stopping quit too.
    const busyRuntimesNow = runtimeSessions.busy();
    // Remote terminals are never stopped by a quit - only named (spec 16).
    const remote = new Map<string, number>();
    for (const id of liveTerminalIds()) {
      const hostId = hosts.hostOfTerminal(id);
      if (hostId) remote.set(hostId, (remote.get(hostId) ?? 0) + 1);
    }
    return {
      ...counts,
      working: counts.working + busyRuntimesNow.working,
      waiting: counts.waiting + busyRuntimesNow.waiting,
      remote: [...remote].map(([hostId, terminals]) => ({
        label: hosts.label(hostId) ?? hostId,
        terminals,
      })),
    };
  };
  // Sessions the database still calls busy without a single live terminal
  // are stuck - nothing would ever report them idle (crash-recovery.ts).
  void terminalBackend.ready().then(() =>
    // This machine's sessions only: a remote project's statuses stand until
    // its host answers (stale-sessions.ts › the host filter).
    sweepStaleSessions(liveTerminalIds(), { hostId: null })
      .then(
        (reset) => {
          if (reset.length > 0)
            console.log(`[session-daemon] reset ${reset.length} stale busy session(s)`);
        },
        (err) => console.warn('[session-daemon] stale-session sweep failed:', err),
      )
      // Then the runtime sessions: the sweep above only knows terminals (the
      // extension sets theirs back to what their agents do).
      .then(() => runtimeSessions.afterSessionSweep()),
  );

  // Embedded local database (PGlite) + its IPC bridge. Opening since module load
  // (startDb above); this only restarts it if that open already failed.
  void getDb().catch(() => undefined);
  // The extension's tables join the bridge before any renderer message.
  registerTables(proMain.db?.tables ?? {});
  disposeDb = registerDbIpc(proMain.db?.cascade);
  // Seed the dock/taskbar status dot from whatever sessions were left running or
  // waiting last run; it then tracks live status changes via db:ipc broadcasts.
  refreshSessionBadge();
  disposeLayoutIpc = registerLayoutIpc();

  // Filesystem bridge for the workspace file explorer + editor.
  disposeFsIpc = registerFsIpc();

  // Cross-project file index for the Search Everywhere palette.
  // A remote project's files are walked on its host (plan 29 spec › 5.2).
  disposeSearchIpc = registerSearchIpc({
    hosts: {
      state: (hostId) =>
        hosts.status(hostId)?.state !== 'connected'
          ? 'down'
          : hosts.supports(hostId, 'index')
            ? 'index'
            : 'old',
      index: (hostId, root, max) => hosts.call(hostId, 'fsIndex', { root, max }),
      onTreeChange: (listener) =>
        hosts.onOpEvent((hostId, ev) => {
          if (ev.type !== 'fs-changed') return;
          const watch = hosts.runtime(hostId).remote?.watchRoot?.(ev.watchId);
          if (!watch || watch.kind !== 'tree') return;
          listener(
            hostId,
            ev.paths.map((p) => (p === '*' || p === '' ? watch.root : posix.join(watch.root, p))),
          );
        }),
    },
    broadcast: () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('search:indexChanged');
      }
    },
  });

  // `browser:previewUrl` is core's: the editor's file preview loads through it.
  disposeBrowserIpc = registerPreviewIpc();
  // The extension's page tabs and the agent tools that drive them: the tab IPC,
  // the agents' socket, every terminal's tools, a host's relayed requests.
  const browserTabs = proMain.browser?.({
    gate: gateFor,
    hosts,
    runtimeSessions,
    sessionWindows: (sessionId) =>
      sessionWindowsInOrder(windowTable, sessionId)
        .map((wcId) => webContentsById(wcId))
        .filter((wc): wc is WebContents => wc !== null),
  });
  disposeAgentBrowser = () => browserTabs?.dispose();

  // Git bridge for the workspace's git surfaces.
  disposeGitIpc = registerGitIpc({
    // A copy from this computer refuses build output across platforms (plan 29 spec › 9.2).
    hostPlatform: (hostId) => hosts.status(hostId)?.facts?.platform ?? null,
  });

  // Everything Pro registers in main (a private plan):
  // nothing in the core build. Synchronous, like every registration here.
  proRegistration = proMain.register({
    userData: app.getPath('userData'),
    appVersion: app.getVersion(),
    ipcFor: (feature) => featureIpc(ipcMain, () => proMain.entitled(feature)),
    hostPlatformOf: (root) => {
      const hostId = hostOfPathNow(root);
      if (!hostId) return null;
      return hosts.status(hostId)?.facts?.platform?.startsWith('darwin') ? 'darwin' : 'linux';
    },
    windows: () => windows,
    mainWindow,
    // "Restart to update" (the extension's) closes every window BEFORE
    // `before-quit`: raise the quitting flag first, so closing torn-off windows
    // don't hand their sessions to an app window that is closing too and a Dock
    // click can't rebuild one mid-restart. Lower it when a window refused
    // (unsaved edits - the app keeps running), and bring the app window back
    // when Squirrel.Mac failed after every window was already gone.
    restart: {
      onPhase: (phase) => {
        if (phase === 'start') {
          // The confirm's answer takes effect only now, as the restart really
          // begins: raised in `confirmRestart` itself, a restart the extension
          // then called off (the staged update gone meanwhile) left them
          // raised, and the next plain quit skipped its own confirm.
          quitConfirmed = true;
          if (restartKeepsSessionsOnce) quitKeepsSessionsOnce = true;
          isQuitting = true;
          return;
        }
        // Aborted or failed: the app keeps running, and the next quit asks afresh.
        resetQuitIntent();
        if (phase === 'failed' && !mainWindow()) createWindow();
      },
      // A restart is a quit: with the Keep-running switch off it asks like one
      // (keep this once / stop / cancel) - before the windows close, since a
      // closing window kills the shells it owns when sessions are set to stop.
      confirm: async () => {
        const decision = await confirmQuit('restart');
        if (decision === 'cancel') return false;
        restartKeepsSessionsOnce = decision === 'keep-once';
        return true;
      },
    },
    // "Quit and Stop All Sessions", then start again: the confirm asks only
    // while something is busy, and offers no way to keep them.
    restartStoppingSessions: async (beforeRelaunch, onAborted) => {
      if (isQuitting || quitConfirmOpen || relaunchOnQuit.held()) return false;
      quitStopsSessions = true;
      const decision = await confirmQuit('restart');
      if (decision === 'cancel') {
        resetQuitIntent();
        return false;
      }
      // Held, not run: a window may still refuse to close (unsaved edits),
      // and then nothing may have happened (relaunch-on-quit.ts).
      relaunchOnQuit.arm({ beforeRelaunch, onAborted });
      quitConfirmed = true;
      // On a later macrotask, as before-quit does after its own answer.
      setImmediate(() => app.quit());
      return true;
    },
  });
  // Windows/Linux cold start via deep link: the URL arrives in our own argv.
  // After Pro registered, so a link it understands finds its handler.
  const coldStartUrl = findAppLink(process.argv, DESKTOP_PROTOCOL_SCHEME);
  if (coldStartUrl) handleDeepLink(coldStartUrl);

  disposeEditorsIpc = registerEditorsIpc();
  // Settings › General › Open-source licences.
  disposeNoticesIpc = registerThirdPartyNoticesIpc();
  // Language-server bridge for the Monaco file editor. A host root's server
  // runs on the host (plan 29 › M9) - never spawned here.
  disposeLanguageServersIpc = registerLanguageServersIpc({
    hosts: {
      hostOf: (path) => hostOfPathNow(path),
      target: (hostId) => {
        const status = hosts.status(hostId);
        if (!status) return null;
        const platform = status.facts?.platform ?? null;
        return {
          hostId,
          label: hosts.label(hostId) ?? hostId,
          platform: platform?.startsWith('darwin')
            ? 'darwin'
            : platform?.startsWith('linux')
              ? 'linux'
              : null,
          supports: () => hosts.supports(hostId, 'lsp'),
          connected: () => hosts.status(hostId)?.state === 'connected',
          call: (op, args) => hosts.call(hostId, op, args),
          cast: (op, args) => hosts.cast(hostId, op, args, 'lsp'),
          onEvent: (listener) =>
            hosts.onOpEvent((id, ev) => {
              if (id === hostId)
                listener(ev as unknown as { type: string } & Record<string, unknown>);
            }),
          onDisconnected: (listener) => hosts.onDisconnected(hostId, listener),
          root: () => hosts.root(hostId),
          runtime: () => hosts.runtime(hostId),
          putTransfer: (body) => hosts.putTransfer(hostId, body),
        };
      },
    },
  });

  // Wake from sleep / screen unlock: a GPU-process reset across sleep can lose
  // the WebGL context under xterm and leave a visible terminal painting solid
  // black, and the `webglcontextlost` event isn't reliably delivered across
  // sleep - so xterm's own fallback never fires. Nudge every window to re-cycle
  // its terminal renderers when the OS reports the machine is back.
  const broadcastSystemResume = (): void => {
    for (const w of windows) {
      if (!w.isDestroyed()) w.webContents.send('system:resume');
    }
  };
  powerMonitor.on('resume', broadcastSystemResume);
  powerMonitor.on('unlock-screen', broadcastSystemResume);

  // The OS is logging out, restarting or shutting down (macOS posts it as the
  // logout is requested, before the quit Apple event; Linux through logind).
  // The quit that follows is the system's: it passes with the Keep-running
  // setting as it stands and is never held for the confirm. On Linux the app
  // must quit itself or be killed with the session (Electron's own pattern
  // for this event); macOS asks every app to quit in its own time, and
  // another app may still cancel the logout, so nothing is quit here.
  powerMonitor.on('shutdown', () => {
    noteSystemEnding('powerMonitor shutdown');
    if (process.platform === 'linux' && !isQuitting) app.quit();
  });

  app.on('activate', () => {
    // A reopen while the app is tearing down (Dock Quit: windows gone, IPC
    // disposed, DB closing) must not build a window - it would sit on
    // "Loading..." with no handlers left to answer it.
    if (isQuitting) return;
    // Recreate the app window whenever it's missing - not only when NO windows
    // remain. Closing the app window while torn-off session windows stay open
    // previously left the dock click doing nothing (and sessions with no window
    // to return to).
    if (!mainWindow()) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Once quitting, a closing session window shouldn't try to hand its session back
// (everything is going away; `will-quit` then stops the shells or leaves them to
// the daemon). A quit that would END the daemon's terminals - the menu item, or
// the Keep-running switch off - is held here while main asks whether anything
// is busy (quit-confirm.ts), then re-issued with the same intent. Held, not just
// asked: Electron closes every window right after `before-quit`, and a closing
// window kills the shells it owns on such a quit - they must stay open until the
// user has answered.
app.on('before-quit', (event) => {
  // Held only when there is something to ask about: the hold is a
  // `preventDefault`, which macOS takes as a refusal and cancels the logout or
  // shutdown that started the quit - a stopping quit with no live terminal,
  // or one the OS asked for (`systemEnding`), must pass like any other
  // (quit-confirm.ts › quitMayNeedConfirm).
  if (quitConfirmed || (!quitMayNeedConfirm(quitIntent(), quitContext()) && !runtimesDieOnQuit())) {
    quitConfirmed = true;
    isQuitting = true;
    return;
  }
  event.preventDefault();
  if (quitConfirmOpen) return;
  void confirmQuit('quit').then((decision) => {
    if (decision === 'cancel') {
      resetQuitIntent();
      return;
    }
    if (decision === 'keep-once') quitKeepsSessionsOnce = true;
    quitConfirmed = true;
    // On a later macrotask, as quit-sequence.ts does: the dialog's answer is a
    // native callback, and an `app.quit()` issued in its microtask drain is
    // dropped when the quit started natively (Dock Quit, logout).
    setImmediate(() => app.quit());
  });
});

// Quit in two passes: first dispose terminals + close the embedded DB cleanly (so
// the PGlite data dir is flushed and not left "crashed" with a stale
// postmaster.pid), then let the app actually exit. `createWillQuitHandler` owns
// the sequence, including the rule that is easy to lose: the re-issued
// `app.quit()` runs on a later macrotask, never in the microtask drain of the
// `will-quit` emit - a Dock Quit otherwise leaves a windowless zombie (see
// quit-sequence.ts).
app.on(
  'will-quit',
  createWillQuitHandler({
    dispose: () => {
      // Every window is gone: the quit can no longer be called off, so a
      // restart the extension asked for runs now.
      relaunchOnQuit.commit();
      // Default: let go of the shells - the session daemon keeps them for the
      // next launch. Stopping (the Keep-running switch off, or "Quit and Stop
      // All Sessions") kills them and resolves once they have reported their
      // exit - quitting before that aborts the process (see PtyHost.killAll).
      const shellsGone = disposeTerminals?.({ stopSessions: quitStopsTerminals() });
      disposeSessionDaemonIpc?.();
      disposeHostsIpc?.();
      disposeRuntimeSessions?.();
      disposeDb?.();
      disposeLayoutIpc?.();
      disposeFsIpc?.();
      disposeSearchIpc?.();
      disposeBrowserIpc?.();
      disposeAgentBrowser?.();
      disposeGitIpc?.();
      proRegistration?.dispose?.();
      disposeEditorsIpc?.();
      disposeNoticesIpc?.();
      disposeStatusLine?.();
      disposeLanguageServersIpc?.();
      projectWindowIpc?.dispose();
      return shellsGone;
    },
    closeDb,
    requestQuit: () => app.quit(),
  }),
);
