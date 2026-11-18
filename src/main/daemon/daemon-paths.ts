import { createHash } from 'node:crypto';

/**
 * Where the session daemon lives on disk and how its socket is named
 * (a private plan). Pure - the rules both the app and the
 * daemon follow, with the platform and the folders passed in.
 *
 * `<userData>/daemon/` holds the token (0600), one socket per
 * `(protocol version, build id)` and the logs. Dev and release use
 * different userData folders (app-env.ts), so they never share a daemon.
 */
export const DAEMON_DIR_NAME = 'daemon';
export const TOKEN_FILE_NAME = 'token';

/**
 * A Unix socket path is capped by the kernel (104 bytes on macOS, 108 on
 * Linux, the terminator included). `~/Library/Application Support/<app>/
 * daemon/daemon-v1-<build>.sock` runs past it on most Macs, so the sockets
 * then move to a short folder under `/tmp` (never `os.tmpdir()`: the per-user
 * temp folder macOS hands out is itself ~50 bytes long), keyed by a hash of
 * userData so two installs never collide. The token and the logs stay with
 * the install.
 */
export const SOCKET_PATH_MAX = 100;

/** The longest build id the socket name may carry (sanitizeBuildId caps it). */
export const BUILD_ID_MAX = 40;

/** `daemon-v<protocol>-<build id>.sock` */
const SOCKET_NAME_RE = /^daemon-v(\d+)-([A-Za-z0-9._-]+)\.sock$/;

export function hashOf(text: string, length = 12): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

/** Only the characters a socket name, a pipe name and a log name all accept. */
export function sanitizeBuildId(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return clean.length > 0 ? clean.slice(0, BUILD_ID_MAX) : 'unknown';
}

/**
 * What identifies the bundle a daemon runs from. A packaged app is its
 * version (one bundle per release); a dev build keeps its version across
 * rebuilds, so the daemon entry's mtime goes in too - an electron-vite
 * rebuild then starts a fresh daemon beside the old one, which is exactly
 * the update path (plan › Phase 2a) exercised on every rebuild.
 */
export function buildIdFor(input: {
  appVersion: string;
  packaged: boolean;
  /** `statSync(daemon entry).mtimeMs`, dev only; null when unknown. */
  entryMtimeMs: number | null;
}): string {
  const version = sanitizeBuildId(input.appVersion);
  if (input.packaged) return version;
  const stamp = input.entryMtimeMs === null ? 'x' : Math.floor(input.entryMtimeMs).toString(36);
  return sanitizeBuildId(`${version}-dev-${stamp}`);
}

export function socketFileName(protocolVersion: number, buildId: string): string {
  return `daemon-v${protocolVersion}-${sanitizeBuildId(buildId)}.sock`;
}

export function parseSocketFileName(
  name: string,
): { protocolVersion: number; buildId: string } | null {
  const m = SOCKET_NAME_RE.exec(name);
  if (!m) return null;
  return { protocolVersion: Number.parseInt(m[1], 10), buildId: m[2] };
}

export type DaemonLayout = {
  /** `<userData>/daemon` - the token and the logs. */
  dir: string;
  tokenPath: string;
  /**
   * Where the sockets are: `dir`, or the temp-dir fallback when `dir` is
   * too long for a socket path. Null on Windows (pipes live in no folder).
   */
  socketDir: string | null;
  /** The socket path (or pipe name) for one `(protocol, build)`. */
  socketPath: (protocolVersion: number, buildId: string) => string;
  logPath: (buildId: string) => string;
};

export function daemonLayout(input: {
  userData: string;
  platform: NodeJS.Platform;
  /** The short system temp root the sockets fall back to - `/tmp` on POSIX. */
  shortTmpDir: string;
  join: (...parts: string[]) => string;
  /**
   * The install's token (Windows): pipe names are machine-global, so a name
   * derived from public inputs alone could be squatted by another local user,
   * who would then receive the token our hello sends. Keyed by the secret,
   * nobody without it can predict the name.
   */
  secret?: string;
}): DaemonLayout {
  const { userData, platform, shortTmpDir, join } = input;
  const dir = join(userData, DAEMON_DIR_NAME);
  const tokenPath = join(dir, TOKEN_FILE_NAME);
  // One log per build (every protocol a build speaks writes to the same one).
  const logPath = (buildId: string): string => join(dir, `daemon-${sanitizeBuildId(buildId)}.log`);
  if (platform === 'win32') {
    const key = hashOf(input.secret ? `${userData}\0${input.secret}` : userData);
    return {
      dir,
      tokenPath,
      socketDir: null,
      socketPath: (v, buildId) =>
        `\\\\.\\pipe\\double0-daemon-v${v}-${key}-${sanitizeBuildId(buildId)}`,
      logPath,
    };
  }
  // The longest name this layout will ever produce, measured against the cap.
  const probe = join(dir, socketFileName(99, 'x'.repeat(BUILD_ID_MAX)));
  const socketDir =
    Buffer.byteLength(probe) <= SOCKET_PATH_MAX
      ? dir
      : join(shortTmpDir, `double0-daemon-${hashOf(userData)}`);
  return {
    dir,
    tokenPath,
    socketDir,
    socketPath: (v, buildId) => join(socketDir, socketFileName(v, buildId)),
    logPath,
  };
}

/**
 * The sockets in a folder listing that a client speaking `versions` may
 * open, newest protocol first and by build id within one - a fixed order
 * whatever the folder listing's, so "the first daemon" means the same thing
 * on every launch (daemon-backend.ts routes an id two daemons hold to the
 * first). Anything else in the folder (the token, logs, a future version's
 * socket) is left alone.
 */
export function compatibleSockets(
  fileNames: string[],
  versions: number[],
): { fileName: string; protocolVersion: number; buildId: string }[] {
  const out: { fileName: string; protocolVersion: number; buildId: string }[] = [];
  for (const fileName of fileNames) {
    const parsed = parseSocketFileName(fileName);
    if (parsed && versions.includes(parsed.protocolVersion)) out.push({ fileName, ...parsed });
  }
  return out.sort(
    (a, b) => b.protocolVersion - a.protocolVersion || a.buildId.localeCompare(b.buildId),
  );
}

/** `daemon-<build id>.log`, or the rotated `daemon-<build id>.log.1`. */
const LOG_NAME_RE = /^daemon-([A-Za-z0-9._-]+)\.log(?:\.1)?$/;

/** The build id a daemon log file belongs to, or null for any other file. */
export function parseLogFileName(name: string): string | null {
  const m = LOG_NAME_RE.exec(name);
  return m ? m[1] : null;
}

/** How old a build's log must be, with no socket of that build left, before it is swept. */
export const STALE_LOG_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The log files to delete from the daemon folder: those of a build that has
 * no socket any more (its daemon idle-exited or died, and in dev every
 * rebuild leaves such a pair behind), untouched for `maxAgeMs`. A build with
 * a socket file - answering or not - keeps its log: a daemon that is only
 * slow still writes there, and a dead one's log is what explains its death.
 * The current build's log is never swept, socket or not.
 */
export function staleLogFiles(
  logs: { name: string; mtimeMs: number }[],
  buildIdsWithSocket: Iterable<string>,
  ownBuildId: string,
  now: number,
  maxAgeMs = STALE_LOG_AGE_MS,
): string[] {
  const keep = new Set(buildIdsWithSocket);
  keep.add(sanitizeBuildId(ownBuildId));
  const out: string[] = [];
  for (const log of logs) {
    const buildId = parseLogFileName(log.name);
    if (buildId === null || keep.has(buildId)) continue;
    if (now - log.mtimeMs >= maxAgeMs) out.push(log.name);
  }
  return out;
}
