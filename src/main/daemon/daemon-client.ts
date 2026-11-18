import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import type { HostEvent } from '../pty-host';
import {
  capOfOp,
  FrameDecoder,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  parseDaemonFrame,
  isExtensionEvent,
  isHostOpEvent,
  isViewEvent,
  type CallOp,
  type HostOpEvent,
  type CastOp,
  type DaemonCap,
  type ExtensionEvent,
  type HelloFrame,
  type ViewEvent,
  type WelcomeFrame,
} from './protocol';

/**
 * One connection to a session daemon (a private plan): hello
 * on connect, `call` for requests that want an answer, `cast` for the rest,
 * host events and a close notice. Pure node - daemon-backend.ts routes
 * terminals across several of these. The transport is any byte stream: the
 * daemon's Unix socket / named pipe (`connect`), or a stream that carries the
 * same protocol from elsewhere - the ssh bridge to a remote host's daemon
 * (`connectOver`, a private plan › 5).
 */
export type WelcomeOk = Extract<WelcomeFrame, { ok: true }>;

/**
 * A call that was sent and whose reply was lost with the connection
 * (a private plan › 7.11): its outcome is unknown.
 * The message is the one every caller already matches on.
 */
export class OutcomeUnknownError extends Error {
  readonly code = 'EOUTCOMEUNKNOWN';
  constructor() {
    super('daemon connection closed');
  }
}

export function isOutcomeUnknown(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'EOUTCOMEUNKNOWN';
}

export type DaemonClientOptions = {
  /** How long connect + hello may take before the attempt fails. */
  timeoutMs?: number;
};

type Hello = Omit<HelloFrame, 't' | 'protocolVersion'>;

export class DaemonClient {
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly eventListeners = new Set<(ev: HostEvent) => void>();
  private readonly extensionListeners = new Set<(ev: ExtensionEvent) => void>();
  private readonly hostOpListeners = new Set<(ev: HostOpEvent) => void>();
  private readonly viewListeners = new Set<(ev: ViewEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private nextReq = 1;
  private _closed = false;
  /** Frames decoded but not yet handed out (see `drain`). */
  private readonly inbox: unknown[] = [];
  /** A turn ended on a reply; the rest of the inbox waits for the next macrotask. */
  private deferred = false;
  /** Listener errors already reported (see `deliver`). */
  private readonly listenerFaults = new Set<string>();

  private constructor(
    private readonly socket: Duplex,
    /** The socket path, or the label a `connectOver` stream was given. */
    readonly socketPath: string,
    readonly welcome: WelcomeOk,
    /** Frames that arrived in the welcome's chunk. */
    leftover: unknown[],
    /**
     * The handshake's decoder, holding any partial frame that arrived behind
     * the welcome - a fresh one would read the rest of it as garbage and
     * drop the connection (a daemon streaming output when we attach).
     */
    private readonly decoder: FrameDecoder,
    /** A plain stream ends without a 'close' while its write side is open. */
    closeOnEnd: boolean,
  ) {
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => this.settleClosed());
    socket.on('error', () => this.settleClosed());
    if (closeOnEnd) socket.on('end', () => this.settleClosed());
    // The welcome ends a turn like a reply does: whoever awaited `connect`
    // attaches its listeners first, then these are handed out.
    if (leftover.length > 0) {
      this.inbox.push(...leftover);
      this.defer();
    }
  }

  /** Connect, say hello, resolve on an `ok` welcome - reject on anything else. */
  static connect(
    socketPath: string,
    hello: Hello,
    opts: DaemonClientOptions = {},
  ): Promise<DaemonClient> {
    const socket = createConnection(socketPath);
    return DaemonClient.handshake(socket, socketPath, hello, opts, {
      whenOpen: (sayHello) => socket.once('connect', sayHello),
      closeOnEnd: false,
    });
  }

  /**
   * The same over a stream that is already open (the remote bridge: an ssh
   * child's stdio, a test's stream pair) - hello at once, the same welcome
   * rules, the same dispatch. `label` names it where a socket path would go.
   *
   * Ownership: the stream is the client's from this call on. A failed
   * handshake (refusal, garbage, timeout, an early end) DESTROYS it, as
   * `connect` destroys its socket. Once connected, `close()` ends and
   * destroys it. When the far end ends first (the bridge's stdout hit EOF)
   * the client only marks itself closed and fails its pending calls - it
   * does not end its write side or destroy the stream: whoever owns the
   * transport behind it (the ssh child) tears that down, or calls `close()`.
   */
  static connectOver(
    stream: Duplex,
    hello: Hello,
    opts: DaemonClientOptions & { label?: string } = {},
  ): Promise<DaemonClient> {
    return DaemonClient.handshake(stream, opts.label ?? 'stream', hello, opts, {
      whenOpen: (sayHello) => sayHello(),
      closeOnEnd: true,
    });
  }

  private static handshake(
    socket: Duplex,
    socketPath: string,
    hello: Hello,
    opts: DaemonClientOptions,
    how: { whenOpen: (sayHello: () => void) => void; closeOnEnd: boolean },
  ): Promise<DaemonClient> {
    const timeoutMs = opts.timeoutMs ?? 3000;
    return new Promise<DaemonClient>((resolve, reject) => {
      socket.setEncoding('utf8');
      const decoder = new FrameDecoder();
      let settled = false;
      const onError = (err: Error): void => fail(err);
      const onClose = (): void => fail(new Error('daemon closed during handshake'));
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('daemon handshake timed out')), timeoutMs);
      socket.once('error', onError);
      socket.once('close', onClose);
      if (how.closeOnEnd) socket.once('end', onClose);
      how.whenOpen(() => {
        socket.write(
          encodeFrame({
            t: 'hello',
            protocolVersion: PROTOCOL_VERSION,
            ...hello,
          } satisfies HelloFrame),
        );
      });
      const onFirstData = (chunk: string): void => {
        const decoded = decoder.decode(chunk);
        if (decoded.length === 0) return;
        socket.off('data', onFirstData);
        const first = decoded[0];
        if ('error' in first) return fail(new Error(`daemon sent ${first.error}`));
        const frame = parseDaemonFrame(first.frame);
        if (!frame || frame.t !== 'welcome') return fail(new Error('daemon sent no welcome'));
        if (!frame.ok) return fail(new Error(`daemon refused: ${frame.error}`));
        settled = true;
        clearTimeout(timer);
        // Only the handshake's own listeners: a stream handed in by a caller
        // may carry listeners of its own.
        socket.off('error', onError);
        socket.off('close', onClose);
        socket.off('end', onClose);
        const leftover: unknown[] = [];
        for (const d of decoded.slice(1)) {
          // A garbled frame right behind the welcome is a broken handshake.
          if ('error' in d) {
            settled = false;
            return fail(new Error(`daemon sent ${d.error}`));
          }
          leftover.push(d.frame);
        }
        resolve(new DaemonClient(socket, socketPath, frame, leftover, decoder, how.closeOnEnd));
      };
      socket.on('data', onFirstData);
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  get buildId(): string {
    return this.welcome.buildId;
  }

  /**
   * Whether the daemon answers the ops of capability `cap` (its welcome's
   * `caps`). A daemon that predates the list answers none of them.
   */
  supports(cap: DaemonCap): boolean {
    return this.welcome.caps?.includes(cap) ?? false;
  }

  /** Whether this daemon runs another build - it will refuse new spawns. */
  get stale(): boolean {
    return this.welcome.stale;
  }

  /** Terminal events. */
  onEvent(listener: (ev: HostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** An extension's events (`ProtocolExtension.events`). */
  onExtensionEvent(listener: (ev: ExtensionEvent) => void): () => void {
    this.extensionListeners.add(listener);
    return () => this.extensionListeners.delete(listener);
  }

  /**
   * A remote host's streamed answers - exec output, transfer chunks, watch
   * changes (a private plan › 7.4-7.6). Sent only to
   * the connection that asked; never a terminal event.
   */
  onHostOpEvent(listener: (ev: HostOpEvent) => void): () => void {
    this.hostOpListeners.add(listener);
    return () => this.hostOpListeners.delete(listener);
  }

  /**
   * What a daemon several apps share says about the others - the grid
   * another client set, a snapshot this one must take, who is attached
   * (a private plan › 14). Never a terminal event.
   */
  onViewEvent(listener: (ev: ViewEvent) => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  /** This connection's number on a multi-client daemon (its welcome), else null. */
  get connectionId(): number | null {
    return this.welcome.connectionId ?? null;
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  call<T = unknown>(op: CallOp, args: unknown = {}): Promise<T> {
    if (this._closed) return Promise.reject(new Error('daemon connection closed'));
    // A daemon that did not list the op's capability drops the frame and
    // never answers: the call would hang for good (an older build's daemon
    // still draining its terminals).
    const cap = capOfOp(op);
    if (cap && !this.supports(cap)) {
      return Promise.reject(new Error(`daemon lacks capability ${cap}`));
    }
    const req = this.nextReq++;
    const frame = encodeFrame({ t: 'call', req, op, args });
    // The daemon drops a connection that sends a frame past the cap - and
    // every terminal on it. Refuse the one call instead (a huge prompt).
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      return Promise.reject(new Error('That is too large to send.'));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(req, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.write(frame);
    });
  }

  cast(op: CastOp, args: unknown = {}): void {
    if (this._closed) return;
    this.socket.write(encodeFrame({ t: 'cast', op, args }));
  }

  close(): void {
    if (this._closed) return;
    this.socket.end();
    this.socket.destroy();
    this.settleClosed();
  }

  private onData(chunk: string): void {
    for (const decoded of this.decoder.decode(chunk)) {
      if ('error' in decoded) {
        this.socket.destroy();
        this.settleClosed();
        return;
      }
      this.inbox.push(decoded.frame);
    }
    this.drain();
  }

  /**
   * Hand out the inbox in order - and a reply ENDS THE TURN: the frames behind
   * it wait for a later macrotask (`defer`), so that whoever awaited the call
   * has run before the next frame is seen, however many `await`s deep that
   * continuation sits. One socket read carries whatever the daemon wrote
   * since the last one, and main's adopt (terminal.ts) tells the chunks the
   * snapshot already holds from the ones that follow it by exactly that
   * continuation: with the reply and the pty's next chunk in one read, the
   * chunk was dispatched first and dropped as "already in the snapshot" -
   * lost output on every reattach under load (2026-10-04). A later chunk is
   * its own macrotask, so the plain in-order dispatch is right for it.
   */
  private drain(): void {
    if (this.deferred) return;
    while (this.inbox.length > 0) {
      const frame = parseDaemonFrame(this.inbox.shift());
      if (!frame) continue;
      if (frame.t === 'event') {
        const ev = frame.ev;
        if (isExtensionEvent(ev)) {
          const extensionEvent = ev as unknown as ExtensionEvent;
          for (const l of this.extensionListeners) this.deliver(l, extensionEvent);
        } else if (isHostOpEvent(ev)) for (const l of this.hostOpListeners) this.deliver(l, ev);
        else if (isViewEvent(ev)) for (const l of this.viewListeners) this.deliver(l, ev);
        else for (const l of this.eventListeners) this.deliver(l, ev);
        continue;
      }
      if (frame.t === 'reply') {
        const p = this.pending.get(frame.req);
        if (p) {
          this.pending.delete(frame.req);
          if (frame.ok) p.resolve(frame.result);
          else p.reject(new Error(frame.error));
        }
        if (this.inbox.length > 0) this.defer();
        return;
      }
    }
  }

  /**
   * One listener's throw costs that listener that frame, never the inbox: a
   * throw out of `drain` left every frame behind it - every terminal's
   * output and every reply - waiting for the next socket read, and a
   * listener that throws on each chunk (a screen copy past xterm's
   * 50 MB write cap, crash report 157462270, v0.6.3) froze every terminal in the
   * app. Each distinct error is still rethrown once, on its own macrotask,
   * so the crash reporter sees it without a report per chunk.
   */
  private deliver<E>(listener: (ev: E) => void, ev: E): void {
    try {
      listener(ev);
    } catch (err) {
      const key = err instanceof Error ? err.message : String(err);
      if (this.listenerFaults.has(key)) return;
      this.listenerFaults.add(key);
      setImmediate(() => {
        throw err;
      });
    }
  }

  private defer(): void {
    this.deferred = true;
    setImmediate(() => {
      this.deferred = false;
      this.drain();
    });
  }

  private settleClosed(): void {
    if (this._closed) return;
    this._closed = true;
    // Sent, never answered: the daemon may or may not have done it (spec
    // 7.11) - the caller re-reads state instead of repeating a mutation.
    for (const p of this.pending.values()) p.reject(new OutcomeUnknownError());
    this.pending.clear();
    for (const l of this.closeListeners) l();
  }
}
