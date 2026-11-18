import type { Edition } from '../extension';
import type { PtyHost } from '../pty-host';
import type { DaemonServerExtension, startDaemonServer } from './daemon-server';
import type { ProtocolExtension } from './protocol';

/**
 * The session daemon's Pro slot (a private plan ›
 * Extension points). `daemon/daemon-main.ts` is the only core file that
 * imports `@pro/daemon`. Never import Electron behind it: the daemon runs
 * under ELECTRON_RUN_AS_NODE, and the remote runtime under a host's Node.
 */
export type DaemonExtension = {
  edition: Edition;
  /** The remote host runtime (M7); absent = this build never serves remote. */
  remote?: DaemonRemote;
  /** Its ops, casts and events on the wire - registered before the server starts. */
  protocol?: ProtocolExtension;
  /**
   * Its work beside a local daemon's terminals (agents that outlive the app
   * like the terminals do); absent = the daemon serves terminals only.
   */
  localServer?(args: LocalServingArgs, host: PtyHost): DaemonServerExtension | undefined;
};

/** What a local daemon's extension reads of the daemon's arguments. */
export type LocalServingArgs = {
  /** A remote host's daemon builds its own (`remote.serving`). */
  remote: boolean;
  /** The whole command line: the extension reads its own flags off it. */
  argv: readonly string[];
};

/** What the remote serving reads of the daemon's arguments. */
export type RemoteServingArgs = {
  socket: string;
  buildId: string;
  appVersion: string;
  remoteRoot: string | null;
  /** The whole command line: the extension reads its own flags off it. */
  argv: readonly string[];
};

/** The server options a remote daemon adds. */
export type RemoteServerOptions = Pick<
  Parameters<typeof startDaemonServer>[0],
  'extraCaps' | 'fsReadDir' | 'prepareSpawn' | 'hostOps' | 'hostEvents' | 'extension' | 'lsp'
>;

export type DaemonRemote = {
  /** The runtime's own modes (`start`, `connect`, ...); anything else is serve mode. */
  modes: ReadonlySet<string>;
  runMode(mode: string, rest: string[]): Promise<number>;
  serving(
    args: RemoteServingArgs,
    host: PtyHost,
    log: (message: string) => void,
  ): RemoteServerOptions;
};
