import type { WebContents } from 'electron';
import type { ExtensionChannel } from './daemon/extension-channel';
import type { CallOp, CastOp, DaemonCap, HostOpEvent } from './daemon/protocol';
import { HostDownError, unreachableRuntime, type HostRuntime } from './host-runtime';
import type { HostStatus } from './host-types';
import type { TerminalBackend } from './terminal-backend';
import type { Gated } from './extension';

/**
 * The remote hosts as the rest of main sees them (a private plan)
 * - Pro since a private plan › M7. `index.ts` starts them
 * through `MainExtension.remoteHosts`, which hands back the terminal backend
 * every terminal goes through (the host router, local ids passed on
 * unchanged) and this view of the host manager. Without Pro there is no
 * host: every terminal is local and every question about a host answers
 * "unknown, away".
 */
export type RemoteHosts = {
  status(hostId: string): HostStatus | null;
  /** Every host in the store. */
  statuses(): HostStatus[];
  label(hostId: string): string | null;
  /** Connected and its daemon announced `cap`. */
  supports(hostId: string, cap: DaemonCap): boolean;
  /** Its files and processes; EHOSTDOWN for each call while it is away. */
  runtime(hostId: string): HostRuntime;
  /** `~/.double0` there. */
  root(hostId: string): Promise<string>;
  call<T>(hostId: string, op: CallOp, args: Record<string, unknown>): Promise<T>;
  cast(hostId: string, op: CastOp, args: Record<string, unknown>, cap: DaemonCap): boolean;
  /** Send a body ahead of a call that names it; resolves with its transfer id. */
  putTransfer(hostId: string, body: Buffer): Promise<string>;
  /** Its daemon's extension channel (an extension's work on that host). */
  extensionChannel(hostId: string): ExtensionChannel | null;
  /** Every host's op events, tagged with the host. */
  onOpEvent(listener: (hostId: string, ev: HostOpEvent) => void): () => void;
  /** A host's daemon attached (every reconnect too). */
  onAttached(listener: (hostId: string) => void): () => void;
  onDisconnected(hostId: string, listener: () => void): () => void;
  /** A host left the store. */
  onHostRemoved(listener: (hostId: string) => void): () => void;
  /** The host a terminal runs on; null for this machine's. */
  hostOfTerminal(ptyId: string): string | null;
  /** The port forwards to hosts (`hosts/port-forward.ts`). */
  forwards: {
    /** Forward `port` on the host for `holder`; resolves with the local port, null when none. */
    hold(holder: string, hostId: string, port: number): Promise<number | null>;
    releaseHolder(holder: string): void;
    list(): { hostId: string; port: number; localPort: number }[];
  };
};

/** What `index.ts` hands the hosts when it starts them. */
export type RemoteHostsContext = Gated & {
  /** This machine's terminals (the session daemon, or in-process). */
  localBackend: TerminalBackend;
  /** The main app window's page, if open (the login tab is asked there). */
  mainWebContents: () => WebContents | null;
  /** The folder main's bundle runs from: the host runtime ships beside it. */
  mainDir: string;
  /** Main's read of the remote project roots: the router is ready after it too. */
  hostRootsRead: Promise<unknown>;
};

export type RemoteHostsStarted = {
  /** The backend every terminal goes through. */
  backend: TerminalBackend;
  hosts: RemoteHosts;
  /** At quit, beside the terminals' own disposal. */
  dispose(): void;
};

const none = (): (() => void) => () => undefined;

/** The core build's hosts: none. */
export const NO_REMOTE_HOSTS: RemoteHosts = {
  status: () => null,
  statuses: () => [],
  label: () => null,
  supports: () => false,
  runtime: (hostId) => unreachableRuntime(hostId),
  root: () => Promise.reject(new HostDownError()),
  call: () => Promise.reject(new HostDownError()),
  cast: () => false,
  putTransfer: () => Promise.reject(new HostDownError()),
  extensionChannel: () => null,
  onOpEvent: none,
  onAttached: none,
  onDisconnected: none,
  onHostRemoved: none,
  hostOfTerminal: () => null,
  forwards: {
    hold: () => Promise.resolve(null),
    releaseHolder: () => undefined,
    list: () => [],
  },
};

/** Every terminal on this machine, no host anywhere. */
export function localOnly(localBackend: TerminalBackend): RemoteHostsStarted {
  return { backend: localBackend, hosts: NO_REMOTE_HOSTS, dispose: () => undefined };
}

/**
 * `backend`, ready only once `gate` settled too (the remote project roots):
 * a create that ran before them would read a remote folder as local.
 */
export function readyAfter(backend: TerminalBackend, gate: Promise<unknown>): TerminalBackend {
  const ready = Promise.all([backend.ready(), gate.catch(() => undefined)]).then(() => undefined);
  return new Proxy(backend, {
    get(target, prop) {
      if (prop === 'ready') return () => ready;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
