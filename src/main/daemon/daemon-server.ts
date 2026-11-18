import { createServer, type Server, type Socket } from 'node:net';
import { statSync, unlinkSync } from 'node:fs';
import type { HostSpawnRequest, PtyHost } from '../pty-host';
import { IDLE_EXIT_GRACE_MS, IdleExitWatch } from './idle-exit';
import type { HostLsp, HostOps, OpConnection } from './host-ops-api';
import { ResizeArbiter } from './resize-intents';
import { FlowAccounting } from './flow-accounting';
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeFrame,
  idArgs,
  idsArgs,
  inputArgs,
  noteLineArgs,
  parseClientFrame,
  resizeArgs,
  resizeIntentArgs,
  spawnArgs,
  toneArgs,
  validateHello,
  MAX_FRAME_BYTES,
  DAEMON_CAPS,
  runsBesideChain,
  castRunsBesideChain,
  fsReadDirArgs,
  type CallFrame,
  type CastFrame,
  type ExtensionEvent,
  type HostOpEvent,
  type PeerCount,
  type ResizeKind,
  type ViewEvent,
  type WelcomeFrame,
} from './protocol';

/**
 * The session daemon's socket server over a `PtyHost` (a private plan).
 * Pure node: the entry (daemon-main.ts) wires node-pty, the paths and the
 * signals around it; the test drives it over a real socket with a fake pty
 * factory.
 *
 * Rules: the first frame must be a valid `hello` or the connection closes;
 * calls are answered in order; every host event fans out to every
 * authenticated client; when the last client leaves, every pty flows again
 * (nobody is left to drain a paused one); with no terminals and no clients of its own build
 * for the grace period the daemon exits and removes its socket.
 */
/** A connection that has not said hello by then is dropped. */
const HELLO_TIMEOUT_MS = 5000;

/** Room left in a reply frame for its envelope. */
export const REPLY_BUDGET = MAX_FRAME_BYTES - 64 * 1024;

/**
 * A history as the part a reply frame can carry and the rest (the rest goes
 * as events after the reply). Null (no history) stays null.
 */
export function splitHistory<T>(
  history: T[] | null,
  budget = REPLY_BUDGET,
): { head: T[] | null; rest: T[] } {
  if (!history) return { head: null, rest: [] };
  let used = 2;
  let i = 0;
  for (; i < history.length; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(history[i])) + 1;
    if (used + bytes > budget) break;
    used += bytes;
  }
  return { head: history.slice(0, i), rest: history.slice(i) };
}

export type DaemonServerOptions = {
  socketPath: string;
  token: string;
  buildId: string;
  appVersion: string;
  host: PtyHost;
  /**
   * An extension's work on this daemon (agents beside the terminals, requests
   * relayed to the apps): its calls under their wire names, its events to the
   * clients of this daemon's own build. Absent: its calls are unknown ops.
   */
  extension?: DaemonServerExtension;
  /**
   * Turns a spawn request into what the host runs - the remote daemon's
   * `hostShell` resolution (remote-spawn.ts). Absent = spawned as sent.
   */
  prepareSpawn?: (req: HostSpawnRequest) => HostSpawnRequest | Promise<HostSpawnRequest>;
  /** Capabilities beyond DAEMON_CAPS this daemon announces (REMOTE_CAPS). */
  extraCaps?: readonly string[];
  /** A host folder listing (remote-fs.ts) - only a remote daemon answers `fsReadDir`. */
  fsReadDir?: (args: { path: string; dirsOnly: boolean }) => Promise<unknown>;
  /**
   * A remote host's processes, files, transfers and watches (host-ops.ts,
   * a private plan › 7.3-7.6) - only a remote daemon
   * has them. Answered beside the chain; refused to a stale client.
   */
  hostOps?: HostOps;
  /**
   * Host-wide events every client of this daemon's own build hears (an
   * extension's, routed with the host ops' - plan 29 spec › 1.3) - unlike a
   * host op's answer, which goes to the one connection that asked.
   */
  hostEvents?: { onEvent(listener: (ev: HostOpEvent | ExtensionEvent) => void): () => void };
  /**
   * Several apps share this daemon (a remote host, a private plan
   * › 14): resize intents decide the grid, each client is flow-controlled on
   * its own, and every client hears what another one ended. Defaults to
   * whether `extraCaps` lists `resizeIntents`; off, everything is as before.
   */
  multiClient?: boolean;
  /**
   * Language servers on the host (daemon/host-lsp.ts, plan 29 spec › 4.1):
   * `lspOpen` / `lspClose` / `lspInstall` beside the chain, `lspSend` beside
   * it in arrival order; a server's messages go to the connection that
   * opened it only, and it dies with that connection. Never counted for the
   * idle exit.
   */
  lsp?: HostLsp;
  /** Grace before an empty, unattended daemon exits. */
  idleGraceMs?: number;
  /** How long a connection may stay silent before its hello (default 5 s). */
  helloTimeoutMs?: number;
  log?: (message: string) => void;
  /** Called once the daemon should end its process (idle, shutdown, signal). */
  onExit: (reason: string) => void;
};

/** A connection, as an extension's call sees it. */
export type ExtensionConnection = {
  id: number;
  /** Its build is not this daemon's: it may drain, never start anything. */
  stale: boolean;
  /** One event to this connection alone. */
  send(ev: object): void;
  /** A body this connection sent with `transferPut` (null when there is none). */
  takeTransfer(transferId: string): Buffer | null;
};

/** What the server hands an extension when it binds it. */
export type ExtensionIo = {
  /** One event to every client of this daemon's own build. */
  broadcast(ev: object): void;
  /** The clients of this daemon's own build, and one event to one of them. */
  recipients(): number[];
  send(connId: number, ev: object): void;
  /** Something that keeps the daemon up started or ended (the idle exit re-counts). */
  changed(): void;
  /** The daemon is shutting down: start nothing that would outlive it. */
  exiting(): boolean;
};

/** An extension's answer to a call; `after` runs once the reply is sent. */
export type ExtensionAnswer = { ok: unknown; after?: () => void } | { fail: string };

/**
 * An extension's work on this daemon (`DaemonServerOptions.extension`). Its
 * calls run beside the chain (`ProtocolExtension.besideChain`) or in it, as
 * its grammar says; a thrown error answers as a failure - never no reply.
 */
export type DaemonServerExtension = {
  /** Wires it to the server; returns the unwiring. */
  bind(io: ExtensionIo): () => void;
  handles(op: string): boolean;
  call(op: string, args: unknown, conn: ExtensionConnection): Promise<ExtensionAnswer>;
  /** One of its casts (unknown casts are ignored). */
  cast?(op: string, args: unknown): void;
  /** What it runs that keeps the daemon up, counted like terminals. */
  count(): number;
  /** Its fields in the welcome (wire names, read by its client side). */
  welcome(): Record<string, unknown>;
  /** Everything it runs stops (`killAll`, `shutdown`, a signal). */
  stopAll(): void;
  /** A client left: what it held goes. */
  connectionGone(connId: number): void;
  /** The server closes. */
  dispose(): void;
};

export type DaemonServer = {
  /** Resolves once the socket listens. */
  listening: Promise<void>;
  clientCount(): number;
  /** Kill everything, wait for the shells, close and exit. */
  shutdown(reason: string): Promise<void>;
  /** Close the socket without touching the terminals (tests). */
  close(): Promise<void>;
};

type Connection = {
  /** The connection's number (an extension names its viewers by it). */
  id: number;
  socket: Socket;
  decoder: FrameDecoder;
  authenticated: boolean;
  /** The client's build is not ours: it may attach, never spawn. */
  stale: boolean;
  /** This connection as the host ops see it (streamed answers go here). */
  op: OpConnection;
};

export function startDaemonServer(opts: DaemonServerOptions): DaemonServer {
  const log = opts.log ?? (() => {});
  const { host, extension } = opts;
  let nextConnection = 0;
  const connections = new Set<Connection>();
  let exiting = false;
  const multiClient = opts.multiClient ?? opts.extraCaps?.includes('resizeIntents') === true;
  const sizes = new ResizeArbiter();
  const flow = new FlowAccounting();
  const attached = (): Connection[] => [...connections].filter((c) => c.authenticated);

  /** Who else is attached, as `c` sees it. */
  const peersOf = (c: Connection): PeerCount => {
    const out = { own: 0, other: 0 };
    for (const o of connections) {
      if (o === c || !o.authenticated) continue;
      if (o.stale) out.other += 1;
      else out.own += 1;
    }
    return out;
  };
  const announcePeers = (): void => {
    if (!multiClient) return;
    for (const c of attached()) send(c, { t: 'event', ev: { type: 'peers', ...peersOf(c) } });
  };
  const sendView = (c: Connection, ev: ViewEvent): void => send(c, { t: 'event', ev });

  /**
   * A resize from client `c`: applied when the arbiter says so, then every
   * client hears the grid (the others fit their xterm to it, spec 14); a
   * passive intent that lost to another client's claim tells `c` alone the
   * grid it must follow.
   */
  const lastApplied = new Map<string, { by: number; seq?: number }>();
  const resizeFrom = (
    c: Connection,
    id: string,
    cols: number,
    rows: number,
    kind: ResizeKind,
    seq?: number,
  ) => {
    if (cols <= 0 || rows <= 0) return;
    if (sizes.intent(id, c.id, kind)) {
      host.resize(id, cols, rows);
      const now = host.size(id);
      if (!now) return;
      lastApplied.set(id, { by: c.id, seq });
      const ev = { type: 'terminal-size' as const, id, cols: now.cols, rows: now.rows, by: c.id };
      for (const o of attached()) sendView(o, seq !== undefined ? { ...ev, seq } : ev);
      return;
    }
    const now = host.size(id);
    const by = sizes.claimant(id);
    if (!now || by === null) return;
    const last = lastApplied.get(id);
    const ev = { type: 'terminal-size' as const, id, ...now, by };
    sendView(c, last?.by === by && last.seq !== undefined ? { ...ev, seq: last.seq } : ev);
  };

  /**
   * Client `c` ended terminals the others may be showing (a tab close, Stop
   * all): `kill` reports no exit, so without this their tabs sat on a shell
   * that was gone.
   */
  const tellOthersEnded = (c: Connection, ids: string[]): void => {
    for (const id of ids) {
      sizes.forget(id);
      flow.forget(id);
      lastApplied.delete(id);
    }
    if (!multiClient) return;
    for (const o of attached()) {
      if (o === c) continue;
      for (const id of ids) send(o, { t: 'event', ev: { type: 'exit', id, exitCode: 0 } });
    }
  };

  const idle = new IdleExitWatch(opts.idleGraceMs ?? IDLE_EXIT_GRACE_MS, () => {
    void shutdown('idle');
  });
  // Only clients of this daemon's own build keep it alive: a newer build's app
  // stays connected to an older daemon just to drain its terminals, so once
  // the last of those is gone the daemon must go too - counting that app kept
  // an empty old daemon running for as long as the app ran (2026-10-04).
  const checkIdle = (): void => {
    if (exiting) return;
    let clients = 0;
    // A connection counts once it said hello: a silent peer must not keep
    // the daemon alive (review, 2026-10-06).
    for (const c of connections) if (c.authenticated && !c.stale) clients += 1;
    // A host's running git / file run counts like a terminal: an idle exit
    // would kill a commit half done (its client may just have dropped).
    idle.update({
      terminals: host.count + (extension?.count() ?? 0) + (opts.hostOps?.running() ?? 0),
      clients,
    });
  };

  const send = (c: Connection, frame: object): void => {
    if (c.socket.destroyed) return;
    try {
      c.socket.write(encodeFrame(frame));
    } catch {
      // The socket is going away; its close handler cleans up.
    }
  };

  // Every host event reaches every attached client. Nothing is buffered for
  // an absent client - the ring buffer in the host is the catch-up (`adopt`).
  const offEvents = host.onEvent((ev) => {
    if (multiClient && ev.type === 'data') {
      // A client that paused this terminal is counted; past the limit its
      // stream stops and it is told to catch up from a snapshot - the others
      // keep theirs (spec 14).
      const bytes = Buffer.byteLength(ev.data);
      for (const c of connections) {
        if (!c.authenticated) continue;
        const verdict = flow.chunk(c.id, ev.id, bytes);
        if (verdict === 'send') send(c, { t: 'event', ev });
        else if (verdict === 'notify') sendView(c, { type: 'snapshot-needed', id: ev.id });
      }
      return;
    }
    for (const c of connections) if (c.authenticated) send(c, { t: 'event', ev });
    if (ev.type === 'exit') {
      sizes.forget(ev.id);
      flow.forget(ev.id);
      lastApplied.delete(ev.id);
      checkIdle();
    }
  });
  const offRunning = opts.hostOps?.onRunningChange(() => checkIdle()) ?? (() => {});
  // An older app attached to drain has no use for them (and would not know
  // the event types).
  const offHostEvents =
    opts.hostEvents?.onEvent((ev) => {
      for (const c of connections) if (c.authenticated && !c.stale) send(c, { t: 'event', ev });
    }) ?? (() => {});
  // The extension's events reach every client of THIS build (an older app
  // attached only to drain terminals has no use for them, and would not know
  // the event types).
  const offExtension =
    extension?.bind({
      broadcast: (ev) => {
        for (const c of connections) if (c.authenticated && !c.stale) send(c, { t: 'event', ev });
      },
      recipients: () =>
        attached()
          .filter((c) => !c.stale)
          .map((c) => c.id),
      send: (connId, ev) => {
        for (const c of connections)
          if (c.id === connId && c.authenticated) send(c, { t: 'event', ev });
      },
      changed: () => checkIdle(),
      exiting: () => exiting,
    }) ?? (() => {});

  /**
   * One host-op event to one connection, resolved once the socket took it:
   * a big transfer or a chatty `git` waits for the kernel instead of piling
   * frames up in memory, and the other connections' frames are not held.
   */
  const emitTo =
    (c: Connection) =>
    (ev: HostOpEvent): Promise<void> =>
      new Promise<void>((resolve) => {
        if (c.socket.destroyed) return resolve();
        let flowing: boolean;
        try {
          flowing = c.socket.write(encodeFrame({ t: 'event', ev }));
        } catch {
          return resolve();
        }
        if (flowing) return resolve();
        const done = (): void => {
          c.socket.off('drain', done);
          c.socket.off('close', done);
          resolve();
        };
        c.socket.once('drain', done);
        c.socket.once('close', done);
      });

  const welcome = (c: Connection, hello: { buildId: string }): void => {
    c.authenticated = true;
    c.stale = hello.buildId !== opts.buildId;
    const frame: WelcomeFrame = {
      t: 'welcome',
      ok: true,
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: opts.appVersion,
      buildId: opts.buildId,
      stale: c.stale,
      terminals: host.list(),
      ...extension?.welcome(),
      caps: [...DAEMON_CAPS, ...(opts.extraCaps ?? [])],
      ...(multiClient ? { connectionId: c.id, peers: peersOf(c) } : {}),
    };
    send(c, frame);
    // The others learn a client joined (Settings › Hosts names it).
    for (const o of attached()) {
      if (o !== c && multiClient) {
        send(o, { t: 'event', ev: { type: 'peers', ...peersOf(o) } });
      }
    }
    // A pty the earlier clients all paused flows again: this one has not.
    if (multiClient) {
      for (const t of host.list()) if (!flow.allPaused(t.id, ids())) host.resume(t.id);
    }
  };
  const ids = (): number[] => attached().map((o) => o.id);

  const reject = (c: Connection, error: string): void => {
    send(c, { t: 'welcome', ok: false, error } satisfies WelcomeFrame);
    c.socket.end();
  };

  const call = async (c: Connection, frame: CallFrame): Promise<void> => {
    const ok = (result: unknown): void => send(c, { t: 'reply', req: frame.req, ok: true, result });
    const fail = (error: string): void => send(c, { t: 'reply', req: frame.req, ok: false, error });
    switch (frame.op) {
      case 'spawn': {
        const req = spawnArgs(frame.args);
        if (!req) return fail('bad args');
        // A daemon of another build must not start new shells: on macOS its
        // node-pty helper path points into a replaced bundle (plan › Phase 2a).
        if (c.stale) return fail('stale');
        // A shell started during shutdown's kill wait would be abandoned.
        if (exiting) return fail('shutting down');
        let request = req;
        try {
          // Only for a NEW terminal: preparing writes the launch script and
          // resets the status line capture, which a live shell under this id (a
          // re-adopt) must keep.
          if (opts.prepareSpawn && host.size(req.id) === null) {
            request = await opts.prepareSpawn(req);
          }
        } catch (err) {
          log(`spawn of ${req.id} not prepared: ${String(err)}`);
          return ok(false);
        }
        const spawned = host.spawn(request);
        checkIdle();
        return ok(spawned);
      }
      case 'adopt': {
        const a = idArgs(frame.args);
        if (!a) return fail('bad args');
        // A fresh snapshot: whatever this client was owed is in it.
        flow.adopted(c.id, a.id);
        return ok(host.adopt(a.id));
      }
      case 'list':
        return ok(host.list());
      case 'size': {
        const a = idArgs(frame.args);
        return a ? ok(host.size(a.id)) : fail('bad args');
      }
      case 'foregroundBusy': {
        const a = idArgs(frame.args);
        return a ? ok(await host.foregroundBusy(a.id)) : fail('bad args');
      }
      case 'markerDriven': {
        const a = idsArgs(frame.args);
        return a ? ok(a.ids.filter((id) => host.markerDriven(id))) : fail('bad args');
      }
      case 'agentStatus': {
        const a = idsArgs(frame.args);
        if (!a) return fail('bad args');
        const out: { id: string; status: string }[] = [];
        for (const id of a.ids) {
          const status = host.agentStatus(id);
          if (status) out.push({ id, status });
        }
        return ok(out);
      }
      case 'inputList': {
        const a = idArgs(frame.args);
        return a ? ok(host.inputList(a.id)) : fail('bad args');
      }
      case 'fsReadDir': {
        const a = fsReadDirArgs(frame.args);
        if (!a) return fail('bad args');
        if (!opts.fsReadDir) return fail('no fs');
        try {
          return ok(await opts.fsReadDir(a));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      }
      case 'ping':
        // Beside the chain: a liveness probe answers even while a slow call
        // holds the chain up (plan 28 › decision 12).
        return ok({ t: Date.now() });
      case 'killAll': {
        extension?.stopAll();
        const ended = host.list().map((t) => t.id);
        await host.killAll();
        tellOthersEnded(c, ended);
        checkIdle();
        return ok(true);
      }
      case 'shutdown':
        // Kill and wait first, answer, THEN close: the reply must leave before
        // the sockets go, so the client's quit knows the shells are gone.
        exiting = true;
        extension?.stopAll();
        await host.killAll().catch(() => undefined);
        ok(true);
        void shutdown('client asked');
        return;
      default:
        if (opts.lsp?.handles(frame.op)) {
          if (c.stale) return fail('stale');
          try {
            return ok(
              await opts.lsp.call(
                frame.op,
                frame.args,
                c.op,
                (id) => opts.hostOps?.takeTransfer(id, c.op) ?? null,
              ),
            );
          } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
          }
        }
        if (opts.hostOps?.handles(frame.op)) {
          // A stale client drains its terminals; it runs nothing on the host.
          if (c.stale) return fail('stale');
          try {
            const { result, after } = await opts.hostOps.handle(frame.op, frame.args, c.op);
            ok(result);
            if (after) await after();
          } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
          }
          return;
        }
        if (extension?.handles(frame.op)) {
          try {
            const answer = await extension.call(frame.op, frame.args, {
              id: c.id,
              stale: c.stale,
              send: (ev) => send(c, { t: 'event', ev }),
              takeTransfer: (id) => opts.hostOps?.takeTransfer(id, c.op) ?? null,
            });
            if ('fail' in answer) return fail(answer.fail);
            ok(answer.ok);
            answer.after?.();
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
          }
          return;
        }
        return fail('unknown op');
    }
  };

  const cast = (c: Connection, frame: CastFrame): void => {
    switch (frame.op) {
      case 'input': {
        const a = inputArgs(frame.args);
        if (a) host.input(a.id, a.data);
        return;
      }
      case 'resize': {
        const a = resizeArgs(frame.args);
        if (!a) return;
        // A client that predates intents resizes because something changed
        // on its side - read as a claim, so it still follows the rules.
        if (multiClient) resizeFrom(c, a.id, a.cols, a.rows, 'claim');
        else host.resize(a.id, a.cols, a.rows);
        return;
      }
      case 'resizeIntent': {
        const a = resizeIntentArgs(frame.args);
        if (!a) return;
        if (multiClient) resizeFrom(c, a.id, a.cols, a.rows, a.kind, a.seq);
        else host.resize(a.id, a.cols, a.rows);
        return;
      }
      case 'pause': {
        const a = idArgs(frame.args);
        if (!a) return;
        if (!multiClient) return host.pause(a.id);
        // Only a terminal that exists: a pause for an id not spawned yet
        // would count a later terminal under that id as paused from birth.
        if (host.size(a.id) === null) return;
        flow.pause(c.id, a.id);
        if (flow.allPaused(a.id, ids())) host.pause(a.id);
        return;
      }
      case 'resume': {
        const a = idArgs(frame.args);
        if (!a) return;
        if (multiClient) flow.resume(c.id, a.id);
        host.resume(a.id);
        return;
      }
      case 'kill': {
        const a = idArgs(frame.args);
        if (a) {
          const held = host.size(a.id) !== null;
          host.kill(a.id);
          if (held) tellOthersEnded(c, [a.id]);
          checkIdle();
        }
        return;
      }
      case 'setTone': {
        const a = toneArgs(frame.args);
        if (a) host.setTone(a.dark);
        return;
      }
      case 'noteLine': {
        const a = noteLineArgs(frame.args);
        if (a) host.noteLine(a.id, a.text, a.ref);
        return;
      }
      default:
        extension?.cast?.(frame.op, frame.args);
    }
  };

  const onConnection = (socket: Socket): void => {
    const id = ++nextConnection;
    const c = {
      id,
      socket,
      decoder: new FrameDecoder(),
      authenticated: false,
      stale: false,
    } as Connection;
    c.op = {
      id,
      emit: emitTo(c),
      get closed() {
        return socket.destroyed || !connections.has(c);
      },
    };
    connections.add(c);
    socket.setEncoding('utf8');
    // A peer that never says hello is dropped.
    const helloTimer = setTimeout(() => {
      if (c.authenticated) return;
      log('hello timed out');
      socket.destroy();
    }, opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    // Every frame of a connection is handled strictly in order, casts
    // included: a `resize` cast sent right behind a `spawn` call must find the
    // pty, and the snapshot `adopt` takes must precede every event after it.
    let chain: Promise<void> = Promise.resolve();
    socket.on('data', (chunk: string) => {
      for (const decoded of c.decoder.decode(chunk)) {
        if ('error' in decoded) {
          log(`protocol error: ${decoded.error}`);
          socket.destroy();
          return;
        }
        if (!c.authenticated) {
          const check = validateHello(decoded.frame, {
            protocolVersion: PROTOCOL_VERSION,
            token: opts.token,
          });
          if (!check.ok) {
            log(`hello rejected: ${check.error}`);
            reject(c, check.error);
            return;
          }
          clearTimeout(helloTimer);
          welcome(c, check.hello);
          checkIdle();
          log(
            `client attached (app ${check.hello.appVersion}, build ${check.hello.buildId}${c.stale ? ', stale' : ''})`,
          );
          continue;
        }
        const frame = parseClientFrame(decoded.frame);
        if (!frame) continue;
        // An extension's calls may wait on an agent for long (an npx download,
        // a slow initialize): they run beside the chain, never in it - a terminal's
        // input and resize must not queue behind them. Replies carry their
        // request id, so answering out of order is fine. So does
        // `foregroundBusy`: read-only, and on Windows it asks the OS through a
        // PowerShell (win-children.ts) - up to seconds while that starts. The
        // list is `runsBesideChain` (protocol.ts).
        if (frame.t === 'call' && runsBesideChain(frame.op)) {
          void call(c, frame).catch((err) => log(`${frame.op} failed: ${String(err)}`));
          continue;
        }
        // A forwarded page's bytes (spec 7.9): handled at once, in arrival
        // order, never behind a spawn on the chain - and never for a stale
        // client, which runs nothing on the host.
        if (frame.t === 'cast' && castRunsBesideChain(frame.op)) {
          if (!c.stale && opts.lsp?.handlesCast(frame.op)) {
            try {
              opts.lsp.cast(frame.op, frame.args, c.op);
            } catch (err) {
              log(`${frame.op} failed: ${String(err)}`);
            }
          } else if (!c.stale && opts.hostOps?.handlesCast(frame.op)) {
            try {
              opts.hostOps.cast(frame.op, frame.args, c.op);
            } catch (err) {
              log(`${frame.op} failed: ${String(err)}`);
            }
          }
          continue;
        }
        chain = chain
          .then(() => (frame.t === 'cast' ? cast(c, frame) : call(c, frame)))
          .catch((err) => log(`${frame.op} failed: ${String(err)}`));
      }
    });
    const gone = (): void => {
      clearTimeout(helloTimer);
      if (!connections.delete(c)) return;
      log('client detached');
      // What it held of the extension's goes (its windows' views, its asks).
      extension?.connectionGone(c.id);
      // Its watches, incoming transfers and agent forward go with it.
      opts.hostOps?.connectionGone(c.op);
      // Its language servers die with it (a reconnect starts fresh ones).
      opts.lsp?.connectionGone(c.op);
      // Its claims and its unread counts too; a pty it alone held paused flows.
      sizes.connectionGone(c.id);
      flow.connectionGone(c.id);
      if (multiClient && c.authenticated) {
        for (const t of host.list()) if (!flow.allPaused(t.id, ids())) host.resume(t.id);
        announcePeers();
      }
      // Nobody is left to drain a paused pty - every shell flows again, into
      // the ring, so an agent never blocks on a full pipe while unattended.
      if (connections.size === 0) host.resumeAll();
      checkIdle();
    };
    socket.on('close', gone);
    socket.on('error', (err) => {
      log(`socket error: ${err.message}`);
      gone();
    });
    checkIdle();
  };

  const server: Server = createServer(onConnection);
  /** The inode of the socket file this server created - the only one it may remove. */
  let ownSocketInode: number | null = null;
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      server.off('error', reject);
      server.on('error', (err) => log(`server error: ${err.message}`));
      if (process.platform !== 'win32') {
        try {
          ownSocketInode = statSync(opts.socketPath).ino;
        } catch {
          ownSocketInode = null;
        }
      }
      log(`listening on ${opts.socketPath} (build ${opts.buildId}, pid ${process.pid})`);
      checkIdle();
      resolve();
    });
  });

  /**
   * Whether the socket file at our path is still the one this server made.
   * The path may by now belong to a NEWER daemon of the same build (the app
   * took this one for dead, removed its file and started a replacement). A
   * pipe name does not exist on disk - always ours.
   */
  const socketIsOurs = (): boolean => {
    if (process.platform === 'win32' || ownSocketInode === null) return true;
    try {
      return statSync(opts.socketPath).ino === ownSocketInode;
    } catch {
      // Gone already - nothing of anyone's to protect.
      return true;
    }
  };

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      idle.dispose();
      offEvents();
      offExtension();
      offHostEvents();
      offRunning();
      opts.hostOps?.dispose();
      opts.lsp?.dispose();
      extension?.dispose();
      // Graceful: a reply written a moment ago (`shutdown`'s) must reach the
      // client before the connection goes, and `destroy` drops anything the
      // kernel has not taken yet. A peer that never answers the FIN is cut
      // off after a moment so the close (and the exit behind it) cannot hang.
      for (const c of connections) {
        c.socket.end();
        setTimeout(() => c.socket.destroy(), 1000).unref();
      }
      connections.clear();
      // Closing a bound Unix socket server makes libuv unlink its path BY
      // NAME - whatever file is there now. When that is another daemon's
      // socket, the listener is left to die with the process instead (the
      // kernel drops it, the file is untouched); closing it would have cut
      // the newer daemon's terminals off for good (2026-10-04).
      if (!socketIsOurs()) {
        log(`leaving ${opts.socketPath} alone - another daemon listens there now`);
        resolve();
        return;
      }
      server.close(() => resolve());
      if (process.platform !== 'win32') {
        try {
          unlinkSync(opts.socketPath);
        } catch {
          // Already gone.
        }
      }
    });

  let shuttingDown: Promise<void> | null = null;
  const shutdown = (reason: string): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    exiting = true;
    log(`shutting down: ${reason}`);
    extension?.stopAll();
    shuttingDown = host
      .killAll()
      .catch(() => undefined)
      .then(() => close())
      .then(() => opts.onExit(reason));
    return shuttingDown;
  };

  return { listening, clientCount: () => connections.size, shutdown, close };
}
