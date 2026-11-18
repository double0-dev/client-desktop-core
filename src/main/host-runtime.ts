import { spawn } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import nodePath from 'node:path';
import { findOnPath } from './user-path';

/**
 * The machine a path lives on, as the main process's I/O sees it
 * (a private plan › 10.1, 11): processes, files, watches.
 * Every handler that touches a project's files - git (`runGit`), the explorer
 * and editor (`fs.ts`), the search index, child-repo discovery, command
 * detection, the worktree seed and the watchers - takes its I/O from
 * `runtimeFor(path)` instead of node directly. Today every path is local; a
 * remote session's paths will resolve to a runtime that speaks to the session
 * daemon on its host, with the handlers unchanged.
 *
 * The surface is node's own (the `fs` member mirrors `node:fs/promises`) so
 * the local runtime is a pass-through and no handler is redesigned here.
 */

export type ExecOptions = {
  /** Working directory; absent = this process's. */
  cwd?: string;
  /** The complete environment; absent = this process's. */
  env?: NodeJS.ProcessEnv;
  /**
   * Variables sent to a REMOTE host verbatim, whatever this process's env
   * holds (git's own switches - `GIT_OPTIONAL_LOCKS=0` exported on the laptop
   * would otherwise read as "nothing added" and never travel). Locally they
   * are laid over `env`, which normally holds them already.
   */
  overlayEnv?: Record<string, string>;
  /** Written to stdin, which is then closed (closed at once without). */
  input?: string;
  /** Killed with SIGKILL past this, and the call rejects with `timeoutMessage`. */
  timeoutMs?: number;
  timeoutMessage?: string;
  /** stdout is kept up to this many characters (bytes for `execBinary`). */
  maxStdout?: number;
  /** stderr is kept up to this many characters. */
  maxStderr?: number;
  /**
   * Every piece of stderr as it arrives (a clone's `--progress` lines), on
   * top of the collected copy - which `maxStderr` still caps.
   */
  onStderr?: (chunk: string) => void;
  /**
   * Aborting stops the run (SIGTERM locally, `execCancel` on a host); the
   * call then resolves with whatever exit the process reports, as a kill
   * from outside would.
   */
  signal?: AbortSignal;
};

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecBinaryResult = { code: number; stdout: Buffer; stderr: string };

export type HostFs = {
  stat: typeof stat;
  lstat: typeof lstat;
  readdir: typeof readdir;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  mkdir: typeof mkdir;
  mkdtemp: typeof mkdtemp;
  rename: typeof rename;
  unlink: typeof unlink;
  rm: typeof rm;
  cp: typeof cp;
};

/**
 * What a remote runtime's watcher adds to node's (remote-runtime.ts): the
 * first answer, the strategy the host chose (`poll` past a Linux host's
 * inotify budget - spec 11.2) and the folders a polling watch should read.
 */
export type HostWatcher = {
  ready?: Promise<'native' | 'poll'>;
  mode?: 'native' | 'poll';
  hints: string[];
  hint?: (dirs: string[]) => void;
};

export type HostRuntime = {
  /** Set for a remote host's runtime (hosts/remote-runtime.ts); absent = this machine. */
  remote?: {
    hostId: string;
    label?: () => string;
    /**
     * The folder and kind a watch of this runtime was opened on, by the id the
     * host's `fs-changed` events name - their paths are relative to it
     * (Search Everywhere's index learns of changes this way, plan 29 spec › 5.2).
     */
    watchRoot?: (watchId: string) => { root: string; kind: 'tree' | 'gitdir' } | null;
  };
  /**
   * Run `file` with `args` and collect its output. Resolves with the exit code
   * (never rejects on a non-zero one); rejects when it cannot run at all (not
   * found, bad cwd) or on the timeout.
   */
  exec: (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;
  /** Like `exec`, with stdout kept as raw bytes (a blob read through git). */
  execBinary: (file: string, args: string[], opts?: ExecOptions) => Promise<ExecBinaryResult>;
  fs: HostFs;
  /**
   * A watcher on `path` (recursive where the platform has it). `kind:
   * 'gitdir'` tells a remote host it is a git dir (watched non-recursively,
   * spec 11.2); the local runtime ignores it.
   */
  watch: (path: string, opts?: { recursive?: boolean; kind?: 'tree' | 'gitdir' }) => FSWatcher;
  realpath: (path: string) => Promise<string>;
  /** `bin`'s absolute path on the user's login PATH, or null. */
  which: (bin: string) => Promise<string | null>;
  /**
   * Move `path` to the host's own trash folder (`~/.double0/trash`) - a
   * remote host's files never reach this machine's bin. Absent locally: the
   * OS trash (Electron's `shell.trashItem`) is the caller's.
   */
  trash?: (path: string) => Promise<void>;
};

const UNCAPPED = Number.POSITIVE_INFINITY;

function run(
  file: string,
  args: string[],
  opts: ExecOptions,
  binary: boolean,
): Promise<{ code: number; stdout: string | Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env =
      opts.overlayEnv !== undefined
        ? { ...(opts.env ?? process.env), ...opts.overlayEnv }
        : opts.env;
    const child = spawn(file, args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(env !== undefined ? { env } : {}),
    });
    const maxStdout = opts.maxStdout ?? UNCAPPED;
    const maxStderr = opts.maxStderr ?? UNCAPPED;
    let text = '';
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          settled = true;
          reject(new Error(opts.timeoutMessage ?? `${file} timed out`));
        }, opts.timeoutMs)
      : null;
    if (binary) {
      child.stdout.on('data', (d: Buffer) => {
        if (size < maxStdout) {
          chunks.push(d);
          size += d.length;
        }
      });
    } else {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        if (text.length < maxStdout) text += d;
      });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      if (stderr.length < maxStderr) stderr += d;
      opts.onStderr?.(d);
    });
    const abort = (): void => {
      child.kill('SIGTERM');
    };
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if (!settled) reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if (!settled) {
        resolve({ code: code ?? -1, stdout: binary ? Buffer.concat(chunks) : text, stderr });
      }
    });
    // The program may exit before it has read all of stdin - `git apply`
    // rejecting a malformed patch is the usual case - which lands an EPIPE on
    // this stream. An unhandled 'error' on a stream throws, and
    // `child.on('error')` above only covers the PROCESS, not its stdio:
    // without this the throw escapes to the global uncaughtException handler.
    // The exit code is the real signal, so there is nothing to do here but not
    // die.
    child.stdin.on('error', () => {});
    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** A call on a host that is not connected (spec 1.3) - never this machine's files. */
export class HostDownError extends Error {
  readonly code = 'EHOSTDOWN';
  constructor(message = 'Host is unreachable') {
    super(message);
  }
}

/**
 * The runtime of a remote host that is not connected: every call answers
 * EHOSTDOWN (spec 1.3) - never this machine's files under the same path.
 */
export function unreachableRuntime(hostId: string): HostRuntime {
  const down = (): Promise<never> => Promise.reject(new HostDownError());
  const fs = new Proxy({}, { get: () => down }) as unknown as HostFs;
  return {
    remote: { hostId },
    exec: down,
    execBinary: down,
    fs,
    watch: () => {
      throw new HostDownError();
    },
    realpath: down,
    which: () => Promise.resolve(null),
    trash: down,
  };
}

/** This machine. `which` defaults to the user's login PATH (user-path.ts). */
export function createLocalRuntime(
  deps: { which?: (bin: string) => Promise<string | null> } = {},
): HostRuntime {
  return {
    exec: (file, args, opts = {}) => run(file, args, opts, false) as Promise<ExecResult>,
    execBinary: (file, args, opts = {}) => run(file, args, opts, true) as Promise<ExecBinaryResult>,
    fs: { stat, lstat, readdir, readFile, writeFile, mkdir, mkdtemp, rename, unlink, rm, cp },
    watch: (path, opts = {}) => watch(path, { recursive: opts.recursive }),
    realpath: (path) => realpath(path),
    which: deps.which ?? findOnPath,
  };
}

export const localRuntime: HostRuntime = createLocalRuntime();

let resolver: (path: string | null | undefined) => HostRuntime = () => localRuntime;

/**
 * The runtime of the machine `path` lives on (null / absent = this one). Every
 * path is local until remote projects exist (plan 28 › M1).
 */
export function runtimeFor(path?: string | null): HostRuntime {
  return resolver(path);
}

/**
 * A host's runtime by its id - for a run on a host at a folder no project
 * there covers yet (a clone's parent, the clone search, origins of a host's
 * projects; plan 29 › M7). Null for a host this machine does not know - and
 * for every host while remote sessions are off, since none is synced then.
 */
let hostLookup: (hostId: string) => HostRuntime | null = () => null;

export function runtimeOfHost(hostId: string): HostRuntime | null {
  return hostLookup(hostId);
}

export function setHostRuntimeLookup(next: (hostId: string) => HostRuntime | null): () => void {
  const previous = hostLookup;
  hostLookup = next;
  return () => {
    hostLookup = previous;
  };
}

/**
 * This machine's path module - `node:path`, i.e. win32 on a Windows client.
 * Tests swap it (`setLocalPathForTest`) to run the Windows client's code on
 * any machine.
 */
let localPath: typeof nodePath.posix = nodePath;

export function setLocalPathForTest(next: typeof nodePath.posix): () => void {
  const previous = localPath;
  localPath = next;
  return () => {
    localPath = previous;
  };
}

/**
 * The path grammar of the machine `path` lives on: a remote host's paths are
 * POSIX whatever this machine is (no Windows hosts - spec 12), so a Windows
 * client must never join, split or resolve them with win32 rules.
 */
export function pathFor(path?: string | null): typeof nodePath.posix {
  return runtimeFor(path).remote ? nodePath.posix : localPath;
}

/**
 * A read of the remote project roots in flight (a project just added):
 * resolved now, its folder would read as local. Path-keyed handlers await
 * this before asking `runtimeFor` (terminal.ts does the same for a create).
 */
let gate: () => Promise<unknown> | null = () => null;

export function setRuntimeGate(next: () => Promise<unknown> | null): void {
  gate = next;
}

export async function runtimeReady(): Promise<void> {
  const pending = gate();
  if (pending) await pending.catch(() => undefined);
}

/** Whether `path` lives on a remote host (its runtime says so). */
export function isRemotePath(path?: string | null): boolean {
  return !!runtimeFor(path).remote;
}

/**
 * The environment a background git run adds on a remote host (spec 10.1):
 * nothing that could prompt - no askpass program, no credential manager UI,
 * no X display - so a refused fetch fails quietly instead of hanging.
 * `DISPLAY: ''` is the wire form of "unset": an overlay can only set
 * variables, and an empty DISPLAY is what ssh-askpass and the credential
 * managers read as "no display" (the spec's "DISPLAY unset").
 */
export const NO_PROMPT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GCM_INTERACTIVE: '0',
  DISPLAY: '',
};

/**
 * Point `runtimeFor` somewhere else - the host router once remote hosts
 * exist, a recording runtime in a test. Returns the restore.
 */
export function setRuntimeResolver(
  next: (path: string | null | undefined) => HostRuntime,
): () => void {
  const previous = resolver;
  resolver = next;
  return () => {
    resolver = previous;
  };
}
