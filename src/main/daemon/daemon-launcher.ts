import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TerminalBackend } from '../terminal-backend';
import { DaemonBackend } from './daemon-backend';
import type { AttachedDaemon } from './extension-channel';
import { DaemonClient } from './daemon-client';
import {
  buildIdFor,
  daemonLayout,
  parseLogFileName,
  parseSocketFileName,
  staleLogFiles,
  type DaemonLayout,
} from './daemon-paths';

/**
 * The real-world `DaemonBackend` (a private plan): the token
 * file, the socket folder, and the detached relaunch of the app's own binary
 * as a node process on the daemon entry. Pure node - index.ts passes in what
 * only Electron knows (userData, the version, whether the app is packaged).
 *
 * It never throws: whatever keeps the daemon from being set up (an unwritable
 * userData, a socket folder that is not ours) comes back as a backend whose
 * `ready()` rejects, which is what `createTerminalBackend` takes as "fall
 * back to in-process terminals". Throwing here would have taken the whole
 * terminal registration down with it (2026-10-04).
 */
export type DaemonLaunchOptions = {
  userData: string;
  appVersion: string;
  packaged: boolean;
  /** The binary to relaunch - `process.execPath`. */
  execPath: string;
  /** The built daemon entry, next to main's bundle (`out/main/daemon.js`). */
  daemonEntry: string;
  log: (message: string) => void;
  platform?: NodeJS.Platform;
  /** The short temp root the sockets fall back to (daemon-paths.ts). Default `/tmp`. */
  shortTmpDir?: string;
  /** How long a spawned daemon gets to answer (tests). */
  startTimeoutMs?: number;
  /** An extension's own flags on the daemon's command line (`MainExtension.daemonArgs`). */
  extensionArgs?: readonly string[];
  /** The extension's look at every daemon attached (`DaemonBackendDeps.onAttach`). */
  onAttach?: (daemon: AttachedDaemon) => void;
};

/** A fresh token: 32 random bytes, hex. */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The install's token, created on first use and never rotated (every daemon
 * of this userData shares it; rotating would orphan an older build's). The
 * file is kept at 0600 whether it was just written or already there.
 */
export function ensureToken(dir: string, tokenPath: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows has no mode bits; the user's profile folder is the protection.
  }
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      try {
        chmodSync(tokenPath, 0o600);
      } catch {
        // See above.
      }
      return existing;
    }
  }
  const token = newToken();
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // See above.
  }
  return token;
}

/**
 * Make sure the socket folder is ours alone. Its name is predictable
 * (`/tmp/double0-daemon-<hash of userData>`) and `/tmp` is world-writable,
 * so another local user could create it first: they would then own the
 * folder, could swap our socket for one of theirs, read the token from the
 * app's hello and drive our shells. A folder that is a symlink, belongs to
 * someone else or stays open to others after a chmod is refused - the app
 * runs its terminals in-process instead.
 */
export function ensureSocketDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`socket folder ${dir} is not a plain directory`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid !== uid) {
    throw new Error(`socket folder ${dir} belongs to uid ${st.uid}, not ${uid}`);
  }
  if ((st.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
    if ((lstatSync(dir).mode & 0o077) !== 0) {
      throw new Error(`socket folder ${dir} stays open to other users`);
    }
  }
}

/**
 * Delete the logs of builds that have no socket left and have not been
 * written to for a day (daemon-paths.ts › staleLogFiles) - in dev every
 * rebuild leaves a `daemon-<build>.log` behind. Runs once the backend is
 * ready, so the folder is as settled as it gets; the current build's log and
 * any build with a socket file, answering or not, are kept. Returns what went.
 */
export function sweepDaemonLogs(
  layout: DaemonLayout,
  ownBuildId: string,
  log: (message: string) => void,
  now = Date.now(),
): string[] {
  let logs: { name: string; mtimeMs: number }[];
  try {
    logs = readdirSync(layout.dir)
      .filter((name) => parseLogFileName(name) !== null)
      .map((name) => ({ name, mtimeMs: statSync(join(layout.dir, name)).mtimeMs }));
  } catch {
    return [];
  }
  const withSocket = new Set<string>();
  if (layout.socketDir) {
    try {
      for (const name of readdirSync(layout.socketDir)) {
        const parsed = parseSocketFileName(name);
        if (parsed) withSocket.add(parsed.buildId);
      }
    } catch {
      // No socket folder yet: nothing has a socket.
    }
  }
  const stale = staleLogFiles(logs, withSocket, ownBuildId, now);
  const gone: string[] = [];
  for (const name of stale) {
    try {
      unlinkSync(join(layout.dir, name));
      gone.push(name);
    } catch {
      // In use or already gone.
    }
  }
  if (gone.length > 0) log(`swept ${gone.length} old daemon log file(s)`);
  return gone;
}

/** A backend that never comes up: `ready()` rejects with why, nothing else is ever called. */
function unavailableBackend(err: unknown): TerminalBackend {
  const ready = Promise.reject(err instanceof Error ? err : new Error(String(err)));
  // `createTerminalBackend` handles the rejection; this keeps it from counting
  // as unhandled should nobody ask.
  ready.catch(() => undefined);
  const never = (): never => {
    throw new Error('session daemon unavailable');
  };
  const noop = (): void => undefined;
  return {
    ready: () => ready,
    onEvent: () => noop,
    spawn: never,
    list: never,
    adopt: never,
    input: noop,
    resize: noop,
    pause: noop,
    resume: noop,
    kill: noop,
    setTone: noop,
    noteLine: noop,
    size: never,
    foregroundBusy: never,
    markerDriven: never,
    agentStatus: never,
    inputList: never,
    killAll: never,
    shutdown: async () => undefined,
  };
}

export function createDaemonBackend(opts: DaemonLaunchOptions): TerminalBackend {
  const platform = opts.platform ?? process.platform;
  try {
    return prepareDaemonBackend(opts, platform);
  } catch (err) {
    opts.log(`daemon not set up: ${String(err)}`);
    return unavailableBackend(err);
  }
}

function prepareDaemonBackend(opts: DaemonLaunchOptions, platform: NodeJS.Platform): DaemonBackend {
  // `/tmp`, not os.tmpdir(): see SOCKET_PATH_MAX in daemon-paths.ts.
  const base = {
    userData: opts.userData,
    platform,
    shortTmpDir: opts.shortTmpDir ?? '/tmp',
    join,
  };
  const { dir, tokenPath } = daemonLayout(base);
  const token = ensureToken(dir, tokenPath);
  // Laid out again with the token: Windows pipe names are keyed by it.
  const layout = daemonLayout({ ...base, secret: token });
  if (layout.socketDir && layout.socketDir !== layout.dir) ensureSocketDir(layout.socketDir);
  let entryMtimeMs: number | null = null;
  try {
    entryMtimeMs = statSync(opts.daemonEntry).mtimeMs;
  } catch {
    // Missing entry: the spawn fails and the backend falls back in-process.
  }
  const buildId = buildIdFor({
    appVersion: opts.appVersion,
    packaged: opts.packaged,
    entryMtimeMs,
  });
  const hello = { token, appVersion: opts.appVersion, buildId };

  const backend = new DaemonBackend({
    buildId,
    ...(opts.onAttach ? { onAttach: opts.onAttach } : {}),
    socketPathFor: layout.socketPath,
    listSocketNames: () => {
      if (!layout.socketDir) return null;
      try {
        return readdirSync(layout.socketDir);
      } catch {
        return [];
      }
    },
    connect: (socketPath) => DaemonClient.connect(socketPath, hello),
    spawnDaemon: (socketPath) => {
      // The app's own binary as a plain node runtime: Electron's ABI, so the
      // node-pty build the app ships loads. Detached (its own session, so a
      // terminal's SIGINT to the dev server never reaches it) with stdio
      // ignored and unref'd, so the app can quit without it.
      const child = spawn(
        opts.execPath,
        [
          opts.daemonEntry,
          '--socket',
          socketPath,
          '--token-file',
          layout.tokenPath,
          '--build-id',
          buildId,
          '--app-version',
          opts.appVersion,
          '--log',
          layout.logPath(buildId),
          ...(opts.extensionArgs ?? []),
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
      );
      child.on('error', (err) => opts.log(`daemon spawn failed: ${err.message}`));
      child.unref();
    },
    removeDeadSocket: (socketPath) => {
      if (platform === 'win32') return;
      try {
        unlinkSync(socketPath);
      } catch {
        // Already gone.
      }
    },
    log: opts.log,
    ...(opts.startTimeoutMs !== undefined ? { startTimeoutMs: opts.startTimeoutMs } : {}),
  });
  backend.ready().then(
    () => sweepDaemonLogs(layout, buildId, opts.log),
    () => undefined,
  );
  return backend;
}
