import type { HostEvent, HostSpawnRequest, TerminalSummary } from '../pty-host';
import type { StartupTyping } from '../startup-typer';
import type { LaunchPlan } from '../launch-plan';
import { npmTarballs, registryEntry } from '../language-registry';

/**
 * The wire between the app and the session daemon (a private plan
 * › Protocol): NDJSON frames over a Unix socket / named pipe. Pure - the
 * types, the framing codec and the validators both ends share. No Electron,
 * no node-pty.
 *
 * The version is part of the socket name (daemon-paths.ts): a client speaks
 * to a daemon only when it knows this grammar, so a bump never meets an old
 * daemon by accident - the old one drains its terminals and idle-exits.
 */
export const PROTOCOL_VERSION = 1;

/** A frame past this is a protocol error (a snapshot is ≤ 256 KB + preamble). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type HelloFrame = {
  t: 'hello';
  protocolVersion: number;
  token: string;
  appVersion: string;
  buildId: string;
};

/**
 * A daemon's answer to `hello`. A daemon with an extension adds the
 * extension's own fields (`DaemonServerExtension.welcome`); parsing keeps
 * them, and only the extension reads them.
 */
export type WelcomeFrame =
  | {
      t: 'welcome';
      ok: true;
      pid: number;
      protocolVersion: number;
      appVersion: string;
      buildId: string;
      /** The client's build is not this daemon's: it refuses new spawns. */
      stale: boolean;
      terminals: TerminalSummary[];
      /**
       * The ops beyond the base grammar this daemon answers (DAEMON_CAPS) -
       * absent from daemons that predate the list. A client never sends an op
       * the daemon did not list.
       */
      caps?: string[];
      /**
       * This connection's number on the daemon (`terminal-size` names the
       * claimant by it) - from multi-client daemons (`resizeIntents`, M4).
       */
      connectionId?: number;
      /** The other clients attached when this one said hello (M4, `peers` cap). */
      peers?: PeerCount;
    }
  | { t: 'welcome'; ok: false; error: string };

/**
 * Other apps attached to the same daemon (a private plan
 * › 14): `own` = clients of the daemon's own build (they keep it alive and may
 * spawn), `other` = clients of another build (attached to drain).
 */
export type PeerCount = { own: number; other: number };

export const CALL_OPS = [
  'spawn',
  'adopt',
  'list',
  'size',
  'foregroundBusy',
  'markerDriven',
  'agentStatus',
  'inputList',
  'killAll',
  'shutdown',
  // An extension's ops come from `registerProtocolExtension` - sent only to a
  // daemon of the app's own build (or one whose caps list them), never renamed.
  // Gated by the welcome's `caps` (DAEMON_CAPS), so never asked of a daemon
  // that does not know them - the remote-sessions additions start here
  // (a private plan › 7).
  'ping',
  // A remote host's folders, for the Add project picker (`fs` cap, M1).
  'fsReadDir',
  // M2 (a private plan › 7.3-7.6): the host's processes,
  // files, transfers and watches - all beside the chain, all `caps`-gated.
  'hostInfo',
  'exec',
  'execCancel',
  'fsOp',
  'transferPut',
  'transferCancel',
  'watch',
  'unwatch',
  'watchHint',
  'forwardAgent',
  // M3 (spec 7.9): a TCP stream to a loopback port on the host - a forwarded
  // dev server. Beside the chain; its data, end and acks are casts (below).
  'forwardOpen',
  // Phase 2 M5 (a private plan › 1): one
  // host-side walk per project for Search Everywhere (`index` cap). Beside the chain.
  'fsIndex',
  // Phase 2 M9 (plan 29 spec › 4): language servers run on the host (`lsp`
  // cap) - open, close, install. Beside the chain; a server's messages are
  // the `lspSend` cast and the `lsp-message` event.
  'lspOpen',
  'lspClose',
  'lspInstall',
] as const;
export type CoreCallOp = (typeof CALL_OPS)[number];
/** A call: the core's, or an extension's (`registerProtocolExtension`). */
export type CallOp = CoreCallOp | (string & {});

export const CAST_OPS = [
  'input',
  'resize',
  'pause',
  'resume',
  'kill',
  'setTone',
  'noteLine',
  // M3 port forwarding (spec 7.9), `forward` cap: a stream's bytes, its end
  // and the client's acknowledgements - handled BESIDE the chain, in arrival
  // order (castRunsBesideChain), so a page load never queues behind a spawn.
  'forwardData',
  'forwardClose',
  'forwardAck',
  // M4 multi-client (spec 7.10 / 14), `resizeIntents` cap: a resize that says
  // whether the user asked for it. On the chain, like `resize`.
  'resizeIntent',
  // Phase 2 M9 (plan 29 spec › 1.2), `lsp` cap: one JSON-RPC message to a
  // language server on the host - beside the chain, in arrival order (a
  // server must see `didChange` before the `completion` behind it).
  'lspSend',
] as const;
export type CoreCastOp = (typeof CAST_OPS)[number];
/** A cast: the core's, or an extension's. */
export type CastOp = CoreCastOp | (string & {});

/** The casts a daemon handles at once, outside a connection's ordered chain. */
export function castRunsBesideChain(op: CastOp): boolean {
  return op.startsWith('forward') || op === 'lspSend';
}

/**
 * What an extension adds to the wire grammar: its calls and casts, which of
 * its calls run beside a connection's chain, the capability a call needs, and
 * how its events are routed on the client. Wire names - append-only, never
 * renamed, exactly as the daemons of earlier builds speak them. Registered
 * once per process, before any frame is parsed (the daemon at start, main
 * before its backends).
 */
export type ProtocolExtension = {
  calls: readonly string[];
  casts?: readonly string[];
  /** Calls answered beside the chain (an agent starting must not hold keystrokes up). */
  besideChain?: readonly string[];
  /** The capability a call needs; a client refuses it to a daemon that did not list it. */
  capOf?: Readonly<Record<string, string>>;
  /** Event types delivered to `DaemonClient.onExtensionEvent`. */
  events?: readonly string[];
  /** Event types delivered with the host ops' events (`onHostOpEvent`). */
  hostOpEvents?: readonly string[];
};

const extensionGrammar = {
  calls: new Set<string>(),
  casts: new Set<string>(),
  beside: new Set<string>(),
  capOf: new Map<string, string>(),
  events: new Set<string>(),
  hostOpEvents: new Set<string>(),
};

/** Adds an extension's grammar (idempotent: a second registration of a name is a no-op). */
export function registerProtocolExtension(ext: ProtocolExtension): void {
  for (const op of ext.calls) extensionGrammar.calls.add(op);
  for (const op of ext.casts ?? []) extensionGrammar.casts.add(op);
  for (const op of ext.besideChain ?? []) extensionGrammar.beside.add(op);
  for (const [op, cap] of Object.entries(ext.capOf ?? {})) extensionGrammar.capOf.set(op, cap);
  for (const type of ext.events ?? []) extensionGrammar.events.add(type);
  for (const type of ext.hostOpEvents ?? []) extensionGrammar.hostOpEvents.add(type);
}

/** Tests only: the core grammar alone again. */
export function resetProtocolExtensionForTest(): void {
  for (const set of Object.values(extensionGrammar)) set.clear();
}

/** An extension's event (`ProtocolExtension.events`), as the client hands it on. */
export type ExtensionEvent = { type: string } & Record<string, unknown>;

/** Whether an event is an extension's (routed to `onExtensionEvent`). */
export function isExtensionEvent(ev: { type: string }): boolean {
  return extensionGrammar.events.has(ev.type);
}

/**
 * Capabilities a daemon announces in its welcome, one per op family added
 * after the first grammar. Append-only - never renamed or removed - and no
 * `PROTOCOL_VERSION` bump: an older daemon simply does not list a new one
 * (a private plan › 7).
 */
export const DAEMON_CAPS = ['ping'] as const;
/**
 * Announced only by a daemon running on a remote host (`daemon.js start`'s
 * serve mode, a private plan › M1): `remote` - it resolves
 * `hostShell` spawns on its own machine (daemon/remote-spawn.ts); `fs` - it
 * answers `fsReadDir` (the Add project folder picker, remote-fs.ts).
 */
export const REMOTE_CAPS = [
  'remote',
  'fs',
  // M2: `exec` / `execCancel` (streamed process output), `fsOp` (the host's
  // files, node's surface), `transferPut` / `transferCancel` (bodies past the
  // inline cap), `watch` / `unwatch` / `watchHint`, `forwardAgent`, `hostInfo`;
  // `prepareLaunch` - a spawn may carry a `LaunchPlan` the daemon materialises
  // on its own machine (hooks, settings, shims, launch script, resume pin).
  'exec',
  'files',
  'transfer',
  'watch',
  'agent',
  'prepareLaunch',
  // M3: `forwardOpen` + the `forwardData` / `forwardClose` / `forwardAck`
  // casts and the `forward-data` / `forward-close` events (spec 7.9).
  'forward',
  // M4 (spec 7.10 / 14): several apps on one daemon. `resizeIntents` - the
  // `resizeIntent` cast and the `terminal-size` event (last interacting
  // client sets the grid); `peers` - the welcome's `peers` / `connectionId`
  // and the `peers` event; `snapshot` - a client too far behind on a paused
  // terminal gets `snapshot-needed` instead of the rest of the stream.
  'resizeIntents',
  'peers',
  'snapshot',
  // Phase 2 M5 (plan 29 spec › 1.1): `index` - `fsIndex` (Search
  // Everywhere's walk, run on the host).
  'index',
  // Phase 2 M9 (plan 29 spec › 4): `lsp` - language servers spawned on the
  // host (`lspOpen` / `lspClose` / `lspSend`, the `lsp-message` / `lsp-exit`
  // events to the opening connection only) and installed there (`lspInstall`).
  'lsp',
] as const;
/** A capability: the core's, or one an extension's daemon announces. */
export type DaemonCap = (typeof DAEMON_CAPS)[number] | (typeof REMOTE_CAPS)[number] | (string & {});

/**
 * The capability each gated op needs. A daemon ignores an op it does not
 * know (`parseClientFrame` drops it), so a call sent without the capability
 * would never be answered - the client refuses it instead (DaemonClient.call).
 */
export const CORE_CAP_OF_OP: Partial<Record<CoreCallOp, DaemonCap>> = {
  ping: 'ping',
  fsReadDir: 'fs',
  hostInfo: 'remote',
  exec: 'exec',
  execCancel: 'exec',
  fsOp: 'files',
  transferPut: 'transfer',
  transferCancel: 'transfer',
  watch: 'watch',
  unwatch: 'watch',
  watchHint: 'watch',
  forwardAgent: 'agent',
  forwardOpen: 'forward',
  fsIndex: 'index',
  lspOpen: 'lsp',
  lspClose: 'lsp',
  lspInstall: 'lsp',
};

/** The capability a call needs: the core's map, else the extension's. */
export function capOfOp(op: CallOp): DaemonCap | undefined {
  return CORE_CAP_OF_OP[op as CoreCallOp] ?? extensionGrammar.capOf.get(op);
}

/**
 * The calls a daemon answers BESIDE a connection's ordered chain rather than
 * in it: anything that may wait (an agent starting, the OS asked for a
 * shell's children, later a `git log` on a host) must never queue a
 * keystroke behind it. Replies carry their request id, so answering out of
 * order is fine. Everything else - every cast included - keeps the chain's
 * order (a `resize` sent behind a `spawn` must find the pty).
 */
export function runsBesideChain(op: CallOp): boolean {
  if (extensionGrammar.beside.has(op)) return true;
  return (
    op.startsWith('fs') ||
    op.startsWith('lsp') ||
    op.startsWith('exec') ||
    op.startsWith('transfer') ||
    op.startsWith('watch') ||
    op === 'unwatch' ||
    op === 'hostInfo' ||
    op === 'forwardAgent' ||
    op === 'forwardOpen' ||
    op === 'foregroundBusy' ||
    op === 'ping'
  );
}

export type CallFrame = { t: 'call'; req: number; op: CallOp; args: unknown };
export type CastFrame = { t: 'cast'; op: CastOp; args: unknown };
export type ReplyFrame =
  | { t: 'reply'; req: number; ok: true; result: unknown }
  | { t: 'reply'; req: number; ok: false; error: string };
/**
 * A remote host's answers that do not fit one reply (spec 7.4-7.6): sent to
 * the ONE connection that asked, in pieces of at most `STREAM_PIECE_BYTES`,
 * so a `git log` or a large file never holds a terminal's output back.
 */
export type HostOpEvent =
  | {
      type: 'exec-out';
      execId: string;
      stream: 'out' | 'err';
      /** utf8 text, or base64 for a binary exec's stdout. */
      data: string;
    }
  | {
      type: 'exec-exit';
      execId: string;
      code: number | null;
      signal: string | null;
      truncated: boolean;
      /** The run failed (a timeout); `code` names the errno-style class. */
      error?: { message: string; code?: string };
    }
  | { type: 'transfer-chunk'; transferId: string; seq: number; data: string }
  | {
      type: 'transfer-end';
      transferId: string;
      size: number;
      /** The body's sha256 (hex) - the receiver checks it (spec 7.5). */
      sha256?: string;
      error?: string;
    }
  | { type: 'fs-changed'; watchId: string; paths: string[] }
  | { type: 'watch-mode'; watchId: string; mode: 'native' | 'poll' }
  /** Bytes the host's server sent on a forwarded stream (base64, ≤ STREAM_PIECE_BYTES raw). */
  | { type: 'forward-data'; streamId: string; data: string }
  /** The host's side of a forwarded stream ended (or failed). */
  | { type: 'forward-close'; streamId: string; error?: string }
  /** Bytes of the client's `forwardData` the host's server took (the upload window). */
  | { type: 'forward-ack'; streamId: string; bytes: number }
  /** One whole JSON-RPC message from a language server (plan 29 spec › 4.1) - to its opener only. */
  | LspMessageEvent
  /** A language server ended on its own, or was killed for a bad stream. */
  | LspExitEvent
  /** An install's tarballs, one tick each - to the connection that asked. */
  | LspInstallProgressEvent;

export const HOST_OP_EVENTS = [
  'exec-out',
  'exec-exit',
  'transfer-chunk',
  'transfer-end',
  'fs-changed',
  'watch-mode',
  'forward-data',
  'forward-close',
  'forward-ack',
  'lsp-message',
  'lsp-exit',
  'lsp-install-progress',
] as const;

/** A host op's event - the core's, or one an extension routes with them (`hostOpEvents`). */
export function isHostOpEvent(ev: { type: string }): ev is HostOpEvent {
  return (
    (HOST_OP_EVENTS as readonly string[]).includes(ev.type) ||
    extensionGrammar.hostOpEvents.has(ev.type)
  );
}

/**
 * What one client of a daemon several apps share needs to know about the
 * others (a private plan › 7.10 / 14) - M4.
 */
export type ViewEvent =
  /**
   * The grid a terminal runs at now, and the connection whose intent set it.
   * Broadcast on every applied resize; sent to the asker alone when its
   * passive intent was not applied (it follows the claimant's grid).
   */
  | {
      type: 'terminal-size';
      id: string;
      cols: number;
      rows: number;
      by: number;
      /**
       * The `seq` of the intent that set this grid (its sender's own
       * counter): a client drops another client's grid while one of its own
       * claims has not come back yet - that grid predates the claim.
       */
      seq?: number;
    }
  /**
   * This client fell more than SNAPSHOT_BEHIND_BYTES behind on a terminal it
   * paused: the rest of the stream was dropped for it (and only it) - it
   * re-adopts to catch up from the snapshot.
   */
  | { type: 'snapshot-needed'; id: string }
  /** Who else is attached, counted for the recipient (it is not in the count). */
  | ({ type: 'peers' } & PeerCount);

export const VIEW_EVENTS = ['terminal-size', 'snapshot-needed', 'peers'] as const;

export function isViewEvent(ev: { type: string }): ev is ViewEvent {
  return (VIEW_EVENTS as readonly string[]).includes(ev.type);
}

/** Past this much output unread on a paused terminal, a client gets a snapshot instead. */
export const SNAPSHOT_BEHIND_BYTES = 4 * 1024 * 1024;

/** A piece of streamed output (exec) - well under the frame cap (spec 7.2). */
export const STREAM_PIECE_BYTES = 64 * 1024;
/** A file body inline in a reply up to this; past it, a transfer (spec 7.5). */
export const INLINE_FILE_BYTES = 256 * 1024;
/** One transfer chunk's raw bytes (base64 on the wire, +33 %). */
export const TRANSFER_CHUNK_BYTES = 256 * 1024;

/**
 * What a daemon streams: its terminals' events, its host ops' and its views'.
 * An extension's events travel too (`ExtensionEvent`), outside this union.
 */
export type DaemonEvent = HostEvent | HostOpEvent | ViewEvent;
export type EventFrame = { t: 'event'; ev: DaemonEvent };

export type ClientFrame = HelloFrame | CallFrame | CastFrame;
export type DaemonFrame = WelcomeFrame | ReplyFrame | EventFrame;

/** One frame on the wire: its JSON and a newline. */
export function encodeFrame(frame: object): string {
  return `${JSON.stringify(frame)}\n`;
}

export type Decoded = { frame: unknown } | { error: string };

/**
 * Splits a byte stream into frames. Chunk boundaries fall anywhere, so a
 * partial line is kept until its newline arrives. A line that is not JSON,
 * or longer than MAX_FRAME_BYTES, comes out as an error the caller treats
 * as a protocol violation.
 */
export class FrameDecoder {
  private tail = '';
  /** `tail`'s UTF-8 size, kept as it grows - re-measuring the whole tail on
   * every read made a multi-MB frame quadratic (review, 2026-10-06). */
  private tailBytes = 0;
  private overflow = false;

  decode(chunk: string | Buffer): Decoded[] {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out: Decoded[] = [];
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl === -1) break;
      const line = this.tail + text.slice(start, nl);
      this.tail = '';
      this.tailBytes = 0;
      start = nl + 1;
      if (this.overflow) {
        this.overflow = false;
        out.push({ error: 'frame too large' });
        continue;
      }
      if (line.trim() === '') continue;
      try {
        out.push({ frame: JSON.parse(line) });
      } catch {
        out.push({ error: 'frame is not JSON' });
      }
    }
    const rest = text.slice(start);
    if (!this.overflow) {
      this.tail += rest;
      this.tailBytes += Buffer.byteLength(rest);
      if (this.tailBytes > MAX_FRAME_BYTES) {
        this.tail = '';
        this.tailBytes = 0;
        this.overflow = true;
      }
    }
    return out;
  }
}

/** Guards an extension's own argument checks share (pro's protocol module). */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type HelloCheck =
  { ok: true; hello: HelloFrame } | { ok: false; error: 'malformed' | 'protocol' | 'token' };

/**
 * The first frame a connection must send. A wrong protocol version cannot
 * happen through the named socket (the version is in its name) but is
 * checked all the same; a wrong token is a stranger on the socket.
 */
export function validateHello(
  frame: unknown,
  expected: { protocolVersion: number; token: string },
): HelloCheck {
  if (
    !isRecord(frame) ||
    frame.t !== 'hello' ||
    !isNum(frame.protocolVersion) ||
    !isStr(frame.token) ||
    !isStr(frame.appVersion) ||
    !isStr(frame.buildId)
  ) {
    return { ok: false, error: 'malformed' };
  }
  if (frame.protocolVersion !== expected.protocolVersion) return { ok: false, error: 'protocol' };
  if (frame.token.length === 0 || !timingSafeEqualStrings(frame.token, expected.token)) {
    return { ok: false, error: 'token' };
  }
  return {
    ok: true,
    hello: {
      t: 'hello',
      protocolVersion: frame.protocolVersion,
      token: frame.token,
      appVersion: frame.appVersion,
      buildId: frame.buildId,
    },
  };
}

/** Constant-time string compare (the token is a secret, if a local one). */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A frame after hello: a call, a cast, or neither (ignored / an error). */
export function parseClientFrame(frame: unknown): CallFrame | CastFrame | null {
  if (!isRecord(frame)) return null;
  if (frame.t === 'call') {
    if (
      !isNum(frame.req) ||
      !isStr(frame.op) ||
      !((CALL_OPS as readonly string[]).includes(frame.op) || extensionGrammar.calls.has(frame.op))
    )
      return null;
    return { t: 'call', req: frame.req, op: frame.op as CallOp, args: frame.args };
  }
  if (frame.t === 'cast') {
    if (
      !isStr(frame.op) ||
      !((CAST_OPS as readonly string[]).includes(frame.op) || extensionGrammar.casts.has(frame.op))
    )
      return null;
    return { t: 'cast', op: frame.op as CastOp, args: frame.args };
  }
  return null;
}

/** A frame from the daemon: welcome, reply or event; null for anything else. */
export function parseDaemonFrame(frame: unknown): DaemonFrame | null {
  if (!isRecord(frame)) return null;
  if (frame.t === 'welcome') {
    if (frame.ok === true) {
      if (
        !isNum(frame.pid) ||
        !isNum(frame.protocolVersion) ||
        !isStr(frame.appVersion) ||
        !isStr(frame.buildId) ||
        typeof frame.stale !== 'boolean' ||
        !Array.isArray(frame.terminals)
      )
        return null;
      // A malformed list is no list: `caps: "ping"` would pass a substring
      // check, `caps: {}` would throw on `includes`.
      const rest: Record<string, unknown> = { ...frame };
      if ('caps' in frame && !(Array.isArray(frame.caps) && frame.caps.every(isStr))) {
        delete rest.caps;
      }
      if ('connectionId' in frame && !isNum(frame.connectionId)) delete rest.connectionId;
      if ('peers' in frame && !isPeerCount(frame.peers)) delete rest.peers;
      return rest as unknown as WelcomeFrame;
    }
    if (frame.ok === false && isStr(frame.error)) return frame as unknown as WelcomeFrame;
    return null;
  }
  if (frame.t === 'reply') {
    if (!isNum(frame.req)) return null;
    if (frame.ok === true) return { t: 'reply', req: frame.req, ok: true, result: frame.result };
    if (frame.ok === false && isStr(frame.error))
      return { t: 'reply', req: frame.req, ok: false, error: frame.error };
    return null;
  }
  if (frame.t === 'event' && isRecord(frame.ev) && isStr(frame.ev.type)) {
    return { t: 'event', ev: frame.ev as unknown as DaemonEvent };
  }
  return null;
}

const isPeerCount = (v: unknown): v is PeerCount =>
  isRecord(v) && isNum(v.own) && isNum(v.other) && v.own >= 0 && v.other >= 0;

// --- argument guards, one per op ------------------------------------------------

export const isStringRecord = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every(isStr);

export function spawnArgs(args: unknown): HostSpawnRequest | null {
  if (!isRecord(args)) return null;
  const { id, file, cwd, env, name, cols, rows, markerDriven, typeWhenReady, hostShell } = args;
  if (!isStr(id) || id.length === 0 || !isStr(file) || !isStr(cwd) || !isStr(name)) return null;
  if (!Array.isArray(args.args) || !args.args.every(isStr)) return null;
  if (!isStringRecord(env) || !isNum(cols) || !isNum(rows)) return null;
  if (typeof markerDriven !== 'boolean') return null;
  let typing: StartupTyping | undefined;
  if (typeWhenReady !== undefined) {
    if (!isRecord(typeWhenReady)) return null;
    const { line, promptMarks } = typeWhenReady;
    if (!isStr(line) || typeof promptMarks !== 'boolean') return null;
    typing = { line, promptMarks };
  }
  if (hostShell !== undefined && typeof hostShell !== 'boolean') return null;
  let plan: LaunchPlan | undefined;
  if (args.plan !== undefined) {
    const p = launchPlanOf(args.plan);
    if (!p || p.id !== id) return null;
    plan = p;
  }
  return {
    id,
    file,
    args: args.args,
    cwd,
    env,
    name,
    cols,
    rows,
    markerDriven,
    ...(typing ? { typeWhenReady: typing } : {}),
    ...(hostShell === true ? { hostShell: true } : {}),
    ...(plan ? { plan } : {}),
  };
}

const ADAPTERS = new Set(['claude', 'wrapper', 'windows']);

/**
 * A `LaunchPlan` riding in a remote spawn (`prepareLaunch`, spec 7.3 / 8.1):
 * every field checked - the host writes files from it. The overlay env may
 * carry no secret-shaped name (spec 20: no double0 secret leaves the laptop).
 */
export function launchPlanOf(v: unknown): LaunchPlan | null {
  if (!isRecord(v)) return null;
  const {
    id,
    command,
    adapter,
    markerDriven,
    shellIntegration,
    overlayEnv,
    agentTools,
    cwd,
    cols,
    rows,
  } = v;
  if (!isStr(id) || id.length === 0 || id.length > 200) return null;
  if (command !== null && (!isStr(command) || command.length > 64 * 1024)) return null;
  if (adapter !== null && !(isStr(adapter) && ADAPTERS.has(adapter))) return null;
  if (typeof markerDriven !== 'boolean' || typeof shellIntegration !== 'boolean') return null;
  if (typeof agentTools !== 'boolean') return null;
  if (cwd !== null && !isStr(cwd)) return null;
  if (!isNum(cols) || !isNum(rows)) return null;
  if (!isStringRecord(overlayEnv)) return null;
  if (Object.keys(overlayEnv).some((k) => SECRET_NAME.test(k))) return null;
  return {
    id,
    command: command as string | null,
    adapter: adapter as LaunchPlan['adapter'],
    markerDriven,
    shellIntegration,
    overlayEnv,
    agentTools,
    cwd: cwd as string | null,
    cols,
    rows,
  };
}

/** An env name that smells like a credential (spec 20). */
export const SECRET_NAME = /TOKEN|SECRET|KEY|PASS/i;

export function idArgs(args: unknown): { id: string } | null {
  return isRecord(args) && isStr(args.id) && args.id.length > 0 ? { id: args.id } : null;
}

export function idsArgs(args: unknown): { ids: string[] } | null {
  if (!isRecord(args) || !Array.isArray(args.ids)) return null;
  return { ids: args.ids.filter(isStr) };
}

export function inputArgs(args: unknown): { id: string; data: string } | null {
  return isRecord(args) && isStr(args.id) && isStr(args.data)
    ? { id: args.id, data: args.data }
    : null;
}

export function resizeArgs(args: unknown): { id: string; cols: number; rows: number } | null {
  return isRecord(args) && isStr(args.id) && isNum(args.cols) && isNum(args.rows)
    ? { id: args.id, cols: args.cols, rows: args.rows }
    : null;
}

export type ResizeKind = 'claim' | 'passive';

export function resizeIntentArgs(
  args: unknown,
): { id: string; cols: number; rows: number; kind: ResizeKind; seq?: number } | null {
  const a = resizeArgs(args);
  if (!a || !isRecord(args)) return null;
  if (args.kind !== 'claim' && args.kind !== 'passive') return null;
  const seq = isNum(args.seq) && Number.isInteger(args.seq) && args.seq >= 0 ? args.seq : undefined;
  return { ...a, kind: args.kind, ...(seq !== undefined ? { seq } : {}) };
}

export function toneArgs(args: unknown): { dark: boolean } | null {
  return isRecord(args) && typeof args.dark === 'boolean' ? { dark: args.dark } : null;
}

export function noteLineArgs(args: unknown): { id: string; text: string; ref: number } | null {
  return isRecord(args) && isStr(args.id) && isStr(args.text) && Number.isSafeInteger(args.ref)
    ? { id: args.id, text: args.text, ref: args.ref as number }
    : null;
}

// --- remote host ops (a private plan › 7.5) -------------------

/**
 * `fsReadDir { path, dirsOnly? }`: an absolute path or `~` / `~/…` (the
 * host's home). NUL bytes and relative paths are refused (spec 20).
 */
export function fsReadDirArgs(args: unknown): { path: string; dirsOnly: boolean } | null {
  if (!isRecord(args) || !isStr(args.path)) return null;
  const path = args.path;
  if (path.length === 0 || path.length > 4096 || path.includes('\0')) return null;
  if (!(path === '~' || path.startsWith('~/') || path.startsWith('/'))) return null;
  if (args.dirsOnly !== undefined && typeof args.dirsOnly !== 'boolean') return null;
  return { path, dirsOnly: args.dirsOnly === true };
}

// --- M2 host ops (spec 7.3-7.6) -------------------------------------------------

/** A client-chosen id (exec, transfer, watch): short, no option or path shape. */
const OP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
export const isOpId = (v: unknown): v is string => isStr(v) && OP_ID.test(v);

/** An absolute host path: no NUL, bounded (spec 20 - relative paths refused). */
export function isHostPath(v: unknown): v is string {
  return isStr(v) && v.length > 0 && v.length <= 4096 && v.startsWith('/') && !v.includes('\0');
}

export type ExecArgs = {
  execId: string;
  cwd: string;
  file: string;
  args: string[];
  /** Laid over the daemon's login env (never the laptop's environment). */
  env: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  maxStdout?: number;
  maxStderr?: number;
  /** stdout streamed as base64 (a blob read through git). */
  binary: boolean;
};

export function execArgs(args: unknown): ExecArgs | null {
  if (!isRecord(args) || !isOpId(args.execId) || !isHostPath(args.cwd)) return null;
  const { file } = args;
  if (!isStr(file) || file.length === 0 || file.length > 4096 || file.includes('\0')) return null;
  if (!Array.isArray(args.args) || !args.args.every(isStr)) return null;
  if (args.args.some((a) => (a as string).includes('\0'))) return null;
  const env = args.env ?? {};
  if (!isStringRecord(env)) return null;
  if (args.input !== undefined && !isStr(args.input)) return null;
  for (const k of ['timeoutMs', 'maxStdout', 'maxStderr'] as const) {
    if (args[k] !== undefined && !(isNum(args[k]) && (args[k] as number) > 0)) return null;
  }
  if (args.binary !== undefined && typeof args.binary !== 'boolean') return null;
  return {
    execId: args.execId,
    cwd: args.cwd,
    file,
    args: args.args as string[],
    env,
    ...(args.input !== undefined ? { input: args.input as string } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs as number } : {}),
    ...(args.maxStdout !== undefined ? { maxStdout: args.maxStdout as number } : {}),
    ...(args.maxStderr !== undefined ? { maxStderr: args.maxStderr as number } : {}),
    binary: args.binary === true,
  };
}

export function execIdArgs(args: unknown): { execId: string } | null {
  return isRecord(args) && isOpId(args.execId) ? { execId: args.execId } : null;
}

export const FS_METHODS = [
  'stat',
  'lstat',
  'readdir',
  'readFile',
  'writeFile',
  'mkdir',
  'mkdtemp',
  'rename',
  'unlink',
  'rm',
  'cp',
  'realpath',
  'which',
  'trash',
] as const;
export type FsMethod = (typeof FS_METHODS)[number];

/**
 * `fsOp { method, ... }`: node's `fs/promises` surface on the host, one
 * method per call (fs.ts, git.ts and the seed copy keep their code - the
 * remote runtime mirrors node). Paths are absolute host paths.
 */
export type FsOpArgs =
  | { method: 'stat' | 'lstat' | 'readdir' | 'realpath' | 'unlink' | 'trash'; path: string }
  | { method: 'readFile'; path: string; maxBytes?: number }
  | {
      method: 'writeFile';
      path: string;
      /** base64 body, or a transfer the client streamed first. */
      data?: string;
      transferId?: string;
      exclusive: boolean;
      mode?: number;
      /**
       * The body's sha256 (hex): the daemon refuses to write a body that does
       * not match (plan 29 spec › 9.1). Optional - a daemon that predates it
       * ignores the key, which is why no capability gates it.
       */
      sha256?: string;
    }
  | { method: 'mkdir'; path: string; recursive: boolean }
  | { method: 'mkdtemp'; prefix: string }
  | { method: 'rename'; from: string; to: string }
  | { method: 'rm'; path: string; recursive: boolean; force: boolean }
  | { method: 'cp'; from: string; to: string; recursive: boolean; force: boolean }
  | { method: 'which'; bin: string };

export function fsOpArgs(args: unknown): FsOpArgs | null {
  if (!isRecord(args) || !isStr(args.method)) return null;
  const method = args.method as FsMethod;
  if (!(FS_METHODS as readonly string[]).includes(method)) return null;
  const bool = (v: unknown): boolean | null =>
    v === undefined ? false : typeof v === 'boolean' ? v : null;
  switch (method) {
    case 'stat':
    case 'lstat':
    case 'readdir':
    case 'realpath':
    case 'unlink':
    case 'trash':
      return isHostPath(args.path) ? { method, path: args.path } : null;
    case 'readFile':
      if (!isHostPath(args.path)) return null;
      if (args.maxBytes !== undefined && !(isNum(args.maxBytes) && args.maxBytes > 0)) return null;
      return {
        method,
        path: args.path,
        ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes as number } : {}),
      };
    case 'writeFile': {
      if (!isHostPath(args.path)) return null;
      const hasData = isStr(args.data);
      const hasTransfer = isOpId(args.transferId);
      if (hasData === hasTransfer) return null;
      const exclusive = bool(args.exclusive);
      if (exclusive === null) return null;
      if (args.mode !== undefined && !(Number.isInteger(args.mode) && (args.mode as number) >= 0))
        return null;
      if (args.sha256 !== undefined && !(isStr(args.sha256) && /^[0-9a-f]{64}$/.test(args.sha256)))
        return null;
      return {
        method,
        path: args.path,
        ...(hasData ? { data: args.data as string } : { transferId: args.transferId as string }),
        exclusive,
        ...(args.mode !== undefined ? { mode: args.mode as number } : {}),
        ...(args.sha256 !== undefined ? { sha256: args.sha256 as string } : {}),
      };
    }
    case 'mkdir': {
      const recursive = bool(args.recursive);
      return isHostPath(args.path) && recursive !== null
        ? { method, path: args.path, recursive }
        : null;
    }
    case 'mkdtemp':
      return isHostPath(args.prefix) ? { method, prefix: args.prefix } : null;
    case 'rename':
      return isHostPath(args.from) && isHostPath(args.to)
        ? { method, from: args.from, to: args.to }
        : null;
    case 'rm': {
      const recursive = bool(args.recursive);
      const force = bool(args.force);
      return isHostPath(args.path) && recursive !== null && force !== null
        ? { method, path: args.path, recursive, force }
        : null;
    }
    case 'cp': {
      const recursive = bool(args.recursive);
      const force = bool(args.force);
      return isHostPath(args.from) && isHostPath(args.to) && recursive !== null && force !== null
        ? { method, from: args.from, to: args.to, recursive, force }
        : null;
    }
    case 'which':
      return isStr(args.bin) && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(args.bin)
        ? { method, bin: args.bin }
        : null;
  }
}

/** A client-to-host transfer piece (`transferPut`): base64, at most one chunk. */
export function transferPutArgs(
  args: unknown,
): { transferId: string; seq: number; data: string } | null {
  if (!isRecord(args) || !isOpId(args.transferId)) return null;
  if (!Number.isSafeInteger(args.seq) || (args.seq as number) < 0) return null;
  if (!isStr(args.data) || args.data.length > Math.ceil((TRANSFER_CHUNK_BYTES * 4) / 3) + 4)
    return null;
  return { transferId: args.transferId, seq: args.seq as number, data: args.data };
}

export function transferIdArgs(args: unknown): { transferId: string } | null {
  return isRecord(args) && isOpId(args.transferId) ? { transferId: args.transferId } : null;
}

export function watchArgs(
  args: unknown,
): { watchId: string; root: string; kind: 'tree' | 'gitdir' } | null {
  if (!isRecord(args) || !isOpId(args.watchId) || !isHostPath(args.root)) return null;
  if (args.kind !== 'tree' && args.kind !== 'gitdir') return null;
  return { watchId: args.watchId, root: args.root, kind: args.kind };
}

export function watchIdArgs(args: unknown): { watchId: string } | null {
  return isRecord(args) && isOpId(args.watchId) ? { watchId: args.watchId } : null;
}

/** The folders the explorer has open - what a polling watch reads (spec 11.2). */
export function watchHintArgs(args: unknown): { watchId: string; dirs: string[] } | null {
  if (!isRecord(args) || !isOpId(args.watchId) || !Array.isArray(args.dirs)) return null;
  if (args.dirs.length > 2000 || !args.dirs.every(isHostPath)) return null;
  return { watchId: args.watchId, dirs: args.dirs as string[] };
}

/** The socket file one bridge run's `-R` binds in the agent folder (a fresh name per run). */
export const AGENT_SOCK_NAME = /^agent-[a-f0-9]{8,32}\.sock$/;

/**
 * `forwardAgent { live, name? }`: a client's agent forward went live on
 * socket `name` in the host's agent folder (or stopped).
 */
export function forwardAgentArgs(args: unknown): { live: boolean; name?: string } | null {
  if (!isRecord(args) || typeof args.live !== 'boolean') return null;
  if (!args.live) return { live: false };
  return isStr(args.name) && AGENT_SOCK_NAME.test(args.name)
    ? { live: true, name: args.name }
    : null;
}

// --- M3 port forwarding (spec 7.9) ------------------------------------------------

/** Open forwards (distinct host ports with a live stream) one client may hold on a host. */
export const MAX_FORWARDS_PER_HOST = 16;
/** Live streams (browser connections) per forward. */
export const MAX_STREAMS_PER_FORWARD = 64;
/** The host pauses a stream's socket while this many sent bytes are unacknowledged. */
export const FORWARD_WINDOW_BYTES = 1024 * 1024;
/** Each side acknowledges what it delivered in steps of this. */
export const FORWARD_ACK_BYTES = 256 * 1024;
/** `forward-data` pieces a stream may have in flight to the bridge socket at once. */
export const FORWARD_PIECES_IN_FLIGHT = 8;
/** A loopback dial that has not connected by then fails (ETIMEDOUT). */
export const FORWARD_CONNECT_TIMEOUT_MS = 5000;

const isPort = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;

/** `forwardOpen { streamId, port }`: a loopback port on the host - nothing else is reachable. */
export function forwardOpenArgs(args: unknown): { streamId: string; port: number } | null {
  return isRecord(args) && isOpId(args.streamId) && isPort(args.port)
    ? { streamId: args.streamId, port: args.port }
    : null;
}

/** `forwardData { streamId, data }`: base64, at most one stream piece. */
export function forwardDataArgs(args: unknown): { streamId: string; data: string } | null {
  if (!isRecord(args) || !isOpId(args.streamId) || !isStr(args.data)) return null;
  if (args.data.length > Math.ceil((STREAM_PIECE_BYTES * 4) / 3) + 4) return null;
  return { streamId: args.streamId, data: args.data };
}

export function forwardCloseArgs(args: unknown): { streamId: string } | null {
  return isRecord(args) && isOpId(args.streamId) ? { streamId: args.streamId } : null;
}

export function forwardAckArgs(args: unknown): { streamId: string; bytes: number } | null {
  return isRecord(args) &&
    isOpId(args.streamId) &&
    Number.isSafeInteger(args.bytes) &&
    (args.bytes as number) > 0
    ? { streamId: args.streamId, bytes: args.bytes as number }
    : null;
}

// --- Phase 2 M5: the search index (plan 29 spec › 1.5) ----------------------------

/** A pty id as the daemon names its terminals - bounded, no NUL. */
export const isPtyId = (v: unknown): v is string =>
  isStr(v) && v.length > 0 && v.length <= 200 && !v.includes('\0');

/** Files one host may index for Search Everywhere (plan 29 decision 9). */
export const MAX_INDEX_FILES = 20_000;
/** An index reply stays under this much JSON (well under the frame cap). */
export const MAX_INDEX_BYTES = 4 * 1024 * 1024;

export type FsIndexArgs = { root: string; max: number; maxBytes: number };
export type FsIndexResult =
  { files: string[]; truncated: boolean } | { err: { message: string; code?: string } };

/** `fsIndex { root, max, maxBytes? }`: an absolute host folder, 1..20 000 files, ≤ 4 MiB. */
export function fsIndexArgs(args: unknown): FsIndexArgs | null {
  if (!isRecord(args) || !isHostPath(args.root)) return null;
  const { max } = args;
  if (!Number.isSafeInteger(max) || (max as number) < 1 || (max as number) > MAX_INDEX_FILES)
    return null;
  let maxBytes = MAX_INDEX_BYTES;
  if (args.maxBytes !== undefined) {
    if (
      !Number.isSafeInteger(args.maxBytes) ||
      (args.maxBytes as number) < 1 ||
      (args.maxBytes as number) > MAX_INDEX_BYTES
    )
      return null;
    maxBytes = args.maxBytes as number;
  }
  return { root: args.root, max: max as number, maxBytes };
}

// --- Phase 2 M9: language servers on a host (plan 29 spec › 1.4, 1.5, 4) -------

/** A message past this is never framed or sent (spec 1.5, 4.1). */
export const MAX_LSP_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Servers one connection may run at once (spec 4.1). */
export const MAX_LSP_PER_CONNECTION = 12;

export type LspMessageEvent = { type: 'lsp-message'; lspId: string; message: string };
export type LspExitEvent = {
  type: 'lsp-exit';
  lspId: string;
  code: number | null;
  reason?: 'oversize' | 'framing' | 'killed';
};
export type LspInstallProgressEvent = {
  type: 'lsp-install-progress';
  installId: string;
  languageId: string;
  done: number;
  total: number;
};

export type LspOpenArgs = {
  lspId: string;
  kind: 'installed' | 'path';
  languageId: string;
  /** `installed`: the version folder under `~/.double0/language-servers/<id>/`. */
  version?: string;
  /** `path`: the registry's bin - the client names a language, never a binary. */
  bin?: string;
  args: string[];
  /** The server's cwd and workspace root (a host folder). */
  root: string;
};
export type LspOpenResult =
  | { ok: true; pid: number }
  | { ok: false; error: string; code: 'NOT_FOUND' | 'SPAWN_FAILED' | 'LIMIT' };
export type LspInstallArgs = {
  installId: string;
  languageId: string;
  version: string;
  /** Every tarball the install needs, as the registry pins them; `transferId` = relayed. */
  tarballs: Array<{ name: string; url: string; integrity: string; transferId?: string }>;
};
export type LspInstallResult =
  { ok: true } | { ok: false; error: string; code: 'EINTEGRITY' | 'ENOEGRESS' | 'EINSTALL' };

const LSP_ID = /^[0-9a-f-]{8,64}$/i;
const isLspId = (v: unknown): v is string => isStr(v) && LSP_ID.test(v);
/** A version folder name: no separator, no dot-only name, no option shape. */
const LSP_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

const sameArgs = (a: unknown, b: readonly string[]): boolean =>
  Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * `lspOpen`: a uuid, a language the registry knows (bundled - the daemon has
 * it), `args` exactly the entry's; `path` takes `bin` only as the registry
 * names it, `installed` a version folder name; `root` an absolute host path.
 */
export function lspOpenArgs(args: unknown): LspOpenArgs | null {
  if (!isRecord(args) || !isLspId(args.lspId) || !isHostPath(args.root)) return null;
  const entry = isStr(args.languageId) ? registryEntry(args.languageId) : undefined;
  if (!entry || entry.server.installType === 'builtin') return null;
  const spec = entry.server;
  if (!sameArgs(args.args, spec.args)) return null;
  const base = { lspId: args.lspId, languageId: entry.id, args: [...spec.args], root: args.root };
  if (args.kind === 'installed') {
    if (spec.installType !== 'npm') return null;
    if (!isStr(args.version) || !LSP_VERSION.test(args.version)) return null;
    return { ...base, kind: 'installed', version: args.version };
  }
  if (args.kind === 'path') {
    const bin = spec.installType === 'npm' ? spec.entryBin : spec.bin;
    if (args.bin !== bin) return null;
    return { ...base, kind: 'path', bin };
  }
  return null;
}

/** `lspSend`: a server id and one message, at most 4 MiB, a JSON object. */
export function lspSendArgs(args: unknown): { lspId: string; message: string } | null {
  if (!isRecord(args) || !isLspId(args.lspId) || !isStr(args.message)) return null;
  if (Buffer.byteLength(args.message) > MAX_LSP_MESSAGE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(args.message);
    if (!isRecord(parsed)) return null;
  } catch {
    return null;
  }
  return { lspId: args.lspId, message: args.message };
}

export function lspCloseArgs(args: unknown): { lspId: string } | null {
  return isRecord(args) && isLspId(args.lspId) ? { lspId: args.lspId } : null;
}

/**
 * `lspInstall`: an npm server of the registry at its pinned version, and the
 * tarball list exactly as the registry pins it (names, registry URLs,
 * integrity) - the client cannot point the host at another URL or package.
 */
export function lspInstallArgs(args: unknown): LspInstallArgs | null {
  if (!isRecord(args) || !isLspId(args.installId) || !isStr(args.languageId)) return null;
  const entry = registryEntry(args.languageId);
  if (!entry || entry.server.installType !== 'npm') return null;
  if (args.version !== entry.server.version) return null;
  const expected = npmTarballs(entry.server);
  const given = args.tarballs;
  if (!Array.isArray(given) || given.length !== expected.length) return null;
  const tarballs: LspInstallArgs['tarballs'] = [];
  for (let i = 0; i < expected.length; i++) {
    const t = given[i] as unknown;
    const want = expected[i];
    if (!isRecord(t) || t.name !== want.name || t.url !== want.url) return null;
    if (t.integrity !== want.integrity) return null;
    if (t.transferId !== undefined && !isOpId(t.transferId)) return null;
    tarballs.push({
      name: want.name,
      url: want.url,
      integrity: want.integrity,
      ...(isStr(t.transferId) ? { transferId: t.transferId } : {}),
    });
  }
  return {
    installId: args.installId,
    languageId: entry.id,
    version: entry.server.version,
    tarballs,
  };
}

/** A host's `lsp-message` / `lsp-exit` / `lsp-install-progress`, checked before main acts on it. */
export function lspEventOf(
  ev: unknown,
): LspMessageEvent | LspExitEvent | LspInstallProgressEvent | null {
  if (!isRecord(ev)) return null;
  if (ev.type === 'lsp-message') {
    if (!isLspId(ev.lspId) || !isStr(ev.message)) return null;
    return { type: 'lsp-message', lspId: ev.lspId, message: ev.message };
  }
  if (ev.type === 'lsp-exit') {
    if (!isLspId(ev.lspId) || !(ev.code === null || isNum(ev.code))) return null;
    const reason =
      ev.reason === 'oversize' || ev.reason === 'framing' || ev.reason === 'killed'
        ? ev.reason
        : undefined;
    return { type: 'lsp-exit', lspId: ev.lspId, code: ev.code, ...(reason ? { reason } : {}) };
  }
  if (ev.type === 'lsp-install-progress') {
    if (!isLspId(ev.installId) || !isStr(ev.languageId) || !isNum(ev.done) || !isNum(ev.total))
      return null;
    return {
      type: 'lsp-install-progress',
      installId: ev.installId,
      languageId: ev.languageId,
      done: ev.done,
      total: ev.total,
    };
  }
  return null;
}
