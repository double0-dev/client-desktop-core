import { app, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { spawn } from '@homebridge/node-pty-prebuilt-multiarch';
import { isTrustedSender } from './ipc-util';
import type { AgentStatus } from './terminal-modes';
import {
  claudeSessionIdForPty,
  claudeSessionRecordPath,
  claudeSessionRecordsDir,
  codexSessionRecordsDir,
  forgetClaudeSession,
  forgetCodexSession,
  forgetOpencodeSession,
  opencodeSessionRecordsDir,
  recordedClaudeSessionId,
  recordedOpencodeSessionId,
} from './agent-resume';
import { MAX_NOTED_LINE, type HostSpawnRequest, type PtySpawner } from './pty-host';
import { planLaunch } from './launch-plan';
import {
  createLaunchMaterializer,
  type AgentStatusLine,
  type LaunchMaterializer,
  type MaterializeDeps,
} from './launch-materialize';
import { InProcessBackend, type BackendEvent, type TerminalBackend } from './terminal-backend';
import type { AgentTerminal } from './agent-screen/agent-terminal';
import { ScreenMirrors } from './agent-screen/screen-mirror';
import { ScreenDialogWatch } from './agent-screen/screen-dialog-watch';
import {
  MOVE_CHECK_MS,
  autoMovable,
  daemonRows,
  isBusy,
  neverMovesByItself,
  olderBuildIds,
  trackIdle,
  wouldLoseConversation,
  type DaemonRow,
  type MoveProbe,
} from './daemon-migrate';
import { parseSignIn, remoteSpawnPlanner, signInFlow } from './remote-terminals';
import type { Feature } from './extension';
import type { SignInAgentId } from './agent-table';
import { sessionShellPrefix } from './session-shells';

/**
 * The workspace terminals' window side: which window each terminal belongs
 * to, where its output goes, and the IPC the renderer speaks - with
 * cross-window transfer. The terminals themselves (the pty, the replay ring,
 * the mode tracker, the input log) live behind a `TerminalBackend`: in this
 * process (pty-host.ts), or in the session daemon that keeps them running
 * after the app quits (daemon/, a private plan).
 *
 * Each terminal's output is sent to a MUTABLE `target` WebContents (read fresh on
 * every chunk), so a shell can be moved to another window without dying. The
 * backend keeps recent output in a capped ring buffer and REPLAYS it when a
 * different window adopts the terminal (its fresh xterm then shows the current
 * screen). `create` doubles as "adopt": calling it for an id that already exists
 * rebinds output to the caller - but ONLY if a transfer was routed to it
 * (pendingOwnerWcId) or the owning window is gone (orphan recovery - which is
 * also how a terminal found live in the daemon after a restart is picked up);
 * the same window re-attaching (StrictMode remount) is a no-op so its populated
 * xterm isn't duplicated, and any other window's attempt is ignored.
 * input/resize/dispose are likewise only honored from the terminal's owner (or
 * routed adopter).
 */

type SpawnOptions = {
  id: string;
  /** Working directory; falls back to the user's home dir. */
  cwd?: string | null;
  cols?: number;
  rows?: number;
  /**
   * Command to auto-run once, the first time this shell spawns - e.g. `claude`
   * for a Claude Code session. Run *inside* the shell so it isn't echoed as
   * typed input; ignored on adopt / cross-window transfer.
   */
  initialCommand?: string;
  /**
   * Start the shell with integration (shell-integration.ts) so its commands
   * reach the Inputs list - Settings › Terminal. Anything but `false` = on.
   */
  shellIntegration?: boolean;
};

/**
 * Main's record of a live terminal: who owns it and where its output goes. No
 * pty state - that is the backend's (`PtyHost`). `target` is null for a
 * terminal nobody owns: one found live in the daemon at startup, waiting for
 * the window that restores its tab to adopt it.
 */
type Routed = {
  /** WebContents currently receiving this terminal's output; null = ownerless. */
  target: WebContents | null;
  /** webContents.id of the owning window - used to clean up only ITS terminals. -1 = ownerless. */
  ownerWcId: number;
  /**
   * Set while this terminal is mid-transfer to another window (tear-off / merge):
   * its webContents.id. Until that window adopts it, the current owner closing
   * must NOT kill it, and that window's `create` is the awaited cross-window
   * adopt (replay) rather than a same-window re-attach.
   */
  pendingOwnerWcId?: number;
  /**
   * An adopt's snapshot is in flight: chunks arriving meanwhile are already in
   * the ring the snapshot carries, so they are dropped, not forwarded.
   */
  adopting: boolean;
  /** Output accumulated since the last batched IPC flush (see `flushOutput`). */
  pending: string[];
  pendingChars: number;
  flushTimer: NodeJS.Timeout | null;
};

const terminals = new Map<string, Routed>();
/** The owner id of a terminal no window owns (see `Routed.target`). */
const NO_OWNER = -1;
/**
 * Spawns in flight (createOrAdopt awaits the cwd check before spawning), keyed
 * by id → creator's webContents.id. The entry is the claim ticket: a dispose
 * (or window close) during the await removes it, cancelling the spawn, and a
 * concurrent duplicate create finds it and bails - so the async gap can't leak
 * an orphan PTY.
 */
const creating = new Map<string, number>();
/**
 * Grid a renderer asked for while its shell was still being spawned, applied the
 * moment the PTY exists.
 *
 * `createOrAdopt` awaits the cwd check before spawning, and everything that
 * arrives for the id during that gap has no PTY to act on: a `terminal:resize`
 * finds nothing in `terminals`, and a second `create` (the view mounting while
 * the session's eager launch spawn is still in flight) bails on the `creating`
 * claim ticket. Dropping those left the shell on the spawn's default 80×24 with
 * the renderer's xterm at its fitted grid and NOTHING left to reconcile them -
 * the container never resizes again, so the TUI drew 80×24 frames into a
 * 167×44 terminal forever. Remembering the last requested size closes that gap.
 */
const pendingSizes = new Map<string, { cols: number; rows: number }>();
/**
 * Output batching: a PTY under load emits hundreds of small chunks per second,
 * and forwarding each as its own IPC message hammers the renderer with wakeups
 * (×10 when many terminals stream at once). Chunks accumulate per terminal and
 * flush as ONE message after FLUSH_MS - or immediately past FLUSH_CAP chars, so
 * a flood doesn't sit in main growing unboundedly.
 */
const FLUSH_MS = 5;
const FLUSH_CAP = 64 * 1024;

/**
 * Where a spawn's plan becomes the files and the request the backend runs
 * (launch-materialize.ts) - in this process for now; the session daemon on a
 * remote host runs the same code (a private plan › M0).
 */
let materializer: LaunchMaterializer | null = null;
/** The extension's agent tools in every terminal (setTerminalAgentTools). */
let agentTools: MaterializeDeps['agentTools'] | undefined;
/** The extension's status line for this machine's terminals (setTerminalStatusLine). */
let statusLine: TerminalStatusLine | null = null;
const materializerOf = (): LaunchMaterializer =>
  (materializer ??= createLaunchMaterializer({
    recordsRoot: () => app.getPath('userData'),
    ...(statusLine ? { statusLine } : {}),
    ...(agentTools ? { agentTools } : {}),
  }));

/** An extension's status line here, and how its capture of a pty that is gone goes. */
export type TerminalStatusLine = AgentStatusLine & { forget: (ptyId: string) => void };

/**
 * An extension's status line for this machine's terminals
 * (launch-materialize.ts › AgentStatusLine). Unset = none (the core build):
 * no status line is injected and no capture made. Takes effect from the next
 * spawn.
 */
export function setTerminalStatusLine(next: TerminalStatusLine | null): void {
  statusLine = next;
  materializer = null;
}

/**
 * An extension's agent tools for this machine's terminals: a launcher on PATH,
 * its env, its instructions named in the agents' settings. Unset = none (the
 * core build). Takes effect from the next spawn.
 */
export function setTerminalAgentTools(next: MaterializeDeps['agentTools'] | null): void {
  agentTools = next ?? undefined;
  materializer = null;
}

/**
 * Record a grid requested for a shell that is still being spawned (see
 * `pendingSizes`) - only from the window that owns the in-flight spawn, so a
 * stale id from another window can't preset someone else's terminal.
 */
function rememberPendingSize(id: string, wcId: number, cols?: number, rows?: number): void {
  if (typeof cols !== 'number' || typeof rows !== 'number' || cols <= 0 || rows <= 0) return;
  if (creating.get(id) !== wcId) return;
  pendingSizes.set(id, { cols, rows });
}

/** Whether a record's window is gone (or it never had one). */
function targetGone(m: Routed): boolean {
  return m.target === null || m.target.isDestroyed();
}

/** The window to send to, or null (ownerless, or its window is gone). */
function targetOf(m: Routed): WebContents | null {
  return m.target && !m.target.isDestroyed() ? m.target : null;
}

function clearPending(m: Routed): void {
  if (m.flushTimer) {
    clearTimeout(m.flushTimer);
    m.flushTimer = null;
  }
  m.pending.length = 0;
  m.pendingChars = 0;
}

/** Send everything accumulated since the last flush as one IPC message. */
function flushOutput(id: string, m: Routed): void {
  if (m.pending.length === 0) {
    clearPending(m);
    return;
  }
  const data = m.pending.length === 1 ? m.pending[0] : m.pending.join('');
  clearPending(m);
  targetOf(m)?.send('terminal:data', { id, data });
}

function newRecord(target: WebContents | null): Routed {
  return {
    target,
    ownerWcId: target ? target.id : NO_OWNER,
    adopting: false,
    pending: [],
    pendingChars: 0,
    flushTimer: null,
  };
}

/** Each Claude terminal's screen, kept here for session status and a following view (agent-screen/screen-mirror.ts). */
const screens = new ScreenMirrors();

/**
 * A Claude waiting on a dialog no hook reports (new MCP servers, the folder's
 * trust) reads as waiting, not idle: the markers its hooks never send, put
 * into the window's stream (agent-screen/screen-dialog-watch.ts).
 */
const screenDialogs = new ScreenDialogWatch({
  lines: (id) => screens.lines(id),
  status: async (id) => (await backendOf().agentStatus([id]))[0]?.status ?? null,
  inject: (id, data) => {
    const m = terminals.get(id);
    if (!m || m.adopting || targetGone(m) || !targetOf(m)) return false;
    m.pending.push(data);
    m.pendingChars += data.length;
    flushOutput(id, m);
    return true;
  },
});

/** Whether a terminal runs on a remote host (the router routes it there). */
function isRemoteTerminal(id: string): boolean {
  return !!backend?.hostOf?.(id);
}

/**
 * What a terminal's output feeds besides its window - the dev-server
 * detector (Pro since a private plan › M5,
 * the official build). Every chunk of a terminal main routes, owned
 * or not; the adopt replay with the window it goes to; and the end (an exit,
 * or a tab close - `window` is null then: nobody is told).
 */
export type TerminalOutputTap = {
  data?(id: string, data: string): void;
  adopted?(id: string, replay: string, window: WebContents): void;
  gone?(id: string, window: WebContents | null): void;
};
const taps = new Set<TerminalOutputTap>();

export function addTerminalTap(tap: TerminalOutputTap): () => void {
  taps.add(tap);
  return () => taps.delete(tap);
}

/** Whether window `wcId` drives terminal `id` (owns it, or is about to). */
export function terminalDrivenBy(id: string, wcId: number): boolean {
  const m = terminals.get(id);
  return !!m && (m.ownerWcId === wcId || m.pendingOwnerWcId === wcId);
}

/** Whether main routes terminal `id`. */
export function hasTerminal(id: string): boolean {
  return terminals.has(id);
}

/** Every terminal main routes now. */
export function routedTerminalIds(): string[] {
  return [...terminals.keys()];
}

/** Send to the window that shows terminal `id`, if any. */
export function sendToTerminalWindow(id: string, channel: string, payload: unknown): void {
  const m = terminals.get(id);
  if (m) targetOf(m)?.send(channel, payload);
}

/** The host terminal `id` runs on; null for this machine's. */
export function terminalHostOf(id: string): string | null {
  return backend?.hostOf?.(id) ?? null;
}

/**
 * The shell pid of every terminal on this machine whose backend reports one
 * (an older daemon's do not) - an extension asks which terminal's program
 * listens on a port.
 */
export async function localShellPids(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!backend) return out;
  for (const t of await backend.list()) {
    if (t.pid !== undefined && terminalHostOf(t.id) === null) out.set(t.id, t.pid);
  }
  return out;
}

/** Type into terminal `id` (a line the table names - never a caller's). */
export function typeIntoTerminal(id: string, data: string): void {
  backendOf().input(id, data);
}

/** Resolves once the backend knows its terminals (the handlers' gate). */
export function terminalsReady(): Promise<void> {
  return backendOf().ready();
}

/** Tab closes (a renderer dispose), for whoever follows a tab by its pty id. */
const closedListeners = new Set<(id: string) => void>();

export function onTerminalClosed(listener: (id: string) => void): () => void {
  closedListeners.add(listener);
  return () => closedListeners.delete(listener);
}

/**
 * What an extension's view over a Claude tab drives the tab
 * through: the same input path a keystroke takes, and the backend's view of
 * what runs in it.
 */
export function agentTerminal(): AgentTerminal {
  return {
    exists: (id) => terminals.has(id),
    // The window showing the terminal (the same rule as typing in it).
    mayDrive: (id, wcId) => {
      const m = terminals.get(id);
      return !!m && (m.ownerWcId === wcId || m.pendingOwnerWcId === wcId);
    },
    input: (id, data) => backendOf().input(id, data),
    foregroundBusy: (id) => backendOf().foregroundBusy(id),
    agentStatus: async (id) => (await backendOf().agentStatus([id]))[0]?.status ?? null,
    screen: (id) => screens.lines(id),
    screenSettled: (id) => screens.settled(id),
    // In-process terminals: mirror from what main saw of it (the adopt
    // snapshot and the output since) - a Claude still at its trust dialog
    // has sent no marker that would start the copy.
    follow: (id) => screens.followTail(id),
  };
}

/**
 * Which machine a terminal's folder belongs to (hosts/host-roots.ts), null =
 * this one. Set by index.ts once remote hosts are wired; until then, and for
 * every folder outside a remote project, terminals are local - exactly as
 * before (a private plan › M1).
 */
let hostResolver: (cwd: string | null | undefined) => string | null = () => null;
/** A read of the remote roots in flight (a project just added), or null. */
let hostRootsPending: () => Promise<unknown> | null = () => null;
/** A host's OS as its last probe said (`linux` until known - a host is never Windows). */
let hostPlatformOf: (hostId: string) => NodeJS.Platform = () => 'linux';

/** Whether a host's daemon offers the extension's agent tools. */
let hostHasAgentTools: (hostId: string) => boolean = () => false;

export function setTerminalHostAgentTools(fn: (hostId: string) => boolean): void {
  hostHasAgentTools = fn;
}

/**
 * Terminal ids that start the extension's work, by the feature they need
 * (`MainExtension.terminalFeatures`). A new one is refused while its feature
 * is not entitled - a renderer cannot start that work by naming the id.
 */
let entitledTerminals: readonly (readonly [prefix: string, feature: Feature])[] = [];

/** The feature a new terminal of this id needs, if it is the extension's work. */
export function terminalFeature(id: string): Feature | null {
  return entitledTerminals.find(([prefix]) => id.startsWith(prefix))?.[1] ?? null;
}

/** Whether a feature may run now - `MainExtension.entitled`; nothing is, until set. */
let featureEntitled: (feature: Feature) => boolean = () => false;

export function setTerminalEntitlement(
  terminals: readonly (readonly [prefix: string, feature: Feature])[],
  fn: (feature: Feature) => boolean,
): void {
  entitledTerminals = terminals;
  featureEntitled = fn;
}

/** Whether a host is in the store (a sign-in terminal names its host by id). */
let signInHostKnown: (hostId: string) => boolean = () => false;

export function setTerminalSignInHosts(fn: (hostId: string) => boolean): void {
  signInHostKnown = fn;
}

/**
 * The agent whose login last ran in each host agent terminal - its pages
 * are the ones "Open sign-in page" may open (plan 30). Set by the terminal's
 * kind and by every login typed from the dialog; an install sets nothing.
 */
const signInAgents = new Map<string, SignInAgentId>();

/** The agent a host sign-in terminal signs in (its login started or was typed). */
export function signInAgentOf(id: string): SignInAgentId | null {
  return signInAgents.get(id) ?? null;
}

export function setSignInAgent(id: string, agent: SignInAgentId): void {
  signInAgents.set(id, agent);
}

export function setTerminalHostResolver(
  fn: (cwd: string | null | undefined) => string | null,
  pending: () => Promise<unknown> | null = () => null,
  platformOf: (hostId: string) => NodeJS.Platform = () => 'linux',
): void {
  hostResolver = fn;
  hostRootsPending = pending;
  hostPlatformOf = platformOf;
}

/**
 * The remote host a session's project lives on, by the session id a terminal
 * id carries (`conversation:` / `setup:` / `commands:<sid>:`), null for a
 * local one or an id that names no session. Set by index.ts (a projects /
 * sessions read); unset, nothing changes.
 */
let sessionHostResolver: ((sessionId: string) => Promise<string | null> | null) | null = null;

/** `fn` answers null (not a promise) when nothing needs checking - no remote project at all. */
export function setTerminalSessionHostResolver(
  fn: ((sessionId: string) => Promise<string | null> | null) | null,
): void {
  sessionHostResolver = fn;
}

const SESSION_ID_IN_PTY =
  /^(?:conversation|setup|commands):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::|$)/i;

/** The session id a terminal id names, or null (a "+" tab's bare uuid names none). */
export function sessionIdOfPty(ptyId: string): string | null {
  return SESSION_ID_IN_PTY.exec(ptyId)?.[1]?.toLowerCase() ?? null;
}

/**
 * Remote terminals whose host is unreachable right now: the window keeps the
 * last screen under an "Unreachable - reconnecting" overlay - never an exit
 * (spec 9.4). A window that adopts such a terminal later is told too.
 */
const unreachableSince = new Map<string, { hostId: string; since: number }>();

/** The backend main drives; set by registerTerminalIpc. */
let backend: TerminalBackend | null = null;
const backendOf = (): TerminalBackend => {
  if (!backend) throw new Error('terminal IPC not registered');
  return backend;
};

/**
 * Point a terminal's output at `sender` and replay its recent buffer to it.
 * The snapshot is a round trip to the backend: chunks that land meanwhile are
 * already inside it (the ring is read at the backend when it handles the
 * adopt, and events after that follow the reply), so they are dropped here
 * rather than sent twice.
 */
async function adopt(m: Routed, id: string, sender: WebContents): Promise<void> {
  // Unflushed output is already in the ring - drop it, or the next flush
  // would re-send what the replay below contains.
  clearPending(m);
  m.target = sender;
  m.ownerWcId = sender.id;
  m.adopting = true;
  const away = unreachableSince.get(id);
  if (away && !sender.isDestroyed()) sender.send('terminal:unreachable', { id, ...away });
  const snapshot = await backendOf().adopt(id);
  m.adopting = false;
  if (!snapshot || terminals.get(id) !== m) return;
  // The whole screen so far, for the view's copy of it (screen-mirror.ts).
  screens.snapshot(id, snapshot.data, snapshot.cols, snapshot.rows);
  // The taps read the replay ring too (the dev servers a terminal that lived
  // on in the daemon announced before this run of main).
  if (!sender.isDestroyed()) for (const tap of taps) tap.adopted?.(id, snapshot.data, sender);
  // Sent even with an empty buffer: `replaySize` tells the adopting renderer
  // the PTY's real grid, so a fresh xterm still at its construction default
  // (a hidden tab that can't fit yet) sizes itself before any output lands -
  // otherwise the replay and the repaint garble at the wrong width.
  if (!sender.isDestroyed()) {
    sender.send('terminal:data', {
      id,
      data: snapshot.data,
      replaySize: { cols: snapshot.cols, rows: snapshot.rows },
    });
  }
  // The Inputs list too, whole: a window asks for it once per pty, and that
  // ask is answered empty while a host is away or still connecting at launch
  // (the router has no backend for the id yet), and a rebuilt xterm (back
  // from unreachable) forgot the list it had. Every adopt is where the window
  // gets the terminal back, so the list comes with it. Not awaited: a host's
  // answer is a round trip, and the terminal FIFO must not wait on it.
  void backendOf()
    .inputList(id)
    .then((entries) => {
      if (entries.length > 0 && terminals.get(id) === m && !sender.isDestroyed()) {
        sender.send('terminal:inputs', { id, entries });
      }
    })
    .catch(() => {});
}

async function createOrAdopt(sender: WebContents, opts: SpawnOptions): Promise<void> {
  // A remote project added a moment ago: its root is still being read, and
  // resolved now its folder would read as LOCAL - a laptop shell for a host
  // tab. Only while a read is in flight; otherwise this stays synchronous.
  const rootsLoading = hostRootsPending();
  if (rootsLoading) await rootsLoading.catch(() => undefined);
  const existing = terminals.get(opts.id);
  if (existing) {
    if (existing.pendingOwnerWcId === sender.id) {
      // The window this terminal was routed to (tear-off / merge) is adopting it:
      // rebind + replay so its fresh xterm shows the current screen, take
      // ownership, and clear the transfer marker.
      existing.pendingOwnerWcId = undefined;
      await adopt(existing, opts.id, sender);
    } else if (existing.ownerWcId === sender.id) {
      // Same window re-calling create (StrictMode remount / re-attach). Its xterm
      // already holds the content - keep the target current, don't replay.
      existing.target = sender;
    } else if (existing.pendingOwnerWcId == null && targetGone(existing)) {
      // Recovery: the owning window is gone and no transfer is routed - or the
      // terminal was found live in the daemon at startup and has no owner yet -
      // so a window re-opening this id may adopt it: rebind + replay.
      await adopt(existing, opts.id, sender);
    } else {
      // A window that neither owns this terminal nor was routed it tried to
      // adopt - a stale or hostile id. Ignore rather than hijack the shell.
      console.warn(`terminal:create for ${opts.id} ignored: sender ${sender.id} is not the owner`);
    }
    return;
  }

  if (creating.has(opts.id)) {
    // A spawn for this id is already in flight (typically the session's eager
    // launch spawn, with the workspace's own create landing right behind it).
    // There's no PTY to adopt yet, but this call carries the view's REAL grid -
    // keep it, or the shell would come up on the default 80×24 and stay there
    // (see pendingSizes).
    rememberPendingSize(opts.id, sender.id, opts.cols, opts.rows);
    return;
  }
  // An agent sign-in on a host (a private plan): the id
  // names the host - there is no project folder to resolve it from - and the
  // command is the table's, never the caller's. A plain shell, no plan: the
  // login must not run under double0's hooks or shims.
  // A host sign-in id with no sign-in flow in this build (a private plan › M7)
  // is refused, never started as a local shell.
  if (!signInFlow() && opts.id.startsWith('host-signin:')) {
    if (!sender.isDestroyed()) sender.send('terminal:exit', { id: opts.id, exitCode: -1 });
    return;
  }
  // Pro work not entitled now: refused like a sign-in this build cannot run.
  // Only a NEW terminal - one already running is adopted above.
  const feature = terminalFeature(opts.id);
  if (feature && !featureEntitled(feature)) {
    if (!sender.isDestroyed()) sender.send('terminal:exit', { id: opts.id, exitCode: -1 });
    return;
  }
  const signIn = parseSignIn(opts.id);
  if (signIn) {
    if (!signInHostKnown(signIn.hostId)) {
      if (!sender.isDestroyed()) sender.send('terminal:exit', { id: opts.id, exitCode: -1 });
      return;
    }
    const command = signInFlow()?.startCommand(signIn.kind) ?? null;
    const start = signInFlow()?.startAction(signIn.kind) ?? null;
    if (start?.action === 'login') signInAgents.set(opts.id, start.agent);
    await createRemote(
      sender,
      { ...opts, cwd: '~', initialCommand: command ?? undefined },
      signIn.hostId,
      { plain: true },
    );
    return;
  }
  const hostId = hostResolver(opts.cwd);
  if (hostId) {
    await createRemote(sender, opts, hostId);
    return;
  }
  // Defence in depth (M4 review): a session whose project lives on a host
  // never gets a shell on THIS machine, whatever folder the create named - a
  // folder outside the project's root would otherwise run the host's start
  // command here. Only ids that name a session are looked up.
  const sid = sessionHostResolver ? sessionIdOfPty(opts.id) : null;
  const lookup = sid && sessionHostResolver ? sessionHostResolver(sid) : null;
  if (lookup) {
    creating.set(opts.id, sender.id);
    const sessionHost = await lookup.catch(() => null);
    // A dispose meanwhile cancelled the spawn (its ticket is gone).
    if (creating.get(opts.id) !== sender.id) {
      if (!creating.has(opts.id)) pendingSizes.delete(opts.id);
      return;
    }
    creating.delete(opts.id);
    if (sessionHost) {
      console.warn(
        `terminal:create for ${opts.id} refused: its session runs on ${sessionHost}, the folder is not there`,
      );
      if (!sender.isDestroyed()) sender.send('terminal:exit', { id: opts.id, exitCode: -1 });
      return;
    }
    if (terminals.has(opts.id) || sender.isDestroyed()) return;
  }
  creating.set(opts.id, sender.id);
  const cwd = await materializerOf().resolveCwd(opts.cwd);
  // The await yielded: a dispose or window close may have cancelled the spawn
  // (claim ticket gone), or the sender itself may have died meanwhile.
  const cancelled = creating.get(opts.id) !== sender.id;
  if (!cancelled) creating.delete(opts.id);
  if (cancelled || sender.isDestroyed() || terminals.has(opts.id)) {
    // Nothing will consume a size recorded for this id - unless the ticket was
    // taken over by a NEWER spawn, whose own pending size this must not eat.
    if (!creating.has(opts.id)) pendingSizes.delete(opts.id);
    return;
  }

  // A size requested while this spawn was in flight is the renderer's REAL grid
  // (this call's own cols/rows are the eager launch spawn's, i.e. absent) - the
  // shell starts on it, so the TUI never sees the default 80×24 (see
  // pendingSizes). Everything from here to `terminals.set` is synchronous, so
  // nothing can slip into the map behind this read.
  const pending = pendingSizes.get(opts.id);
  pendingSizes.delete(opts.id);
  const spawnCols = pending?.cols ?? opts.cols;
  const spawnRows = pending?.rows ?? opts.rows;

  // Main plans what to run (launch-plan.ts); the host turns the plan into
  // files and a spawn on its own filesystem (launch-materialize.ts).
  const plan = planLaunch(
    { ...opts, cols: spawnCols, rows: spawnRows },
    { platform: process.platform, appVersion: app.getVersion(), agentTools: true },
  );
  const request: HostSpawnRequest = materializerOf().materialize(plan, cwd);

  // Routed before the backend answers: the renderer's resize / input that
  // follow its create must reach this terminal, and over the daemon socket
  // they queue in order behind the spawn.
  const m = newRecord(sender);
  terminals.set(opts.id, m);
  screens.forget(opts.id);
  screenDialogs.forget(opts.id);
  screens.resize(opts.id, request.cols, request.rows);
  const spawned = await backendOf().spawn(request);
  if (spawned === 'existing') {
    // The shell lived on in a daemon: show what it has instead of a new one.
    if (terminals.get(opts.id) === m) await adopt(m, opts.id, sender);
    return;
  }
  if (!spawned) {
    if (terminals.get(opts.id) === m) terminals.delete(opts.id);
    if (!sender.isDestroyed()) sender.send('terminal:exit', { id: opts.id, exitCode: -1 });
  }
}

/**
 * A terminal on a remote host (a private plan › M1, M2):
 * main plans what to run and the host's daemon materialises the plan on its
 * own machine (remote-shell.ts › remoteLaunchRequest) - nothing is written on
 * this one. The router never spawns it anywhere else and never fails it for
 * an unreachable host: the spawn waits (the tab shows Unreachable) until the
 * host answers or the tab closes.
 */
async function createRemote(
  sender: WebContents,
  opts: SpawnOptions,
  hostId: string,
  how: { plain?: boolean } = {},
): Promise<void> {
  const planner = remoteSpawnPlanner();
  if (!planner) {
    // No remote hosts in this build (a private plan › M7): never a local spawn
    // for a host's terminal - it ends at once.
    pendingSizes.delete(opts.id);
    if (!sender.isDestroyed()) sender.send('terminal:exit', { id: opts.id, exitCode: -1 });
    return;
  }
  const pending = pendingSizes.get(opts.id);
  pendingSizes.delete(opts.id);
  const shellOnly = {
    id: opts.id,
    cwd: opts.cwd,
    cols: pending?.cols ?? opts.cols,
    rows: pending?.rows ?? opts.rows,
    initialCommand: opts.initialCommand,
    appVersion: app.getVersion(),
  };
  const request = how.plain
    ? planner.shellRequest(shellOnly)
    : planner.launchRequest({
        ...shellOnly,
        shellIntegration: opts.shellIntegration,
        platform: hostPlatformOf(hostId),
        agentTools: hostHasAgentTools(hostId),
      });
  const m = newRecord(sender);
  terminals.set(opts.id, m);
  screens.forget(opts.id);
  screenDialogs.forget(opts.id);
  screens.resize(opts.id, request.cols, request.rows);
  const spawned = await backendOf().spawn({ ...request, hostId } as HostSpawnRequest);
  // Closed while it waited for its host: nothing left to tell.
  if (terminals.get(opts.id) !== m) return;
  if (spawned === 'existing') {
    await adopt(m, opts.id, sender);
    return;
  }
  if (!spawned) {
    terminals.delete(opts.id);
    if (!sender.isDestroyed()) sender.send('terminal:exit', { id: opts.id, exitCode: -1 });
  }
}

/** The window that shows terminal `id` (output goes there), or null. */
export function terminalOwner(id: string): WebContents | null {
  const m = terminals.get(id);
  return m ? targetOf(m) : null;
}

/** A terminal is gone (exit, its daemon died): tell its window and forget it. */
function endTerminal(id: string, m: Routed, exitCode: number): void {
  terminals.delete(id);
  signInAgents.delete(id);
  unreachableSince.delete(id);
  screens.forget(id);
  screenDialogs.forget(id);
  for (const tap of taps) tap.gone?.(id, targetOf(m));
  // The tab's agent is gone with its shell: drop its status line capture, so
  // nothing reads the tab as still running that agent.
  statusLine?.forget(id);
  materializerOf().forgetLaunchScript(id);
  // The tail of the shell's output may still be waiting on the flush timer -
  // it must land before the exit notice.
  flushOutput(id, m);
  targetOf(m)?.send('terminal:exit', { id, exitCode });
}

function onBackendEvent(ev: BackendEvent): void {
  switch (ev.type) {
    case 'data': {
      const m = terminals.get(ev.id);
      // A terminal main does not route (unknown, or already ended) gets no
      // screen copy or server scan: nothing would ever forget them
      // (review, 2026-10-06).
      if (!m) return;
      // Mid-adopt chunks are inside the snapshot the adopt feeds it.
      if (!m.adopting) {
        screens.data(ev.id, ev.data);
        screenDialogs.data(ev.id);
      }
      for (const tap of taps) tap.data?.(ev.id, ev.data);
      // Ownerless (nobody to show it; the ring keeps it) or mid-adopt (the
      // snapshot carries it): nothing to forward.
      if (!m || m.adopting || targetGone(m)) return;
      m.pending.push(ev.data);
      m.pendingChars += ev.data.length;
      if (m.pendingChars >= FLUSH_CAP) flushOutput(ev.id, m);
      else if (!m.flushTimer) m.flushTimer = setTimeout(() => flushOutput(ev.id, m), FLUSH_MS);
      return;
    }
    case 'exit': {
      const m = terminals.get(ev.id);
      if (m) endTerminal(ev.id, m, ev.exitCode);
      else {
        statusLine?.forget(ev.id);
        materializerOf().forgetLaunchScript(ev.id);
        for (const tap of taps) tap.gone?.(ev.id, null);
      }
      return;
    }
    case 'title': {
      const m = terminals.get(ev.id);
      if (m) targetOf(m)?.send('terminal:title', { id: ev.id, title: ev.title });
      return;
    }
    case 'inputs': {
      const m = terminals.get(ev.id);
      if (m) targetOf(m)?.send('terminal:inputs', { id: ev.id, entries: ev.entries });
      return;
    }
    case 'discovered': {
      // Terminals alive in a daemon - from before this run of the app. Nobody
      // owns them until a window restores their tab and adopts them.
      for (const t of ev.terminals) if (!terminals.has(t.id)) terminals.set(t.id, newRecord(null));
      return;
    }
    case 'lost': {
      // Died with their daemon: no exit event will ever come, so end them here.
      for (const id of ev.ids) {
        const m = terminals.get(id);
        if (m) endTerminal(id, m, -1);
      }
      return;
    }
    case 'unreachable': {
      // A remote host dropped: the shells run on there. Their windows keep the
      // last screen under an overlay; nothing ends.
      const since = Date.now();
      for (const id of ev.ids) {
        const m = terminals.get(id);
        if (!m) continue;
        const away = { hostId: ev.hostId ?? '', since: unreachableSince.get(id)?.since ?? since };
        unreachableSince.set(id, away);
        flushOutput(id, m);
        targetOf(m)?.send('terminal:unreachable', { id, ...away });
      }
      return;
    }
    case 'grid': {
      // A terminal several apps share (a remote host, spec 14): another app's
      // claim set the grid - this app's window fits its xterm to it (never
      // the pty); `own` tells it the grid is its own again.
      const m = terminals.get(ev.id);
      if (!m) return;
      targetOf(m)?.send('terminal:grid', { id: ev.id, cols: ev.cols, rows: ev.rows, own: ev.own });
      if (!ev.own) screens.resize(ev.id, ev.cols, ev.rows);
      return;
    }
    case 'snapshot-needed': {
      // This app fell too far behind on a paused shared terminal and the host
      // stopped streaming it to us: the window rebuilds its xterm and adopts
      // again (the reachable path), which restarts the stream from a snapshot.
      const m = terminals.get(ev.id);
      if (!m) return;
      const target = targetOf(m);
      if (!target) return;
      flushOutput(ev.id, m);
      requestReplayForOwner(ev.id, m.ownerWcId);
      target.send('terminal:reachable', { id: ev.id });
      return;
    }
    case 'reachable': {
      // Back: each window rebuilds the tab's xterm and adopts it again, so the
      // replay shows what it missed (the same mark a revisit after eviction
      // leaves - requestReplayForOwner).
      for (const id of ev.ids) {
        unreachableSince.delete(id);
        const m = terminals.get(id);
        if (!m) continue;
        const target = targetOf(m);
        if (!target) continue;
        requestReplayForOwner(id, m.ownerWcId);
        target.send('terminal:reachable', { id });
      }
      return;
    }
  }
}

/**
 * Mark a terminal as being transferred to window `wcId` (tear-off / merge). Set
 * synchronously while routing a drop, BEFORE the origin is told to drop the tab,
 * so the origin window closing can't kill a shell another window is about to
 * adopt. Cleared when that window's adopt completes.
 */
export function setPendingTerminalOwner(termId: string, wcId: number): void {
  const m = terminals.get(termId);
  if (m) m.pendingOwnerWcId = wcId;
}

/**
 * True if window `wcId` currently owns (receives output for) terminal `termId`.
 * Used to reject cross-window tab/session transfers for shells the requesting
 * window doesn't actually own.
 */
export function isTerminalOwnedBy(termId: string, wcId: number): boolean {
  const m = terminals.get(termId);
  return !!m && m.ownerWcId === wcId;
}

/**
 * Pre-assign a session's shells that a layout walk can miss to another window
 * during a session tear-off / return, so the receiving window can adopt the
 * still-running shells instead of the origin's release killing them. The layout
 * shells get this per-tab (setPendingTerminalOwner); matched by id here are the
 * session's own shells (`sessionShellPrefix`, never in the layout) and the
 * eagerly-spawned conversation/setup shells of a session launched but never
 * opened (which has no layout at all to route from). A shell already
 * mid-transfer is left alone.
 */
export function reassignSessionShells(sessionId: string, fromWcId: number, toWcId: number): void {
  const shellPrefix = sessionShellPrefix(sessionId);
  const eagerIds = new Set([`conversation:${sessionId}`, `setup:${sessionId}`]);
  for (const [id, m] of terminals) {
    if (!id.startsWith(shellPrefix) && !eagerIds.has(id)) continue;
    if (m.ownerWcId === fromWcId && m.pendingOwnerWcId == null) {
      m.pendingOwnerWcId = toWcId;
    }
  }
}

/**
 * A whole window handing everything it owns to another (a project window
 * closing, or being brought back - a private plan): every
 * shell it owns is routed to `toWcId`, and so is every shell still routed TO it
 * that it never got round to adopting (a session the project window never
 * opened keeps its shells owned by the origin, routed to the project window).
 * The latter lands as a self-routed marker when the origin is the destination -
 * exactly the replay-on-next-create mark an eviction leaves, so the fresh xterm
 * the origin builds for it gets the scrollback instead of a blank tab. A shell
 * mid-transfer to a THIRD window is left alone, like reassignSessionShells.
 */
export function reassignWindowShells(fromWcId: number, toWcId: number): void {
  for (const m of terminals.values()) {
    if (m.ownerWcId === fromWcId) {
      if (m.pendingOwnerWcId == null || m.pendingOwnerWcId === fromWcId) {
        m.pendingOwnerWcId = toWcId;
      }
    } else if (m.pendingOwnerWcId === fromWcId) {
      m.pendingOwnerWcId = toWcId;
    }
  }
}

/**
 * A window dropping its xterm for a shell it owns, to re-adopt later with a replay
 * (see the terminal:requestReplay handler). Marks the shell pending-owned by that
 * same window - but NEVER when it's already routed to a DIFFERENT window (a session
 * / tab tear-off in flight), so a released session's dock unmount can't reclaim a
 * command shell that's being handed to the new window.
 */
export function requestReplayForOwner(id: string, wcId: number): void {
  const m = terminals.get(id);
  if (!m || m.ownerWcId !== wcId) return;
  if (m.pendingOwnerWcId != null && m.pendingOwnerWcId !== wcId) return;
  m.pendingOwnerWcId = wcId;
}

/** Kill a terminal and forget it (a tab close, a window going away). */
function disposeTerminal(id: string): void {
  pendingSizes.delete(id);
  signInAgents.delete(id);
  screens.forget(id);
  screenDialogs.forget(id);
  const m = terminals.get(id);
  if (!m) return;
  terminals.delete(id);
  clearPending(m);
  // Its servers - and a remote terminal's port forwards - go with the tab:
  // a closed remote terminal's exit never comes back through the router
  // (the kill drops its route), so waiting for it would leak the forward.
  for (const tap of taps) tap.gone?.(id, null);
  backendOf().kill(id);
}

/**
 * End every shell of a session, whichever window owns it (a session moved to
 * another machine, M4 review): its conversation, setup and Commands shells by
 * id prefix, plus `extraIds` (its "+" tabs, from the persisted layout). Each
 * goes the way a tab close does - SIGHUP through the pty, on whichever
 * machine it runs. Returns the ids it ended.
 */
export function endSessionTerminals(sessionId: string, extraIds: string[] = []): string[] {
  const ended: string[] = [];
  const own = (id: string) =>
    id === `conversation:${sessionId}` ||
    id === `setup:${sessionId}` ||
    id.startsWith(sessionShellPrefix(sessionId));
  const extra = new Set(extraIds);
  for (const id of [...terminals.keys()]) {
    if (!own(id) && !extra.has(id)) continue;
    const m = terminals.get(id);
    // Its window hears the exit, as for a shell that ended by itself.
    if (m) targetOf(m)?.send('terminal:exit', { id, exitCode: 0 });
    disposeTerminal(id);
    ended.push(id);
  }
  return ended;
}

/**
 * Kill every PTY a closing window still owns. Terminals moved out were re-owned
 * by their new window (via adopt), and one still mid-transfer is spared so the
 * window adopting it can finish - so this leaves both running.
 */
export function disposeTerminalsForWindow(wcId: number): void {
  // Cancel any spawn this window still has in flight (see createOrAdopt).
  for (const [id, creatorWcId] of [...creating]) {
    if (creatorWcId === wcId) creating.delete(id);
  }
  for (const [id, m] of [...terminals]) {
    if (m.pendingOwnerWcId === wcId) {
      // The window this terminal was being transferred TO died before adopting.
      // Clear the marker so the still-live owner keeps kill responsibility - or,
      // if the owner is gone too, nothing can ever dispose it, so kill it now.
      m.pendingOwnerWcId = undefined;
      if (targetGone(m)) disposeTerminal(id);
      continue;
    }
    // Mid-transfer to a different window: spared so its adopt can finish.
    if (m.pendingOwnerWcId != null) continue;
    if (m.ownerWcId === wcId) disposeTerminal(id);
  }
}

/** The ids of every live terminal main knows, owned or not (the startup sweeps). */
export function liveTerminalIds(): string[] {
  return [...terminals.keys()];
}

/**
 * Settings › Sessions › Stop all sessions: end every terminal main knows -
 * each window is told its tabs exited, as a shell exit would tell it - then
 * kill them in the backend. `kill` reports no exit (the caller asked for it),
 * so a bare `killAll` left the records, and the tabs, as if alive: nothing
 * ever reached the renderer, and a tab reopened later found its id still
 * "owned" by its window and never spawned again until the app restarted
 * (2026-10-04).
 */
export async function stopAllTerminals(hostId: string | null = null): Promise<boolean> {
  // One machine at a time (a private plan › 16): null =
  // this one - a remote host's terminals keep running there - or one host's.
  const hostOf = backendOf().hostOf?.bind(backendOf());
  const mine = (): Array<[string, Routed]> =>
    [...terminals].filter(([id]) => (hostOf?.(id) ?? null) === hostId);
  if (hostId) {
    // A host is killed FIRST and its tabs end only once the kill reached it:
    // an unreachable host's shells keep running, and must not read as exited.
    // Listed before the kill: a reached host drops its routes as it answers.
    const theirs = mine();
    if ((await backendOf().killAll(hostId)) === false) return false;
    for (const [id, m] of theirs) if (terminals.get(id) === m) endTerminal(id, m, 0);
    return true;
  }
  for (const [id, m] of mine()) endTerminal(id, m, 0);
  await backendOf().killAll();
  return true;
}

// --- moving sessions off an older build's daemon (daemon-migrate.ts) ---------

/** Since when each terminal on an older daemon has sat idle at its agent prompt. */
let idleOnOlderDaemon = new Map<string, number>();
let moveTimer: NodeJS.Timeout | null = null;
/** The automatic pass in flight: a slow one never stacks with the next. */
let movePass: Promise<unknown> | null = null;
/**
 * The longest any probe of an older daemon may take. An older daemon may be
 * wedged (the bug an update fixed): unanswered, its probe reads as busy and
 * nothing moves - never a call left hanging per pass (review 2026-11-05).
 */
const MOVE_PROBE_MS = 5000;

const within = <T>(p: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([
    p.catch(() => fallback),
    new Promise<T>((r) => setTimeout(r, MOVE_PROBE_MS, fallback).unref?.()),
  ]);

/** Whether a fresh start of this tab resumes its agent: a Claude or OpenCode record for it. */
function resumable(id: string): boolean {
  const tabId = claudeSessionIdForPty(id);
  if (!tabId) return false;
  const userData = app.getPath('userData');
  const claude = claudeSessionRecordPath(claudeSessionRecordsDir(userData), tabId);
  const opencode = claudeSessionRecordPath(opencodeSessionRecordsDir(userData), tabId);
  return recordedClaudeSessionId(claude) !== null || recordedOpencodeSessionId(opencode) !== null;
}

/** What the backend says about each id: markers, agent status, foreground program. */
async function probeForMove(ids: string[]): Promise<MoveProbe[]> {
  if (ids.length === 0) return [];
  const b = backendOf();
  // Unanswered reads as busy: every id marker-driven with no status.
  const [marker, statuses] = await Promise.all([
    within(b.markerDriven(ids), ids),
    within(b.agentStatus(ids), []),
  ]);
  const markers = new Set(marker);
  const status = new Map(statuses.map((s) => [s.id, s.status]));
  return Promise.all(
    ids.map(async (id) => ({
      id,
      marker: markers.has(id),
      status: status.get(id) ?? null,
      // Unknown reads as busy: never move what may be running.
      foregroundBusy: markers.has(id) ? false : await within(b.foregroundBusy(id), true),
      resumable: resumable(id),
    })),
  );
}

/** No window shows it, and none is about to adopt it. */
function unowned(id: string): boolean {
  const m = terminals.get(id);
  return !!m && !targetOf(m) && m.pendingOwnerWcId == null && !creating.has(id);
}

/**
 * End a terminal on the daemon that holds it so its tab starts again on this
 * build's. Main forgets it the way a tab close does, minus the agent's resume
 * record - the fresh start resumes the conversation. A window that has the
 * tab open is told to start it again in place (`terminal:relaunch`); an
 * unowned one starts on its next open.
 */
function moveTerminal(id: string): void {
  const m = terminals.get(id);
  const target = m ? targetOf(m) : null;
  disposeTerminal(id);
  target?.send('terminal:relaunch', { id });
}

/**
 * One automatic pass: the agents on an older daemon that no window shows and
 * that have sat idle long enough move (daemon-migrate.ts › autoMovable).
 */
export async function moveIdleTerminalsOffOlderDaemons(now = Date.now()): Promise<string[]> {
  if (movePass) return [];
  const pass = moveIdlePass(now);
  movePass = pass;
  try {
    return await pass;
  } finally {
    movePass = null;
  }
}

async function moveIdlePass(now: number): Promise<string[]> {
  const candidates = olderBuildIds(backendOf().daemons?.() ?? []).filter(
    (id) => unowned(id) && !isRemoteTerminal(id),
  );
  const probes = await probeForMove(candidates);
  idleOnOlderDaemon = trackIdle(idleOnOlderDaemon, probes, now);
  const moved: string[] = [];
  // Re-checked: a window may have opened the session during the probe.
  for (const id of autoMovable(probes, idleOnOlderDaemon, now)) {
    if (!unowned(id)) continue;
    moveTerminal(id);
    idleOnOlderDaemon.delete(id);
    moved.push(id);
  }
  return moved;
}

/** Settings › Sessions: this machine's daemons, with how busy each older one is. */
export async function daemonOverview(): Promise<DaemonRow[]> {
  const daemons = backendOf().daemons?.() ?? [];
  // Only an older daemon's counts are shown: the current one is never probed.
  return daemonRows(daemons, await probeForMove(olderBuildIds(daemons)));
}

/** The ids an older daemon holds, or none (unknown socket, or this build's own). */
function olderDaemonIds(socketPath: string): string[] | null {
  const daemons = backendOf().daemons?.() ?? [];
  const d = daemons.find((x) => x.socketPath === socketPath);
  if (!d || d.current || !daemons.some((x) => x.current)) return null;
  return d.ids;
}

/**
 * Settings › Sessions › Move now: every terminal of an older daemon starts
 * again on this build's. Anything that would lose work - a busy terminal, or
 * an idle agent whose conversation the fresh start cannot resume (Codex, one
 * typed by hand) - only once the user confirmed (`confirmed`); until then the
 * counts come back for the question. Setup and Commands shells stay (`kept`)
 * until their tab closes - a fresh one would run its command again - and so
 * does a tab mid-transfer to another window, whose relaunch would land in the
 * window it is leaving.
 */
export async function moveDaemonTerminals(
  socketPath: string,
  confirmed: boolean,
): Promise<{ moved: number; busy: number; unresumable: number; kept: number } | null> {
  const ids = olderDaemonIds(socketPath);
  if (!ids) return null;
  const inTransfer = (id: string): boolean =>
    terminals.get(id)?.pendingOwnerWcId != null || creating.has(id);
  const movable = ids.filter((id) => !neverMovesByItself(id) && !inTransfer(id));
  const kept = ids.length - movable.length;
  const probes = await probeForMove(movable);
  const busy = probes.filter(isBusy).length;
  const unresumable = probes.filter(wouldLoseConversation).length;
  if ((busy > 0 || unresumable > 0) && !confirmed) return { moved: 0, busy, unresumable, kept };
  let moved = 0;
  for (const id of movable) {
    // Re-checked after the probe: a transfer may have started meanwhile.
    if (!terminals.has(id) || inTransfer(id)) continue;
    moveTerminal(id);
    moved++;
  }
  return { moved, busy: 0, unresumable: 0, kept };
}

/** What the quit disposer does with the shells. */
export type TerminalDisposeOptions = {
  /**
   * Kill every terminal and wait for the shells (the pre-daemon behaviour,
   * and the "Quit and stop all sessions" menu item / the Keep-running switch
   * off). Otherwise the daemon keeps them for the next launch; in-process
   * terminals cannot be kept and are killed either way.
   */
  stopSessions: boolean;
};

/** Terminals in this process over node-pty - the default, and the daemon's fallback. */
export function createInProcessBackend(): TerminalBackend {
  return new InProcessBackend(spawn as unknown as PtySpawner);
}

/**
 * Register the terminal IPC handlers over `backend` (in-process by default -
 * the session daemon when index.ts passes it). Call once after the app is
 * ready. Returns a disposer for app quit: with `stopSessions` it kills every
 * live PTY and resolves once their shells have exited; without, it lets go
 * of them (the daemon keeps them running).
 */
export function registerTerminalIpc(
  terminalBackend: TerminalBackend = createInProcessBackend(),
): (opts?: TerminalDisposeOptions) => Promise<void> {
  backend = terminalBackend;
  backend.onEvent(onBackendEvent);
  // Every handler waits for the backend once, in arrival order: the terminals
  // a daemon still holds are registered before the renderer's first create is
  // looked at, and a create's resize still lands behind it (one promise, FIFO
  // reactions - the same ordering the in-process path had with no wait).
  const gate = backend.ready();
  let gateOpen = false;
  void gate.then(() => {
    gateOpen = true;
  });
  // Once open, handlers run synchronously again (an IPC event is a macrotask,
  // so none can overtake the reactions still queued on the gate).
  const gated =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R | Promise<Awaited<R>> =>
      gateOpen ? fn(...args) : gate.then(() => fn(...args) as Awaited<R>);

  // Only the owning window (or the one a transfer is routed to) may drive a
  // shell - input/resize/dispose from anyone else on a guessed id is dropped.
  const senderMayDrive = (m: Routed, wcId: number): boolean =>
    m.ownerWcId === wcId || m.pendingOwnerWcId === wcId;

  ipcMain.on(
    'terminal:create',
    gated((event, opts: SpawnOptions) => {
      if (!isTrustedSender(event)) return;
      if (!opts || typeof opts.id !== 'string' || opts.id.length === 0) return;
      void createOrAdopt(event.sender, opts);
    }),
  );

  ipcMain.on(
    'terminal:input',
    gated((event, payload: { id?: unknown; data?: unknown }) => {
      if (!isTrustedSender(event)) return;
      const id = payload?.id;
      const data = payload?.data;
      if (typeof id !== 'string' || typeof data !== 'string') return;
      const m = terminals.get(id);
      if (!m || !senderMayDrive(m, event.sender.id)) return;
      backendOf().input(id, data);
    }),
  );

  ipcMain.on(
    'terminal:resize',
    gated((event, payload: { id?: unknown; cols?: unknown; rows?: unknown; kind?: unknown }) => {
      if (!isTrustedSender(event)) return;
      const { id, cols, rows } = payload ?? {};
      if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return;
      // Whether the user asked for it (spec 14) - read by a host several apps
      // share; anything else is no kind (a claim, as before).
      const kind =
        payload?.kind === 'claim' || payload?.kind === 'passive' ? payload.kind : undefined;
      const m = terminals.get(id);
      if (!m) {
        // No PTY yet: the shell is still being spawned. Keep the size so the
        // spawn lands on it instead of the default grid (see pendingSizes) -
        // dropping it is what stranded a shell at 80×24 for good.
        rememberPendingSize(id, event.sender.id, cols, rows);
        return;
      }
      if (!senderMayDrive(m, event.sender.id)) return;
      if (cols > 0 && rows > 0) {
        // No kind = the call as it always was (a local terminal's path is unchanged).
        if (kind) backendOf().resize(id, cols, rows, kind);
        else backendOf().resize(id, cols, rows);
        screens.resize(id, cols, rows);
      }
    }),
  );

  // The terminal light/dark tone changed (an app appearance flip, or the first
  // report at startup). The backend remembers it and nudges every program that
  // asked for colour-scheme notifications to re-detect - the one flip case
  // xterm.js cannot deliver on its own. Applies across windows: the tone is a
  // single app-wide setting.
  ipcMain.on(
    'terminal:setTone',
    gated((event, payload: { dark?: unknown }) => {
      if (!isTrustedSender(event)) return;
      if (typeof payload?.dark !== 'boolean') return;
      backendOf().setTone(payload.dark);
    }),
  );

  // Flow control: the renderer pauses the PTY when xterm's write queue crosses
  // its high watermark and resumes below the low one (see terminal-view.tsx).
  // The shell then blocks on stdout instead of flooding a busy renderer.
  ipcMain.on(
    'terminal:pause',
    gated((event, payload: { id?: unknown }) => {
      if (!isTrustedSender(event)) return;
      const id = payload?.id;
      if (typeof id !== 'string') return;
      const m = terminals.get(id);
      if (!m || !senderMayDrive(m, event.sender.id)) return;
      backendOf().pause(id);
    }),
  );

  ipcMain.on(
    'terminal:resume',
    gated((event, payload: { id?: unknown }) => {
      if (!isTrustedSender(event)) return;
      const id = payload?.id;
      if (typeof id !== 'string') return;
      const m = terminals.get(id);
      if (!m || !senderMayDrive(m, event.sender.id)) return;
      backendOf().resume(id);
    }),
  );

  /**
   * The PTY's real grid, for the renderer's xterm↔PTY invariant check (see
   * `reconcileTerminalGrid`). A resize can be dropped on the way here - a shell
   * still spawning, a window that no longer owns the terminal, a PTY that threw
   * - and the divergence is then permanent and invisible: the program keeps
   * drawing frames for a grid the xterm doesn't have, which is what garbles a
   * TUI's prompt box. The renderer compares this against its own grid on every
   * reveal/focus and pushes its own back if they disagree. While an adopt
   * jiggle is pending the backend reports the size it will restore to.
   */
  ipcMain.handle(
    'terminal:size',
    gated((event, payload: { id?: unknown }) => {
      if (!isTrustedSender(event)) return null;
      const id = payload?.id;
      if (typeof id !== 'string') return null;
      const m = terminals.get(id);
      if (!m || !senderMayDrive(m, event.sender.id)) return null;
      return backendOf().size(id);
    }),
  );

  ipcMain.on(
    'terminal:dispose',
    gated((event, payload: { id?: unknown }) => {
      if (!isTrustedSender(event)) return;
      const id = payload?.id;
      if (typeof id !== 'string') return;
      // A dispose racing an in-flight spawn cancels it (see createOrAdopt).
      if (creating.get(id) === event.sender.id) {
        creating.delete(id);
        pendingSizes.delete(id);
      }
      const m = terminals.get(id);
      // A tab whose shell already exited has no record left, but whoever
      // follows it (an extension's view) must still let go.
      if (!m) {
        for (const l of closedListeners) l(id);
        return;
      }
      if (!senderMayDrive(m, event.sender.id)) return;
      disposeTerminal(id);
      for (const l of closedListeners) l(id);
      // A renderer dispose is a tab CLOSE (moves and window teardown don't come
      // this way - see disposePooledTerminal), so its conversation records are done.
      forgetClaudeSession(claudeSessionRecordsDir(app.getPath('userData')), id);
      forgetOpencodeSession(opencodeSessionRecordsDir(app.getPath('userData')), id);
      forgetCodexSession(codexSessionRecordsDir(app.getPath('userData')), id);
      statusLine?.forget(id);
    }),
  );

  // Report whether a program is running in a terminal's foreground (vs the idle
  // shell prompt), from node-pty's foreground process name - lets the renderer
  // tell a 'needs-input' session (agent waiting) from an 'idle' one.
  ipcMain.handle(
    'terminal:foregroundBusy',
    gated((event, payload: { id?: unknown }) => {
      if (!isTrustedSender(event)) return false;
      const id = payload?.id;
      if (typeof id !== 'string' || !terminals.has(id)) return false;
      return backendOf().foregroundBusy(id);
    }),
  );

  // Which of these terminals speak the status-marker protocol: launched
  // through an agent adapter, or proven by their stream since (a wrapper that
  // reached `claude`). The renderer drops the output/quiet heuristics for
  // them without waiting for a first marker that a parked agent never sends
  // (see observeSessionStatus).
  ipcMain.handle(
    'terminal:markerDriven',
    gated((event, payload: { ids?: unknown }) => {
      if (!isTrustedSender(event)) return [];
      const ids = payload?.ids;
      if (!Array.isArray(ids)) return [];
      return backendOf().markerDriven(
        ids.filter((id): id is string => typeof id === 'string' && terminals.has(id)),
      );
    }),
  );

  // What each marker-driven terminal's agent is doing, as the stream says
  // (TerminalModeTracker.agentStatus). The renderer keeps each tab's state in
  // memory, fed by the markers it sees - a renderer that starts observing
  // mid-turn (a reload, a tear-off, an app restart over a live daemon) has
  // seen none, and an agent parked on a background subagent sends none for
  // minutes: its tab showed no wash and no dot while it worked. Terminals
  // without the protocol are left out - no verdict is held for them.
  ipcMain.handle(
    'terminal:agentStatus',
    gated((event, payload: { ids?: unknown }) => {
      if (!isTrustedSender(event)) return [];
      const ids = payload?.ids;
      if (!Array.isArray(ids)) return [];
      return backendOf().agentStatus(
        ids.filter((id): id is string => typeof id === 'string' && terminals.has(id)),
      ) as Promise<{ id: string; status: AgentStatus }[]>;
    }),
  );

  // Every input the pty was given, oldest first, for the Inputs list: a
  // window that starts showing this terminal (first sight, a reload, a
  // tear-off) asks once; later entries arrive as `terminal:inputs` pushes.
  ipcMain.handle(
    'terminal:inputList',
    gated((event, payload: { id?: unknown }) => {
      if (!isTrustedSender(event)) return [];
      const id = payload?.id;
      if (typeof id !== 'string') return [];
      const m = terminals.get(id);
      if (!m || !senderMayDrive(m, event.sender.id)) return [];
      return backendOf().inputList(id);
    }),
  );

  // A line the renderer read off the screen when Enter was pressed in a
  // program that reports nothing itself (a REPL, a shell without the
  // integration). The backend names the program and places the tag.
  ipcMain.on(
    'terminal:noteInput',
    gated((event, payload: { id?: unknown; text?: unknown; ref?: unknown }) => {
      if (!isTrustedSender(event)) return;
      const { id, text, ref } = payload ?? {};
      if (typeof id !== 'string' || typeof text !== 'string') return;
      if (text.length > MAX_NOTED_LINE || !Number.isSafeInteger(ref)) return;
      const m = terminals.get(id);
      if (!m || !senderMayDrive(m, event.sender.id)) return;
      backendOf().noteLine(id, text, ref as number);
    }),
  );

  // Which of a session's own shells outside its layout currently exist and are
  // drivable by this window (owned, a tear-off routed to it, or found live in
  // the daemon with no owner yet) - so a window adopting a torn-off /
  // returned / restored session re-mounts its live commands (and adopts them)
  // instead of showing them as not running. Returns the keys (the part after
  // `sessionShellPrefix`).
  ipcMain.handle(
    'terminal:sessionCommandIds',
    gated((event, payload: { sessionId?: unknown }) => {
      if (!isTrustedSender(event)) return [];
      const sessionId = payload?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) return [];
      const prefix = sessionShellPrefix(sessionId);
      const wcId = event.sender.id;
      const ids: string[] = [];
      for (const [id, m] of terminals) {
        if (!id.startsWith(prefix)) continue;
        const ownerless = m.ownerWcId === NO_OWNER && m.pendingOwnerWcId == null;
        if (m.ownerWcId !== wcId && m.pendingOwnerWcId !== wcId && !ownerless) continue;
        ids.push(id.slice(prefix.length));
      }
      return ids;
    }),
  );

  // The handlers and the backend binding stay registered: quit is the only
  // caller, and the process ends behind it.
  // Idle agents leave an older build's daemon by themselves (daemon-migrate.ts).
  void gate.then(() => {
    moveTimer = setInterval(() => {
      void moveIdleTerminalsOffOlderDaemons().catch(() => undefined);
    }, MOVE_CHECK_MS);
    moveTimer.unref?.();
  });
  return async (opts = { stopSessions: true }) => {
    if (moveTimer) clearInterval(moveTimer);
    moveTimer = null;
    idleOnOlderDaemon.clear();
    creating.clear();
    pendingSizes.clear();
    if (opts.stopSessions) {
      for (const m of terminals.values()) clearPending(m);
      terminals.clear();
    }
    // Resolves once the killed shells have reported their exit (when stopping)
    // - quitting before that aborts the process (see `PtyHost.killAll`).
    await backendOf().shutdown({ stopSessions: opts.stopSessions });
  };
}
