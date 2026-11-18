import type { AgentStatus } from '../terminal-modes';
import type { InputEntry } from '../terminal-inputs';
import type { HostSpawnRequest, TerminalSnapshot, TerminalSummary } from '../pty-host';
import type { BackendEvent, DaemonInfo, TerminalBackend } from '../terminal-backend';
import { isOutcomeUnknown, type DaemonClient } from './daemon-client';
import type { HostOpEvent, PeerCount, ResizeKind } from './protocol';
import { compatibleSockets } from './daemon-paths';
import { PROTOCOL_VERSION, type CallOp, type CastOp, type DaemonCap } from './protocol';
import type { ExtensionEvent } from './protocol';
import type { AttachedDaemon, ExtensionChannel } from './extension-channel';

/**
 * Main's view of the session daemons (a private plan): the
 * `TerminalBackend` that keeps terminals alive across app restarts.
 *
 * At boot it connects to every compatible socket in the daemon folder - the
 * daemon of this build and any older build's still holding terminals -
 * removes the socket files of daemons that are gone, and starts a daemon for
 * this build when none answers. Every terminal id is routed to the daemon
 * that holds it; new spawns go to this build's daemon only (an older one
 * refuses them anyway - `stale`), so older daemons drain and idle-exit.
 *
 * A dropped socket is retried briefly (the daemon may still be there); once
 * it is given up, every terminal routed to it is reported `lost` and, if it
 * was this build's daemon, the next spawn starts a fresh one.
 *
 * The connector, the spawner and the folder listing are injected so the
 * routing is tested without sockets (daemon-backend.test.ts); daemon-main.ts
 * and index.ts supply the real ones.
 */
export type ClientLike = Pick<
  DaemonClient,
  'call' | 'cast' | 'onEvent' | 'onClose' | 'close' | 'closed' | 'buildId' | 'stale' | 'socketPath'
> & {
  welcome: {
    terminals: TerminalSummary[];
    caps?: string[];
    connectionId?: number;
    peers?: PeerCount;
    /** An extension's own fields (`DaemonServerExtension.welcome`). */
    readonly [field: string]: unknown;
  };
  /** An extension's events - absent on test fakes that have none. */
  onExtensionEvent?: DaemonClient['onExtensionEvent'];
  /** A remote host's streamed op answers (exec, transfer, watch) - absent on fakes. */
  onHostOpEvent?: DaemonClient['onHostOpEvent'];
  /** A shared daemon's word about the other apps (M4) - absent on fakes. */
  onViewEvent?: DaemonClient['onViewEvent'];
};

export type DaemonBackendDeps = {
  buildId: string;
  /** Protocol versions this client speaks (the current one, later also older ones). */
  protocolVersions?: number[];
  socketPathFor: (protocolVersion: number, buildId: string) => string;
  /** The socket folder's file names, or null where sockets live in no folder (pipes). */
  listSocketNames: () => string[] | null;
  /** Connect + hello; rejects when nothing answers or the handshake fails. */
  connect: (socketPath: string) => Promise<ClientLike>;
  /** Start this build's daemon on `socketPath` (detached, fire and forget). */
  spawnDaemon: (socketPath: string) => void;
  /** A socket file nobody listens on. */
  removeDeadSocket: (socketPath: string) => void;
  log: (message: string) => void;
  /** How long to keep trying to reach a freshly spawned daemon. */
  startTimeoutMs?: number;
  /** Delay between connection attempts to a starting daemon. */
  pollMs?: number;
  /** Attempts to re-reach a daemon whose socket dropped before its terminals are declared lost. */
  reconnectAttempts?: number;
  /** Boot keeps retrying a daemon that did not answer until this much time has passed. */
  bootDeadlineMs?: number;
  /** Pause between those retries. */
  bootRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * What a dropped daemon means. `quick` (the local daemon): a few retries,
   * then everything it held is `lost`. `patient` (a remote host's daemon,
   * a private plan › 9.2): the terminals run on the
   * host whatever the network does, so a drop is `unreachable` and the
   * backend keeps reconnecting with backoff (`backoffMs`) until the host
   * answers - only a reconnected daemon that no longer lists an id makes it
   * `lost`.
   */
  lossPolicy?: 'quick' | 'patient';
  /** The pause before patient reconnect attempt `n` (0-based). */
  backoffMs?: (attempt: number) => number;
  /**
   * An extension sees every daemon attached (this build's or an older one's)
   * from the first - it is given at construction, before boot attaches any.
   */
  onAttach?: (daemon: AttachedDaemon) => void;
};

/** 1, 2, 4, 8, 16, 32 s, then every 60 s (spec 9.3). */
export function reconnectBackoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 6)));
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `connect` failed because nothing listens behind the socket file: it is what
 * a daemon that crashed (or was killed) left on disk, and it must go - a new
 * daemon cannot bind the path while it exists (EADDRINUSE). Any other
 * failure - a handshake that timed out, a daemon that refused the hello, one
 * that closed mid-handshake - is a daemon that IS there; unlinking its socket
 * would orphan every terminal it holds, alive and unreachable for good.
 */
export function isDeadSocketError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ECONNREFUSED';
}

/** The socket file vanished between the folder listing and the connect (its daemon idle-exited). */
export function isMissingSocketError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

/** How long boot keeps retrying the daemons it found before `ready()` resolves without them. */
export const BOOT_DEADLINE_MS = 4000;
/** Pause between two connect attempts to a daemon that is there but did not answer. */
export const BOOT_RETRY_MS = 400;

export class DaemonBackend implements TerminalBackend {
  private readonly listeners = new Set<(ev: BackendEvent) => void>();
  private readonly extensionListeners = new Set<(ev: ExtensionEvent) => void>();
  private readonly extensionLostListeners = new Set<() => void>();
  private readonly extensionResyncListeners = new Set<() => void>();
  private readonly hostOpListeners = new Set<(ev: HostOpEvent) => void>();
  private readonly currentListeners = new Set<() => void>();
  private readonly peerListeners = new Set<() => void>();
  /** The other apps each attached daemon last said were there (M4). */
  private readonly peerCounts = new Map<ClientLike, PeerCount>();
  /** This app's resize intents, numbered; and per terminal its latest claim still unanswered. */
  private intentSeq = 0;
  private readonly claimsInFlight = new Map<string, { client: ClientLike; seq: number }>();
  /** Every daemon this app talks to, by socket path. */
  private readonly clients = new Map<string, ClientLike>();
  /** Which daemon holds each terminal. */
  private readonly routes = new Map<string, ClientLike>();
  /** This build's daemon - the only one new shells go to. */
  private current: ClientLike | null = null;
  private readonly readyPromise: Promise<void>;
  private startingOwn: Promise<ClientLike> | null = null;
  private shuttingDown = false;
  private readonly versions: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: DaemonBackendDeps) {
    this.versions = deps.protocolVersions ?? [PROTOCOL_VERSION];
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.readyPromise = this.boot();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  onEvent(listener: (ev: BackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: BackendEvent): void {
    for (const l of this.listeners) l(ev);
  }

  /** The socket paths of the daemons currently connected (diagnostics, tests). */
  connected(): string[] {
    return [...this.clients.keys()];
  }

  /** Every attached daemon with the terminals routed to it. */
  daemons(): DaemonInfo[] {
    return [...this.clients.values()].map((client) => ({
      socketPath: client.socketPath,
      buildId: client.buildId,
      current: client === this.current,
      ids: [...this.routes].filter(([, c]) => c === client).map(([id]) => id),
    }));
  }

  // --- boot -----------------------------------------------------------------------

  private async boot(): Promise<void> {
    const names = this.deps.listSocketNames();
    if (names) {
      // One deadline for the whole folder, so a boot with several slow
      // daemons still ends: `ready()` resolves only once every socket found
      // is attached, removed or given up on - the renderer's first creates
      // and the crash-recovery sweep must never see a half-known world (a
      // daemon still being reached would read as "its terminals are gone":
      // sessions reset and duplicate shells spawned under its ids).
      const deadline = this.now() + (this.deps.bootDeadlineMs ?? BOOT_DEADLINE_MS);
      for (const { fileName, protocolVersion, buildId } of compatibleSockets(
        names,
        this.versions,
      )) {
        const path = this.deps.socketPathFor(protocolVersion, buildId);
        if (!path.endsWith(fileName)) continue;
        await this.attachFound(path, fileName, deadline);
      }
    } else {
      // No folder to list (named pipes): only this build's daemon is reachable.
      const path = this.ownSocketPath();
      try {
        this.attach(await this.deps.connect(path));
      } catch {
        // Not running yet - started below.
      }
    }
    if (!this.current) await this.startOwn();
  }

  /**
   * Attach to a socket the folder listed. Refused = a dead daemon's file,
   * removed; vanished = it idle-exited meanwhile, nothing to do. Anything
   * else (a handshake that timed out, a connection closed mid-hello) is a
   * daemon that is there but slow - one busy draining its ptys at the moment
   * - and is retried until the boot deadline, then left alone: its socket
   * stays, its terminals are simply not known this launch.
   */
  private async attachFound(path: string, fileName: string, deadline: number): Promise<void> {
    for (;;) {
      try {
        this.attach(await this.deps.connect(path));
        return;
      } catch (err) {
        if (isDeadSocketError(err)) {
          this.deps.log(`no daemon behind ${fileName} (${String(err)}) - removing it`);
          this.deps.removeDeadSocket(path);
          return;
        }
        if (isMissingSocketError(err)) return;
        if (this.now() >= deadline) {
          this.deps.log(`could not attach to ${fileName} (${String(err)}) - left alone`);
          return;
        }
        await this.sleep(this.deps.bootRetryMs ?? BOOT_RETRY_MS);
      }
    }
  }

  private ownSocketPath(): string {
    return this.deps.socketPathFor(PROTOCOL_VERSION, this.deps.buildId);
  }

  /** This build's daemon, as opposed to an older build's still draining its terminals. */
  private isCurrentBuild(client: ClientLike): boolean {
    return client.buildId === this.deps.buildId && !client.stale;
  }

  /** Start this build's daemon and connect to it; one attempt at a time. */
  private startOwn(): Promise<ClientLike> {
    if (this.startingOwn) return this.startingOwn;
    const path = this.ownSocketPath();
    const attempt = async (): Promise<ClientLike> => {
      // A daemon of this build may already be up (a second boot, a reconnect).
      let absent = true;
      try {
        return this.attach(await this.deps.connect(path));
      } catch (err) {
        // What a crashed daemon left behind blocks its replacement from
        // binding the path - until the next app start removed it, no new
        // terminal could be opened after a daemon crash (2026-10-04).
        if (isDeadSocketError(err)) this.deps.removeDeadSocket(path);
        // Only a refused or missing socket means nobody is there. A slow
        // hello is a live daemon: a second one would fail to bind and only
        // add its own timeouts - keep polling the one we have.
        else if (!isMissingSocketError(err)) absent = false;
      }
      if (absent) {
        this.deps.log(`starting daemon for build ${this.deps.buildId}`);
        this.deps.spawnDaemon(path);
      } else {
        this.deps.log(`daemon for build ${this.deps.buildId} is slow to answer - waiting`);
      }
      const deadline = Date.now() + (this.deps.startTimeoutMs ?? 5000);
      let lastError: unknown = null;
      while (Date.now() < deadline) {
        await this.sleep(this.deps.pollMs ?? 50);
        try {
          return this.attach(await this.deps.connect(path));
        } catch (err) {
          lastError = err;
        }
      }
      throw new Error(`daemon did not answer on ${path}: ${String(lastError)}`);
    };
    this.startingOwn = attempt().finally(() => {
      this.startingOwn = null;
    });
    return this.startingOwn;
  }

  /** Register a connected daemon: routes, events, the close handler. */
  private attach(client: ClientLike): ClientLike {
    // A connect that resolved after `shutdown()` (a remote host dropped while
    // its reconnect was in flight): nobody routes to it any more - closing it
    // is what ends its ssh bridge, which would otherwise live forever.
    if (this.shuttingDown) {
      client.close();
      return client;
    }
    // Two connects raced to the same daemon (a drop's reconnect and a spawn's
    // start): keep the first, or the other stays open, unreferenced, and the
    // daemon never idles out while the app runs.
    const existing = this.clients.get(client.socketPath);
    if (existing && existing !== client && !existing.closed) {
      client.close();
      return existing;
    }
    this.clients.set(client.socketPath, client);
    if (client.buildId === this.deps.buildId && !client.stale) this.current = client;
    // An id two live daemons both hold: a terminal respawned under its id
    // after its daemon was given up for lost (a socket hiccup, a daemon too
    // slow at boot), and that daemon is back on a later launch. The copy the
    // user's tab last ran on is the respawn, and a respawn always goes to
    // THIS build's daemon - so that daemon wins when it is one of the two;
    // between two older builds the one attached first does (a fixed order,
    // compatibleSockets). The other copy is ended as a tab close ends a shell
    // (SIGHUP through the pty, never SIGKILL) and logged.
    const terminals: TerminalSummary[] = [];
    for (const t of client.welcome.terminals) {
      const holder = this.routes.get(t.id);
      if (holder && holder !== client && !holder.closed) {
        const winner =
          this.isCurrentBuild(client) && !this.isCurrentBuild(holder) ? client : holder;
        const loser = winner === client ? holder : client;
        this.deps.log(
          `terminal ${t.id} is held by two daemons (${holder.socketPath} and ${client.socketPath}) - keeping ${winner.socketPath}'s copy, ending the other`,
        );
        loser.cast('kill', { id: t.id });
        if (winner === client) {
          this.routes.set(t.id, client);
          terminals.push(t);
        }
        continue;
      }
      this.routes.set(t.id, client);
      terminals.push(t);
    }
    // The extension sees every daemon attached - an older build's still
    // running its work, say, which it may ask to stop.
    this.deps.onAttach?.({
      current: this.isCurrentBuild(client),
      welcome: client.welcome,
      cast: (op, args) => client.cast(op, args),
    });
    client.onExtensionEvent?.((ev) => {
      if (client === this.current) for (const l of this.extensionListeners) l(ev);
    });
    // A host's op answers go to the connection that asked - this build's.
    client.onHostOpEvent?.((ev) => {
      if (client === this.current) for (const l of this.hostOpListeners) l(ev);
    });
    // Several apps on one daemon (spec 14): the grid another app set, a
    // snapshot this one owes, who else is attached.
    if (client.welcome.peers) this.peerCounts.set(client, client.welcome.peers);
    client.onViewEvent?.((ev) => {
      if (ev.type === 'peers') {
        this.peerCounts.set(client, { own: ev.own, other: ev.other });
        for (const l of this.peerListeners) l();
        return;
      }
      if (this.routes.get(ev.id) !== client) return;
      if (ev.type === 'terminal-size') {
        const own = ev.by === client.welcome.connectionId;
        const inFlight = this.claimsInFlight.get(ev.id);
        if (own) {
          // Our claim came back: every grid applied before it has arrived.
          if (inFlight && inFlight.client === client && (ev.seq ?? Infinity) >= inFlight.seq) {
            this.claimsInFlight.delete(ev.id);
          }
        } else if (inFlight && inFlight.client === client) {
          // Another app's grid applied BEFORE our newer claim (it crossed it
          // on the wire): following it would undo our own (review, 2026-10-31).
          return;
        }
        this.emit({ type: 'grid', id: ev.id, cols: ev.cols, rows: ev.rows, own });
      } else this.emit({ type: 'snapshot-needed', id: ev.id });
    });
    for (const l of this.peerListeners) l();
    client.onEvent((ev) => {
      // Only the daemon that holds a terminal speaks for it.
      if (this.routes.get(ev.id) !== client) return;
      if (ev.type === 'exit') {
        this.routes.delete(ev.id);
        this.claimsInFlight.delete(ev.id);
      }
      this.emit(ev);
    });
    client.onClose(() => void this.onClientGone(client));
    this.deps.log(
      `attached to daemon ${client.socketPath} (build ${client.buildId}, ${terminals.length} terminal${terminals.length === 1 ? '' : 's'}${client.stale ? ', stale' : ''})`,
    );
    if (terminals.length > 0) this.emit({ type: 'discovered', terminals });
    // A new connection to this build's daemon: whatever lived on the last one
    // (a remote host's watches) is armed again (spec 7.6).
    if (client === this.current) for (const l of this.currentListeners) l();
    return client;
  }

  /**
   * The host-op side of this backend (a private plan ›
   * 7.4-7.6): calls to this build's daemon, its streamed answers, and a
   * notice each time a new connection to it attaches - watches and other
   * per-connection state die with a connection and are re-armed on it.
   */
  onHostOpEvent(listener: (ev: HostOpEvent) => void): () => void {
    this.hostOpListeners.add(listener);
    return () => this.hostOpListeners.delete(listener);
  }

  /**
   * The extension's events from this build's daemon, without starting one (a
   * remote host's - `extensionChannel` is the local daemon's door).
   */
  onExtensionEvent(listener: (ev: ExtensionEvent) => void): () => void {
    this.extensionListeners.add(listener);
    return () => this.extensionListeners.delete(listener);
  }

  /** This build's daemon is gone for good - the extension's work there with it. */
  onExtensionLost(listener: () => void): () => void {
    this.extensionLostListeners.add(listener);
    return () => this.extensionLostListeners.delete(listener);
  }

  onCurrentAttached(listener: () => void): () => void {
    this.currentListeners.add(listener);
    return () => this.currentListeners.delete(listener);
  }

  /** Whether this build's daemon is attached now (a call would be sent). */
  hasCurrent(): boolean {
    return !!this.current && !this.current.closed;
  }

  /**
   * A daemon's socket dropped. Try to get it back a few times - a main-side
   * hiccup leaves the daemon running - and compare its terminals; only the
   * ones that are gone are reported lost. Give up and everything routed to
   * it is lost.
   */
  private async onClientGone(client: ClientLike): Promise<void> {
    if (this.clients.get(client.socketPath) !== client) return;
    this.clients.delete(client.socketPath);
    // Its peers go too, and its claims will never come back.
    this.peerCounts.delete(client);
    for (const [id, c] of [...this.claimsInFlight])
      if (c.client === client) this.claimsInFlight.delete(id);
    for (const l of this.peerListeners) l();
    if (this.current === client) this.current = null;
    const held = [...this.routes].filter(([, c]) => c === client).map(([id]) => id);
    if (this.shuttingDown) return;
    this.deps.log(`daemon ${client.socketPath} disconnected (${held.length} terminals routed)`);
    if (this.deps.lossPolicy === 'patient') return this.reconnectPatiently(client, held);
    const attempts = this.deps.reconnectAttempts ?? 5;
    // A spawn in the gap may have reconnected this path already (startOwn):
    // take that connection over a second one, which would stay open
    // unreferenced and keep the daemon from ever idling out.
    const replaced = (): ClientLike | null => {
      const other = this.clients.get(client.socketPath);
      return other && other !== client && !other.closed ? other : null;
    };
    const settleOn = (live: ClientLike): void => {
      const alive = new Set(live.welcome.terminals.map((t) => t.id));
      const lost = held.filter((id) => !alive.has(id));
      for (const id of lost) if (this.routes.get(id) === client) this.routes.delete(id);
      if (lost.length > 0) this.emit({ type: 'lost', ids: lost });
      if (live.buildId === this.deps.buildId) for (const l of this.extensionResyncListeners) l();
    };
    for (let i = 0; i < attempts; i++) {
      await this.sleep(this.deps.pollMs ?? 50);
      const other = replaced();
      if (other) return settleOn(other);
      try {
        const again = await this.deps.connect(client.socketPath);
        const raced = replaced();
        if (raced) {
          again.close();
          return settleOn(raced);
        }
        // Re-route what it still has; the rest died with whatever happened.
        const alive = new Set(again.welcome.terminals.map((t) => t.id));
        for (const id of held) if (!alive.has(id)) this.routes.delete(id);
        this.attach(again);
        const lost = held.filter((id) => !alive.has(id));
        if (lost.length > 0) this.emit({ type: 'lost', ids: lost });
        // The same daemon is back, but extension events sent in the gap are gone.
        if (again.buildId === this.deps.buildId) for (const l of this.extensionResyncListeners) l();
        return;
      } catch {
        // Keep trying.
      }
    }
    for (const id of held) this.routes.delete(id);
    if (held.length > 0) this.emit({ type: 'lost', ids: held });
    // This build's daemon is gone for good: the extension's work went with it.
    if (client.buildId === this.deps.buildId) for (const l of this.extensionLostListeners) l();
  }

  /**
   * A remote daemon dropped (`lossPolicy: 'patient'`): its terminals are
   * reported unreachable - never lost, never exited - and the socket is tried
   * again with backoff for as long as the backend lives. Once it answers,
   * what it still holds is re-routed and reachable again (the windows replay
   * what they missed), and only what it no longer lists is lost.
   */
  private async reconnectPatiently(client: ClientLike, held: string[]): Promise<void> {
    if (held.length > 0) this.emit({ type: 'unreachable', ids: held });
    const backoff = this.deps.backoffMs ?? reconnectBackoffMs;
    for (let attempt = 0; !this.shuttingDown; attempt++) {
      await this.sleep(backoff(attempt));
      if (this.shuttingDown) return;
      // A spawn (or another drop's loop) got there first.
      const other = this.clients.get(client.socketPath);
      let live: ClientLike | null = other && other !== client && !other.closed ? other : null;
      if (!live) {
        try {
          live = await this.deps.connect(client.socketPath);
          if (this.shuttingDown) {
            live.close();
            return;
          }
        } catch (err) {
          // The host answered and the daemon is gone (an older build that
          // idle-exited, a crash): what it held died with it.
          if (isDeadSocketError(err) || isMissingSocketError(err)) {
            const gone = held.filter((id) => this.routes.get(id) === client);
            for (const id of gone) this.routes.delete(id);
            if (gone.length > 0) this.emit({ type: 'lost', ids: gone });
            // A host daemon of this build that is gone took the extension's work
            // with it (plan 29 spec › 3.3): their open turns are closed.
            if (client.buildId === this.deps.buildId)
              for (const l of this.extensionLostListeners) l();
            return;
          }
          continue;
        }
        const raced = this.clients.get(client.socketPath);
        if (raced && raced !== client && !raced.closed) {
          live.close();
          live = raced;
        } else {
          // Drop the routes of what died first, so `attach` re-routes the rest.
          const alive = new Set(live.welcome.terminals.map((t) => t.id));
          for (const id of held)
            if (!alive.has(id) && this.routes.get(id) === client) this.routes.delete(id);
          live = this.attach(live);
        }
      }
      const alive = new Set(live.welcome.terminals.map((t) => t.id));
      const back = held.filter((id) => alive.has(id));
      const lost = held.filter((id) => !alive.has(id));
      for (const id of lost) if (this.routes.get(id) === client) this.routes.delete(id);
      if (lost.length > 0) this.emit({ type: 'lost', ids: lost });
      if (back.length > 0) this.emit({ type: 'reachable', ids: back });
      if (live.buildId === this.deps.buildId) for (const l of this.extensionResyncListeners) l();
      return;
    }
  }

  /**
   * The extension's channel: calls go to this build's daemon - started on
   * demand, like a spawn - and its events come back; `onLost` fires when that
   * daemon is gone for good.
   */
  async extensionChannel(): Promise<ExtensionChannel> {
    await this.readyPromise;
    return {
      call: async <T>(op: CallOp, args: Record<string, unknown>): Promise<T> => {
        let target = this.current;
        if (!target || target.closed) target = await this.startOwn();
        return target.call<T>(op, args);
      },
      onEvent: (listener) => {
        this.extensionListeners.add(listener);
        return () => this.extensionListeners.delete(listener);
      },
      onLost: (listener) => {
        this.extensionLostListeners.add(listener);
        return () => this.extensionLostListeners.delete(listener);
      },
      onResync: (listener) => {
        this.extensionResyncListeners.add(listener);
        return () => this.extensionResyncListeners.delete(listener);
      },
    };
  }

  /**
   * The welcome of this build's daemon when it holds terminal `id` (null when
   * an older build's daemon or nobody does) - an extension reads whether it
   * runs its work beside that terminal off its own welcome fields.
   */
  async currentDaemonWelcome(id: string): Promise<Readonly<Record<string, unknown>> | null> {
    await this.readyPromise;
    const client = this.routes.get(id);
    return client && client === this.current ? client.welcome : null;
  }

  /**
   * A call to this build's daemon only - a remote host's `fsReadDir` (M1).
   * Rejects when it is not connected; never starts one.
   */
  async callCurrent<T>(op: CallOp, args: Record<string, unknown>): Promise<T> {
    const target = this.current;
    if (!target || target.closed) throw new Error('not connected');
    return target.call<T>(op, args);
  }

  /**
   * A cast to this build's daemon only (a forwarded stream's bytes, M3) -
   * false when it is not connected or lacks `cap`: nothing is queued for a
   * later connection, whose daemon would not know the stream.
   */
  castCurrent(op: CastOp, args: Record<string, unknown>, cap?: DaemonCap): boolean {
    const target = this.current;
    if (!target || target.closed) return false;
    if (cap && target.welcome.caps?.includes(cap) !== true) return false;
    target.cast(op, args);
    return true;
  }

  /** What this build's daemon announced in its welcome ([] when none is attached). */
  currentCaps(): string[] {
    const target = this.current;
    return target && !target.closed ? [...(target.welcome.caps ?? [])] : [];
  }

  /** Whether this build's daemon is connected and announces `cap`. */
  currentSupports(cap: DaemonCap): boolean {
    const target = this.current;
    return !!target && !target.closed && target.welcome.caps?.includes(cap) === true;
  }

  /**
   * How many other apps are attached to the daemons this backend talks to
   * (spec 14) - Settings › Hosts names them, Remove runtime refuses while
   * any is there. A daemon that cannot say (it predates the count) counts
   * none: it is usually just this laptop's own older build still running its
   * terminals after an update - counting it as "another computer" refused
   * Remove runtime and named a computer that was not there (review,
   * 2026-10-31). Its terminals already keep Remove runtime refused.
   */
  peers(): number {
    let n = 0;
    for (const client of this.clients.values()) {
      const count = this.peerCounts.get(client);
      if (count) n += count.own + count.other;
    }
    return n;
  }

  onPeersChange(listener: () => void): () => void {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }

  // --- TerminalBackend ---------------------------------------------------------------

  async spawn(req: HostSpawnRequest): Promise<boolean | 'existing' | 'unknown'> {
    await this.readyPromise;
    let target = this.current;
    if (!target || target.closed) {
      try {
        target = await this.startOwn();
      } catch (err) {
        this.deps.log(`spawn of ${req.id} failed: ${String(err)}`);
        return false;
      }
    }
    // Routed before the reply so the input / resize casts that follow the
    // create reach the same daemon, in order behind the spawn.
    this.routes.set(req.id, target);
    try {
      const ok = await target.call<boolean>('spawn', req);
      if (ok) return true;
      // Refused: maybe the daemon still holds a live shell under this id
      // (it was reported lost while stalled, the tab was reopened). Keep the
      // route and let the caller adopt it - otherwise the shell is orphaned
      // and every reopen fails the same way.
      const held = await target
        .call<TerminalSummary[]>('list', {})
        .then((list) => list.some((t) => t.id === req.id))
        .catch(() => false);
      if (held) return 'existing';
      if (this.routes.get(req.id) === target) this.routes.delete(req.id);
      return false;
    } catch (err) {
      // The reply was lost with a remote host's connection (spec 7.11): the
      // shell may or may not run there. Never a failure - the host router
      // asks again once the host is back, and a spawn that did land comes
      // back refused, listed and adopted ('existing').
      if (this.deps.lossPolicy === 'patient' && isOutcomeUnknown(err)) {
        this.deps.log(`spawn of ${req.id}: reply lost with the connection - outcome unknown`);
        return 'unknown';
      }
      this.deps.log(`spawn of ${req.id} failed: ${String(err)}`);
      if (this.routes.get(req.id) === target) this.routes.delete(req.id);
      return false;
    }
  }

  async list(): Promise<TerminalSummary[]> {
    await this.readyPromise;
    const out: TerminalSummary[] = [];
    for (const client of this.clients.values()) {
      try {
        out.push(...(await client.call<TerminalSummary[]>('list', {})));
      } catch {
        // A daemon mid-disconnect lists nothing.
      }
    }
    return out;
  }

  async adopt(id: string): Promise<TerminalSnapshot | null> {
    const client = this.routes.get(id);
    if (!client) return null;
    try {
      return await client.call<TerminalSnapshot | null>('adopt', { id });
    } catch {
      return null;
    }
  }

  input(id: string, data: string): void {
    this.routes.get(id)?.cast('input', { id, data });
  }
  resize(id: string, cols: number, rows: number, kind: ResizeKind = 'claim'): void {
    const client = this.routes.get(id);
    if (!client) return;
    // A daemon several apps share takes the intent (spec 14); any other the
    // plain resize, as before.
    if (client.welcome.caps?.includes('resizeIntents')) {
      const seq = ++this.intentSeq;
      if (kind === 'claim') this.claimsInFlight.set(id, { client, seq });
      client.cast('resizeIntent', { id, cols, rows, kind, seq });
    } else client.cast('resize', { id, cols, rows });
  }
  pause(id: string): void {
    this.routes.get(id)?.cast('pause', { id });
  }
  resume(id: string): void {
    this.routes.get(id)?.cast('resume', { id });
  }
  kill(id: string): void {
    const client = this.routes.get(id);
    if (!client) return;
    this.routes.delete(id);
    client.cast('kill', { id });
  }
  setTone(dark: boolean): void {
    for (const client of this.clients.values()) client.cast('setTone', { dark });
  }
  noteLine(id: string, text: string, ref: number): void {
    this.routes.get(id)?.cast('noteLine', { id, text, ref });
  }

  private async ask<T>(
    id: string,
    op: 'size' | 'foregroundBusy' | 'inputList',
    fallback: T,
  ): Promise<T> {
    const client = this.routes.get(id);
    if (!client) return fallback;
    try {
      return await client.call<T>(op, { id });
    } catch {
      return fallback;
    }
  }

  size(id: string): Promise<{ cols: number; rows: number } | null> {
    return this.ask(id, 'size', null);
  }
  foregroundBusy(id: string): Promise<boolean> {
    return this.ask(id, 'foregroundBusy', false);
  }
  inputList(id: string): Promise<InputEntry[]> {
    return this.ask(id, 'inputList', []);
  }

  /** Ask each daemon about the ids it holds and merge the answers. */
  private async fanOut<T>(ids: string[], op: 'markerDriven' | 'agentStatus'): Promise<T[]> {
    const byClient = new Map<ClientLike, string[]>();
    for (const id of ids) {
      const client = this.routes.get(id);
      if (!client) continue;
      const list = byClient.get(client) ?? [];
      list.push(id);
      byClient.set(client, list);
    }
    const out: T[] = [];
    for (const [client, subset] of byClient) {
      try {
        out.push(...(await client.call<T[]>(op, { ids: subset })));
      } catch {
        // A daemon mid-disconnect answers nothing for its ids.
      }
    }
    return out;
  }

  markerDriven(ids: string[]): Promise<string[]> {
    return this.fanOut<string>(ids, 'markerDriven');
  }
  agentStatus(ids: string[]): Promise<{ id: string; status: AgentStatus }[]> {
    return this.fanOut<{ id: string; status: AgentStatus }>(ids, 'agentStatus');
  }

  /**
   * Stop every terminal of every attached daemon. False when one could not be
   * told (a dropped connection): its terminals are still alive there, so its
   * routes stay - only a daemon that answered loses them.
   */
  async killAll(): Promise<boolean> {
    await this.readyPromise;
    const clients = [...this.clients.values()];
    const answered = await Promise.all(
      clients.map((client) =>
        client.call('killAll', {}).then(
          () => true,
          () => false,
        ),
      ),
    );
    for (const [id, client] of [...this.routes]) {
      const i = clients.indexOf(client);
      if (i < 0 || answered[i]) this.routes.delete(id);
    }
    return answered.every(Boolean);
  }

  /**
   * Quit. Keeping sessions means simply letting go of the sockets - the
   * daemons resume any paused pty and carry on. Stopping asks every daemon to
   * kill its shells, wait for them and exit (the reply comes after the wait).
   */
  async shutdown(opts: { stopSessions: boolean }): Promise<void> {
    this.shuttingDown = true;
    await this.readyPromise.catch(() => undefined);
    const clients = [...this.clients.values()];
    if (opts.stopSessions) {
      await Promise.all(clients.map((c) => c.call('shutdown', {}).catch(() => undefined)));
    }
    for (const c of clients) c.close();
    this.clients.clear();
    this.routes.clear();
    this.current = null;
  }
}
