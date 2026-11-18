import type { CallOp, CastOp, HostOpEvent } from './protocol';

/**
 * What the daemon server asks of a remote host's ops and language servers
 * (host-ops.ts, host-lsp.ts - Pro since a private plan
 * › M7). The server is core and dispatches to them only when the remote
 * runtime passes them in (`DaemonServerOptions.hostOps` / `.lsp`).
 */

export type OpConnection = {
  id: number;
  /** Send one event to this connection; resolves once the socket took it (drain). */
  emit: (ev: HostOpEvent) => Promise<void>;
  readonly closed: boolean;
};

/** What a call answers, and work to do once the reply left (a transfer's chunks). */
export type OpResult = { result: unknown; after?: () => Promise<void> };

export type HostOps = {
  handle(op: CallOp, args: unknown, conn: OpConnection): Promise<OpResult>;
  /** Whether `op` is one of these (the server's dispatch). */
  handles(op: CallOp): boolean;
  /** The casts answered here (port forwarding's data, end and acks), beside the chain. */
  handlesCast(op: CastOp): boolean;
  cast(op: CastOp, args: unknown, conn: OpConnection): void;
  connectionGone(conn: OpConnection): void;
  /** Processes still running - they keep the daemon from its idle exit. */
  running(): number;
  /** Fires when an exec starts or ends (the daemon re-checks its idle state). */
  onRunningChange(listener: () => void): () => void;
  /** `SSH_AUTH_SOCK` while a client's agent forward is live (spec 10.2), else {}. */
  agentEnv(): Record<string, string>;
  /**
   * The body `conn` sent with `transferPut` under `transferId`, taken (gone
   * after) - a relayed agent archive, a screenshot (plan 29 spec › 3.4, 7.3).
   * Null when there is none, or it is another connection's.
   */
  takeTransfer(transferId: string, conn: OpConnection): Buffer | null;
  dispose(): void;
};

export type HostLsp = {
  /** `lspOpen` / `lspClose` / `lspInstall`. */
  handles(op: CallOp): boolean;
  /** `lspSend`. */
  handlesCast(op: CastOp): boolean;
  /** Throws `bad args` for a malformed request (the server answers it). */
  call(
    op: CallOp,
    args: unknown,
    conn: OpConnection,
    take: (transferId: string) => Buffer | null,
  ): Promise<unknown>;
  cast(op: CastOp, args: unknown, conn: OpConnection): void;
  /** The connection left: its servers are killed. */
  connectionGone(conn: OpConnection): void;
  /** Servers running now (tests, logs) - never counted for the idle exit. */
  count(): number;
  dispose(): void;
};
