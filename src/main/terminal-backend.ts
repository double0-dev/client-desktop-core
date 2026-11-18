import type { CallOp, ResizeKind } from './daemon/protocol';
import type { AgentStatus } from './terminal-modes';
import type { ExtensionChannel } from './daemon/extension-channel';
import type { InputEntry } from './terminal-inputs';
import {
  PtyHost,
  type HostEvent,
  type HostSpawnRequest,
  type PtySpawner,
  type TerminalSnapshot,
  type TerminalSummary,
} from './pty-host';

/**
 * Where main's terminals actually live: in this process (a `PtyHost` over
 * node-pty) or in the session daemon (daemon/daemon-backend.ts), which keeps
 * them running after the app quits (a private plan).
 * terminal.ts drives either through this interface and keeps window
 * ownership, routing and the renderer batching for itself.
 *
 * Commands that need no answer are fire-and-forget (`void`): over the daemon
 * socket they are casts, and ordering on one socket is exact. Queries are
 * promises. Every operation may be called before `ready()` settles; the
 * implementations queue or answer "unknown" as documented per method.
 */
export interface TerminalBackend {
  /**
   * Settles once the backend can take requests - at once in-process, after
   * the daemon list arrived (and `discovered` was emitted) for the daemon.
   * Never rejects: a daemon that cannot start falls back in-process.
   */
  ready(): Promise<void>;
  onEvent(listener: (ev: BackendEvent) => void): () => void;
  /**
   * False when the shell could not start (the caller reports an exit);
   * 'existing' when the id is already live where it was sent - a daemon that
   * kept the shell while main had written it off - and the caller adopts it.
   * 'unknown' only from a remote host's patient backend: the reply was lost
   * with the connection (spec 7.11) - the host router parks the spawn until
   * the host is back and asks again, where a shell that did start comes back
   * as 'existing'. terminal.ts never sees it.
   */
  spawn(req: HostSpawnRequest): Promise<boolean | 'existing' | 'unknown'>;
  list(): Promise<TerminalSummary[]>;
  /** Null for an unknown id. */
  adopt(id: string): Promise<TerminalSnapshot | null>;
  input(id: string, data: string): void;
  /**
   * `kind` matters only on a daemon several apps share (a remote host, spec
   * 14): `claim` = the user interacted, `passive` = a refit nobody asked for.
   * Absent = a claim (the old "last resize wins").
   */
  resize(id: string, cols: number, rows: number, kind?: ResizeKind): void;
  pause(id: string): void;
  resume(id: string): void;
  /** Kill and forget a terminal (a tab close) - no exit event follows. */
  kill(id: string): void;
  setTone(dark: boolean): void;
  noteLine(id: string, text: string, ref: number): void;
  size(id: string): Promise<{ cols: number; rows: number } | null>;
  foregroundBusy(id: string): Promise<boolean>;
  /** Which of `ids` speak the status-marker protocol. */
  markerDriven(ids: string[]): Promise<string[]>;
  /** What each marker-driven terminal among `ids` is doing. */
  agentStatus(ids: string[]): Promise<{ id: string; status: AgentStatus }[]>;
  inputList(id: string): Promise<InputEntry[]>;
  /**
   * Kill every terminal, keep the backend (Settings › Sessions › Stop all).
   * The host router takes a host id (null = this machine); a single machine's
   * backend ignores it. `false` = the kill did not reach the terminals (a host
   * that is not connected): they still run, nothing may report them ended.
   */
  killAll(hostId?: string | null): Promise<void | boolean>;
  /**
   * App quit. `stopSessions` kills everything and settles once the shells
   * are gone (the caller caps the wait); otherwise the terminals live on
   * (the daemon keeps them; in-process they cannot, so they are killed).
   */
  shutdown(opts: { stopSessions: boolean }): Promise<void>;
  /**
   * An extension's work in the daemon: the channel to this build's daemon
   * once it is the chosen backend, null when terminals (and so that work)
   * stay in-process. Absent = no daemon.
   */
  extensionChannel?(): Promise<ExtensionChannel | null>;
  /**
   * The welcome of this build's daemon when it holds terminal `id` (null:
   * in-process, or an older build's daemon) - the extension reads off its own
   * fields whether its work runs beside that terminal.
   */
  currentDaemonWelcome?(id: string): Promise<Readonly<Record<string, unknown>> | null>;
  /**
   * A call to this build's daemon only, never starting one (an extension's
   * ops beside a terminal, a remote host's folder listing - DaemonBackend ›
   * callCurrent).
   */
  callCurrent?<T>(op: CallOp, args: Record<string, unknown>): Promise<T>;
  /**
   * The remote host a terminal runs on, null for this machine - only the
   * host router (hosts/host-router.ts) knows; absent = everything is local.
   */
  hostOf?(id: string): string | null;
  /**
   * The session daemons this machine's terminals run in, each with the ids it
   * holds (Settings › Sessions, and the move of idle sessions off an older
   * build: daemon-migrate.ts). Absent or empty = terminals run in-process.
   */
  daemons?(): DaemonInfo[];
}

/** One session daemon as main sees it. */
export type DaemonInfo = {
  socketPath: string;
  buildId: string;
  /** This build's daemon: the one new shells go to. */
  current: boolean;
  /** The local terminals it holds. */
  ids: string[];
};

export type BackendEvent =
  | HostEvent
  /** Terminals found live in a daemon (at startup, or a daemon reconnecting). */
  | { type: 'discovered'; terminals: TerminalSummary[] }
  /** Terminals that died with their daemon - no exit event will come for them. */
  | { type: 'lost'; ids: string[] }
  /**
   * A remote host's daemon dropped (a private plan ›
   * 9.4): its terminals are NOT gone - they run on the host and come back
   * with `reachable` once the bridge reconnects. Never an exit.
   */
  | { type: 'unreachable'; ids: string[]; hostId?: string }
  /** Reconnected: these terminals are live again (the window replays what it missed). */
  | { type: 'reachable'; ids: string[]; hostId?: string }
  /**
   * The grid a shared terminal runs at (a private plan
   * › 14): `own` = this app's intent set it; otherwise another app's claim
   * did and this app's windows fit their xterm to it, never the pty.
   */
  | { type: 'grid'; id: string; cols: number; rows: number; own: boolean }
  /** This app fell too far behind on a paused shared terminal: re-adopt it. */
  | { type: 'snapshot-needed'; id: string };

/** Terminals in this process - the pre-daemon behaviour, and the fallback. */
export class InProcessBackend implements TerminalBackend {
  readonly host: PtyHost;

  constructor(spawner: PtySpawner) {
    this.host = new PtyHost(spawner);
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }
  onEvent(listener: (ev: BackendEvent) => void): () => void {
    return this.host.onEvent(listener);
  }
  spawn(req: HostSpawnRequest): Promise<boolean | 'existing'> {
    return Promise.resolve(this.host.spawn(req));
  }
  list(): Promise<TerminalSummary[]> {
    return Promise.resolve(this.host.list());
  }
  adopt(id: string): Promise<TerminalSnapshot | null> {
    return Promise.resolve(this.host.adopt(id));
  }
  input(id: string, data: string): void {
    this.host.input(id, data);
  }
  resize(id: string, cols: number, rows: number): void {
    this.host.resize(id, cols, rows);
  }
  pause(id: string): void {
    this.host.pause(id);
  }
  resume(id: string): void {
    this.host.resume(id);
  }
  kill(id: string): void {
    this.host.kill(id);
  }
  setTone(dark: boolean): void {
    this.host.setTone(dark);
  }
  noteLine(id: string, text: string, ref: number): void {
    this.host.noteLine(id, text, ref);
  }
  size(id: string): Promise<{ cols: number; rows: number } | null> {
    return Promise.resolve(this.host.size(id));
  }
  foregroundBusy(id: string): Promise<boolean> {
    return this.host.foregroundBusy(id);
  }
  markerDriven(ids: string[]): Promise<string[]> {
    return Promise.resolve(ids.filter((id) => this.host.markerDriven(id)));
  }
  agentStatus(ids: string[]): Promise<{ id: string; status: AgentStatus }[]> {
    const out: { id: string; status: AgentStatus }[] = [];
    for (const id of ids) {
      const status = this.host.agentStatus(id);
      if (status) out.push({ id, status });
    }
    return Promise.resolve(out);
  }
  inputList(id: string): Promise<InputEntry[]> {
    return Promise.resolve(this.host.inputList(id));
  }
  killAll(): Promise<void> {
    return this.host.killAll();
  }
  /** In-process terminals cannot outlive the app: quit always kills them. */
  shutdown(): Promise<void> {
    return this.host.killAll();
  }
}

/**
 * The daemon when it answers, in-process when it does not (a disabled
 * run-as-node fuse, an unwritable userData, a daemon that never came up):
 * one `ready()` that settles either way, every call delegated to whichever
 * won. Calls made before the decision wait for it, in order.
 */
export function createTerminalBackend(opts: {
  /** The daemon backend; its `ready()` MAY reject - that is the fallback trigger. */
  daemon: TerminalBackend & { ready(): Promise<void> };
  fallback: TerminalBackend;
  log: (message: string) => void;
}): TerminalBackend {
  let chosen: TerminalBackend | null = null;
  const listeners = new Set<(ev: BackendEvent) => void>();
  const forward = (ev: BackendEvent): void => {
    for (const l of listeners) l(ev);
  };
  // The daemon is listened to from the start: it emits `discovered` (the
  // terminals that outlived the last run) WHILE booting, before `ready()`
  // settles. Subscribing only after the decision dropped that event, so no
  // tab ever re-adopted its live terminal - each spawned a duplicate under the
  // same id on this build's daemon instead (2026-10-04).
  opts.daemon.onEvent((ev) => {
    if (chosen !== opts.fallback) forward(ev);
  });
  const ready: Promise<void> = opts.daemon.ready().then(
    () => {
      chosen = opts.daemon;
    },
    (err: unknown) => {
      opts.log(`session daemon unavailable, terminals stay in-process: ${String(err)}`);
      chosen = opts.fallback;
      opts.fallback.onEvent(forward);
    },
  );
  // Once decided, calls and casts reach the backend synchronously and in the
  // order they were made (a queued call behind a synchronous cast would put
  // an input ahead of the adopt it followed). Before the decision both wait
  // on the same promise, whose reactions run FIFO.
  const after = <T>(fn: (b: TerminalBackend) => Promise<T>): Promise<T> =>
    chosen ? fn(chosen) : ready.then(() => fn(chosen!));
  const cast = (fn: (b: TerminalBackend) => void): void => {
    if (chosen) fn(chosen);
    else void ready.then(() => fn(chosen!));
  };
  return {
    ready: () => ready,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    spawn: (req) => after((b) => b.spawn(req)),
    list: () => after((b) => b.list()),
    adopt: (id) => after((b) => b.adopt(id)),
    input: (id, data) => cast((b) => b.input(id, data)),
    // The kind travels on (a remote-capable daemon may read it); none = as before.
    resize: (id, cols, rows, kind) =>
      cast((b) => (kind ? b.resize(id, cols, rows, kind) : b.resize(id, cols, rows))),
    pause: (id) => cast((b) => b.pause(id)),
    resume: (id) => cast((b) => b.resume(id)),
    kill: (id) => cast((b) => b.kill(id)),
    setTone: (dark) => cast((b) => b.setTone(dark)),
    noteLine: (id, text, ref) => cast((b) => b.noteLine(id, text, ref)),
    size: (id) => after((b) => b.size(id)),
    foregroundBusy: (id) => after((b) => b.foregroundBusy(id)),
    markerDriven: (ids) => after((b) => b.markerDriven(ids)),
    agentStatus: (ids) => after((b) => b.agentStatus(ids)),
    inputList: (id) => after((b) => b.inputList(id)),
    killAll: () => after((b) => b.killAll()),
    shutdown: (o) => after((b) => b.shutdown(o)),
    // The extension's work follows the terminals: in the daemon when it won,
    // else in-process.
    extensionChannel: () =>
      ready.then(() =>
        chosen === opts.daemon && opts.daemon.extensionChannel
          ? opts.daemon.extensionChannel()
          : null,
      ),
    daemons: () => (chosen === opts.daemon ? (opts.daemon.daemons?.() ?? []) : []),
    currentDaemonWelcome: (id) =>
      ready.then(() =>
        chosen === opts.daemon && opts.daemon.currentDaemonWelcome
          ? opts.daemon.currentDaemonWelcome(id)
          : null,
      ),
  };
}
