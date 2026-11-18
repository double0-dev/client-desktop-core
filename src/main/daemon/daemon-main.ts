import { readFileSync } from 'node:fs';
import { PtyHost, type PtySpawner } from '../pty-host';
import { IDLE_EXIT_GRACE_MS } from './idle-exit';
import { createDaemonLog } from './daemon-log';
import { startDaemonServer } from './daemon-server';
import { registerProtocolExtension } from './protocol';
import { daemonProcessTitle } from './process-title';
// The one core file allowed to import it (a private plan).
import { proDaemon } from '@pro/daemon';

/**
 * The session daemon's entry (a private plan): the app's own
 * binary relaunched with ELECTRON_RUN_AS_NODE=1 on this file, so node-pty's
 * Electron-ABI build loads here too. No Electron import anywhere below this
 * line - under run-as-node `electron` is a path string, not the API.
 *
 *   daemon.js --socket <path> --token-file <path> --build-id <id>
 *             --app-version <v> --log <path> [--idle-ms <n>] [extension flags]
 *
 * stdio is ignored by the parent; the log file is the only trace it leaves.
 */
export type DaemonArgs = {
  socket: string;
  tokenFile: string;
  buildId: string;
  appVersion: string;
  log: string | null;
  idleMs: number;
  /** The whole command line: an extension reads its own flags off it. */
  argv: readonly string[];
  /**
   * Runs on a remote host (`daemon.js start`, a private plan):
   * resolves `hostShell` spawns on this machine and says so in its welcome.
   */
  remote: boolean;
  /** `~/.double0` on a remote host (DOUBLE0_HOME): records, trash, the agent socket. */
  remoteRoot: string | null;
};

export function parseDaemonArgs(argv: string[]): DaemonArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const socket = get('--socket');
  const tokenFile = get('--token-file');
  if (!socket || !tokenFile) throw new Error('usage: --socket <path> --token-file <path>');
  const idle = Number.parseInt(get('--idle-ms') ?? '', 10);
  return {
    socket,
    tokenFile,
    buildId: get('--build-id') ?? 'unknown',
    appVersion: get('--app-version') ?? '0.0.0',
    log: get('--log'),
    idleMs: Number.isFinite(idle) && idle >= 0 ? idle : IDLE_EXIT_GRACE_MS,
    argv,
    remote: argv.includes('--remote'),
    remoteRoot: get('--remote-root'),
  };
}

export async function runDaemon(argv: string[]): Promise<void> {
  const args = parseDaemonArgs(argv);
  // The extension's ops are known before the first frame is parsed.
  if (proDaemon.protocol) registerProtocolExtension(proDaemon.protocol);
  // Capped and rotated (daemon-log.ts): the only trace the daemon leaves.
  const log = createDaemonLog(args.log);
  log(`start: ${proDaemon.edition} build ${args.buildId}${args.remote ? ' (remote)' : ''}`);
  const token = readFileSync(args.tokenFile, 'utf8').trim();
  if (token.length === 0) throw new Error('empty token file');
  // Not on macOS - there the title setter registers the daemon as a Dock
  // application (process-title.ts).
  const title = daemonProcessTitle(process.platform);
  // A remote host may run one daemon per app build at once (an update drains
  // the older one): its title names the build (`pgrep -fa double0-session-daemon`).
  if (title) process.title = args.remote ? `${title} ${args.buildId}` : title;

  // Loaded here, not at the top: the remote runtime's `connect` / `start`
  // modes run from this same file on every bridge and need no native module.
  // A CommonJS package, so read both ways (CLAUDE.md › named imports).
  const pty = (await import('@homebridge/node-pty-prebuilt-multiarch')) as unknown as {
    spawn?: PtySpawner;
    default?: { spawn?: PtySpawner };
  };
  const spawnPty = pty.spawn ?? pty.default?.spawn;
  if (!spawnPty) throw new Error('node-pty has no spawn');
  const host = new PtyHost(spawnPty);
  // A daemon on a remote host is the official build's (a private plan › M7).
  if (args.remote && !proDaemon.remote) throw new Error('this build runs no remote daemon');
  const remote = args.remote && proDaemon.remote ? proDaemon.remote.serving(args, host, log) : null;
  let exitCode = 0;
  const server = startDaemonServer({
    socketPath: args.socket,
    token,
    buildId: args.buildId,
    appVersion: args.appVersion,
    host,
    ...(remote ?? {}),
    // The extension's work beside the terminals - a remote daemon's own, else
    // the local one's (it outlives the app like the terminals do).
    extension: remote?.extension ?? proDaemon.localServer?.(args, host),
    idleGraceMs: args.idleMs,
    log,
    onExit: (reason) => {
      log(`exit: ${reason}`);
      // Let the log write and the socket close settle before the process ends.
      setTimeout(() => process.exit(exitCode), 20);
    },
  });

  const onSignal = (signal: string): void => {
    exitCode = 0;
    void server.shutdown(`signal ${signal}`);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGHUP', () => onSignal('SIGHUP'));
  process.on('uncaughtException', (err) => log(`uncaughtException: ${String(err?.stack ?? err)}`));
  process.on('unhandledRejection', (reason) => log(`unhandledRejection: ${String(reason)}`));

  await server.listening;
}

const [first, ...rest] = process.argv.slice(2);
const remoteRuntime = proDaemon.remote;
if (first && remoteRuntime?.modes.has(first)) {
  // Let stdout drain before the process ends (a bridge's last bytes).
  void remoteRuntime.runMode(first, rest).then((code) => {
    process.stdout.write('', () => process.exit(code));
  });
} else {
  void runDaemon(process.argv.slice(2)).catch((err) => {
    // No stdio to speak of; the log may not exist yet either. Exit non-zero so
    // the parent's connection attempts time out instead of waiting on nothing.
    try {
      const path = parseDaemonArgs(process.argv.slice(2)).log;
      createDaemonLog(path)(`failed to start: ${String(err?.stack ?? err)}`);
    } catch {
      // Not even the arguments parse.
    }
    process.exit(1);
  });
}
