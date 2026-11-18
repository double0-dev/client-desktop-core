import type { CallOp, ExtensionEvent } from './protocol';

/**
 * An extension's door to a session daemon (`TerminalBackend.extensionChannel`,
 * `RemoteHosts.extensionChannel`): its calls by wire name, its events, and
 * the daemon's comings and goings. Method syntax on purpose: an extension
 * narrows it to its own call and event types.
 */
export type ExtensionChannel = {
  call<T>(op: CallOp, args: Record<string, unknown>): Promise<T>;
  onEvent(listener: (ev: ExtensionEvent) => void): () => void;
  /** The daemon is gone for good - whatever the extension ran there with it. */
  onLost(listener: () => void): () => void;
  /** The daemon came back after a socket drop: events may have been missed. */
  onResync(listener: () => void): () => void;
  /**
   * A remote host's connection dropped - not a loss: its work keeps running
   * there, and a resync follows the reconnect.
   */
  onDrop?(listener: () => void): () => void;
};

/** A daemon the backend attached, as an extension's attach hook sees it. */
export type AttachedDaemon = {
  /** It is this build's daemon (else an older one, attached to drain). */
  current: boolean;
  /** Its welcome, the extension's own fields included. */
  welcome: Readonly<Record<string, unknown>>;
  cast(op: string, args: Record<string, unknown>): void;
};
