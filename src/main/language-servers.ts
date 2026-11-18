import { ipcMain, type WebContents } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
// The subpath goes through vscode-jsonrpc's `exports` map (9+): `./node` only,
// never the old `node.js` file path, which the map no longer exposes.
import type { StreamMessageWriter } from 'vscode-jsonrpc/node';

import { isTrustedSender } from './ipc-util';
import { findOnPath, resolveUserPath } from './user-path';
import { setEnvPath } from './env-path';
import { installHintFor, LANGUAGE_REGISTRY, registryEntry } from './language-registry';
import {
  getInstalled,
  getInstalledOnHost,
  installServer,
  installServerOnHost,
  isInstalling,
  isInstallingOnHost,
  removeServer,
  removeServerOnHost,
  resolveServerCommand,
  type HostLspTarget,
  type InstallProgress,
} from './language-server-install';
import {
  MAX_LSP_MESSAGE_BYTES,
  lspEventOf,
  type LspOpenResult,
  type LspOpenArgs,
} from './daemon/protocol';

/**
 * Language-server process manager. One server per (window × machine ×
 * language × project root), spoken to with LSP JSON-RPC. Main stays a dumb
 * validated pipe: it forwards parsed JSON messages to the renderer over
 * `lsp:message` - the entire protocol (initialize handshake, ids,
 * capabilities) lives in the renderer's MonacoLanguageClient.
 *
 * A local server is spawned here over stdio, framed by vscode-jsonrpc's
 * stream reader / writer. A server for a root on a remote host runs ON the
 * host (a private plan › 4.2): `lspOpen` on its
 * daemon, `lsp:send` → `lspSend`, the host's `lsp-message` → `lsp:message` -
 * never a local spawn for a host root, whatever is installed here. One server
 * per window there too (user decision U6): each window's client runs its own
 * `initialize`, so servers are never shared.
 *
 * Lifecycle: `lsp:start` refcounts an existing server for the same key;
 * `lsp:stop` decrements and arms an idle kill (closing the last .py tab and
 * reopening it two seconds later must not cold-start pyright). Window close /
 * reload disposes everything the window owned (same contract as the fs/git
 * watchers). Local lookup order: installed-into-userData (pinned versions,
 * see language-server-install.ts) first, then the user's PATH; a host's:
 * its install under `~/.double0/language-servers/`, then its login PATH.
 *
 * The `ls:*` channels are the install/registry surface for the Settings →
 * Languages section and the editor's install banner, per machine.
 */

/** Notifications not worth an IPC hop: log/telemetry chatter. */
const DROPPED_METHODS = new Set(['window/logMessage', 'telemetry/event', '$/logTrace']);

const IDLE_KILL_MS = 60_000;
const MAX_RESTARTS = 3;

/**
 * How long a server must have run before a crash is treated as a one-off
 * rather than part of a crash loop. A server that dies after doing real work
 * for a while has proven it can start, so its budget resets; only repeated
 * fast failures burn through it.
 */
const HEALTHY_RUN_MS = 30_000;

/** The host side of the module (index.ts builds it over `RemoteHosts`). */
export type LanguageServerHosts = {
  /** The remote host a path lives on, null = this machine. */
  hostOf(path: string): string | null;
  /** A known host's target, null for a host this machine does not know. */
  target(hostId: string): HostLspTarget | null;
};

type Managed = {
  id: string;
  key: string;
  wcId: number;
  language: string;
  /** null = a local server. */
  hostId: string | null;
  /** One message to the server. */
  send(message: object): void;
  /** Stop the process (local: kill; remote: `lspClose`). */
  terminate(): void;
  refs: number;
  idleTimer: NodeJS.Timeout | null;
  disposed: boolean;
  /** When this server was spawned - see HEALTHY_RUN_MS. */
  startedAt: number;
  /** Event subscriptions to drop with it (a remote server's). */
  offs: Array<() => void>;
};

const byId = new Map<string, Managed>();
const byKey = new Map<string, Managed>();
/**
 * Crash budget per key: how many times this server has died on its OWN (not
 * been killed by us) without first running healthily. Cleared when the window
 * reloads, and reset by any server that survives HEALTHY_RUN_MS.
 *
 * Counting only abnormal exits is the point. This used to increment on every
 * spawn, which conflated a crash loop with ordinary use: the idle timer kills
 * an unused server after 60s, so simply opening and closing a .py file three
 * times - with a minute between - exhausted the budget and left the language
 * permanently dead until the window reloaded. A host's bridge dropping is
 * not a crash either: the renderer starts the server again once the host is
 * back.
 */
const restartCounts = new Map<string, number>();

/**
 * A server died without us killing it. Charge it to the budget unless it had
 * already been running long enough to count as healthy, in which case this is
 * an isolated crash and the budget resets.
 */
function noteAbnormalExit(managed: Managed): void {
  if (Date.now() - managed.startedAt >= HEALTHY_RUN_MS) {
    restartCounts.delete(managed.key);
    return;
  }
  restartCounts.set(managed.key, (restartCounts.get(managed.key) ?? 0) + 1);
}
let nextId = 1;

let hosts: LanguageServerHosts | null = null;

/** `${wcId}::${hostId ?? 'local'}::${language}::${root}` (plan 29 spec › 4.2). */
export function languageServerKey(
  wcId: number,
  hostId: string | null,
  language: string,
  root: string,
): string {
  return `${wcId}::${hostId ?? 'local'}::${language}::${root}`;
}

function kill(managed: Managed): void {
  if (managed.disposed) return;
  managed.disposed = true;
  if (managed.idleTimer) clearTimeout(managed.idleTimer);
  byId.delete(managed.id);
  byKey.delete(managed.key);
  for (const off of managed.offs) off();
  managed.offs = [];
  try {
    managed.terminate();
  } catch {
    // already gone
  }
}

/** Kill running servers for one language on one machine (uninstall flow). */
function killServersForLanguage(languageId: string, hostId: string | null): void {
  for (const managed of [...byId.values()]) {
    if (managed.language === languageId && managed.hostId === hostId) kill(managed);
  }
}

type StartResult = { serverId?: string; error?: string; code?: string };

/** An existing server for `key`, its refcount taken; null when there is none. */
function reuse(key: string): StartResult | null {
  const existing = byKey.get(key);
  if (!existing || existing.disposed) return null;
  existing.refs++;
  if (existing.idleTimer) {
    clearTimeout(existing.idleTimer);
    existing.idleTimer = null;
  }
  return { serverId: existing.id };
}

function register(managed: Managed): void {
  byId.set(managed.id, managed);
  byKey.set(managed.key, managed);
}

async function start(sender: WebContents, language: string, root: string): Promise<StartResult> {
  const hostId = hosts?.hostOf(root) ?? null;
  const key = languageServerKey(sender.id, hostId, language, root);
  const reused = reuse(key);
  if (reused) return reused;
  if ((restartCounts.get(key) ?? 0) >= MAX_RESTARTS) {
    return { error: 'Server restarted too often', code: 'RESTART_LIMIT' };
  }
  // A host root's server runs on the host, never here (plan 29 spec › 4.2).
  if (hostId) return startRemote(sender, hostId, language, root, key);
  return startLocal(sender, language, root, key);
}

async function startLocal(
  sender: WebContents,
  language: string,
  root: string,
  key: string,
): Promise<StartResult> {
  const command = await resolveServerCommand(language);
  if (!command) return { error: `No server available for '${language}'`, code: 'NOT_FOUND' };

  const env = setEnvPath<Record<string, string | undefined>>(
    { ...process.env },
    await resolveUserPath(),
  );
  // Never leak Electron launch context into a plain tool process…
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  // …except when the "tool" is an installed JS server that runs on Electron's
  // own Node (that's how installs need no user Node at all).
  if (command.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';

  // Loaded on the first server start rather than with main at every launch;
  // before the spawn, so nothing awaits between it and the reader attaching.
  const { StreamMessageReader, StreamMessageWriter } = await import('vscode-jsonrpc/node');
  // Started meanwhile by a second `lsp:start` for the same key.
  const raced = reuse(key);
  if (raced) return raced;

  let child: ChildProcess;
  try {
    // Array args + no shell: paths with spaces (userData, project dirs) are
    // plain argv entries, never re-parsed.
    child = spawn(command.cmd, command.args, {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (err) {
    return { error: String(err), code: 'SPAWN_FAILED' };
  }
  if (!child.stdout || !child.stdin) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    return { error: 'Server has no stdio', code: 'SPAWN_FAILED' };
  }

  const id = `lsp-${nextId++}`;
  const writer: StreamMessageWriter = new StreamMessageWriter(child.stdin);
  const managed: Managed = {
    id,
    key,
    wcId: sender.id,
    language,
    hostId: null,
    send: (message) => {
      void writer.write(message as never).catch(() => {
        // Pipe gone - exit handling tears the server down.
      });
    },
    terminate: () => child.kill(),
    refs: 1,
    idleTimer: null,
    disposed: false,
    startedAt: Date.now(),
    offs: [],
  };
  register(managed);

  const reader = new StreamMessageReader(child.stdout);
  reader.listen((message) => {
    const method = (message as { method?: string }).method;
    if (method && DROPPED_METHODS.has(method)) return;
    if (!sender.isDestroyed()) sender.send('lsp:message', { serverId: id, message });
  });
  // Every path below fires only when `disposed` is still false - i.e. the
  // server went down on its own rather than being killed by us (idle timeout,
  // uninstall, window close), which is exactly what the crash budget counts.
  const died = (code: number): void => {
    if (managed.disposed) return;
    noteAbnormalExit(managed);
    kill(managed);
    if (!sender.isDestroyed()) sender.send('lsp:exit', { serverId: id, code });
  };
  // Framing errors are terminal for the pipe - treat like an exit.
  reader.onError(() => died(-1));
  child.on('error', () => died(-1));
  child.on('exit', (code) => died(code ?? -1));

  return { serverId: id };
}

/** How a host should run a language's server: its install, else its PATH. */
async function remoteOpenArgs(
  target: HostLspTarget,
  language: string,
  root: string,
): Promise<Omit<LspOpenArgs, 'lspId'> | null> {
  const entry = registryEntry(language);
  if (!entry) return null;
  const spec = entry.server;
  if (spec.installType === 'builtin') return null;
  const base = { languageId: entry.id, args: [...spec.args], root };
  if (spec.installType === 'npm') {
    const installed = await getInstalledOnHost(target, language);
    if (installed) return { ...base, kind: 'installed', version: installed.version };
    return { ...base, kind: 'path', bin: spec.entryBin };
  }
  return { ...base, kind: 'path', bin: spec.bin };
}

async function startRemote(
  sender: WebContents,
  hostId: string,
  language: string,
  root: string,
  key: string,
): Promise<StartResult> {
  const target = hosts?.target(hostId) ?? null;
  if (!target || !target.connected()) {
    return { error: 'The host is not connected', code: 'EHOSTDOWN' };
  }
  if (!target.supports()) {
    return {
      error: `Update the runtime on ${target.label} to use language servers there`,
      code: 'UNSUPPORTED',
    };
  }
  let open: Omit<LspOpenArgs, 'lspId'> | null;
  try {
    open = await remoteOpenArgs(target, language, root);
  } catch {
    return { error: 'The host is not connected', code: 'EHOSTDOWN' };
  }
  if (!open) return { error: `No server available for '${language}'`, code: 'NOT_FOUND' };

  const lspId = randomUUID();
  let result: LspOpenResult;
  try {
    result = await target.call<LspOpenResult>('lspOpen', { ...open, lspId });
  } catch {
    // Not connected, or the reply died with the bridge - in which case the
    // host killed whatever it started with that connection (a server dies
    // with its connection), so nothing runs under this id: the renderer
    // starts again once the host is back.
    return { error: 'The host is not connected', code: 'EHOSTDOWN' };
  }
  if (!result.ok) return { error: result.error, code: result.code };
  // Started meanwhile by a second `lsp:start` for the same key: this one goes.
  const raced = reuse(key);
  if (raced) {
    void target.call('lspClose', { lspId }).catch(() => undefined);
    return raced;
  }

  const id = `lsp-${nextId++}`;
  const managed: Managed = {
    id,
    key,
    wcId: sender.id,
    language,
    hostId,
    send: (message) => {
      const text = JSON.stringify(message);
      // The host refuses a message past this; it would be dropped there anyway.
      if (Buffer.byteLength(text) > MAX_LSP_MESSAGE_BYTES) return;
      target.cast('lspSend', { lspId, message: text });
    },
    terminate: () => {
      void target.call('lspClose', { lspId }).catch(() => undefined);
    },
    refs: 1,
    idleTimer: null,
    disposed: false,
    startedAt: Date.now(),
    offs: [],
  };
  register(managed);
  managed.offs.push(
    target.onEvent((raw) => {
      const ev = lspEventOf(raw);
      if (!ev || ev.type === 'lsp-install-progress' || ev.lspId !== lspId) return;
      if (ev.type === 'lsp-message') {
        let message: unknown;
        try {
          message = JSON.parse(ev.message);
        } catch {
          return;
        }
        if (typeof message !== 'object' || message === null) return;
        const method = (message as { method?: unknown }).method;
        if (typeof method === 'string' && DROPPED_METHODS.has(method)) return;
        if (!managed.disposed && !sender.isDestroyed()) {
          sender.send('lsp:message', { serverId: id, message });
        }
        return;
      }
      // The server ended on the host (a crash, an oversize message): a crash.
      if (managed.disposed) return;
      noteAbnormalExit(managed);
      managed.terminate = () => undefined;
      kill(managed);
      if (!sender.isDestroyed()) sender.send('lsp:exit', { serverId: id, code: ev.code ?? -1 });
    }),
    // The bridge went: the host killed the server with the connection. Not a
    // crash - the renderer starts it again once the host is back.
    target.onDisconnected(() => {
      if (managed.disposed) return;
      managed.terminate = () => undefined;
      kill(managed);
      if (!sender.isDestroyed()) sender.send('lsp:exit', { serverId: id, code: -1 });
    }),
  );
  return { serverId: id };
}

/** Kill every server a window owns - window close and real navigations
 * (reload), same contract as disposeFsWatchersForWindow. */
export function disposeLanguageServersForWindow(wcId: number): void {
  for (const managed of [...byId.values()]) {
    if (managed.wcId === wcId) kill(managed);
  }
  for (const key of [...restartCounts.keys()]) {
    if (key.startsWith(`${wcId}::`)) restartCounts.delete(key);
  }
}

/** Renderer-facing status of one registry language (Settings + banner). */
export type LanguageServerStatus = {
  id: string;
  name: string;
  extensions: string[];
  status: 'builtin' | 'installed' | 'on-path' | 'installing' | 'available' | 'missing-tool';
  /** Installed version (status 'installed'). */
  version?: string;
  /** Resolved binary (status 'on-path'). */
  path?: string;
  /** Registry-pinned version an 'installed' server can update to. */
  updateTo?: string;
  /** How to get the tool (status 'missing-tool'). */
  installHint?: string;
  /** Rough download size (installable servers). */
  approxMb?: number;
};

async function listStatuses(): Promise<LanguageServerStatus[]> {
  return Promise.all(
    LANGUAGE_REGISTRY.map(async (entry): Promise<LanguageServerStatus> => {
      const base = { id: entry.id, name: entry.name, extensions: entry.extensions };
      const spec = entry.server;
      if (spec.installType === 'builtin') return { ...base, status: 'builtin' };
      if (spec.installType === 'npm') {
        if (isInstalling(entry.id)) return { ...base, status: 'installing' };
        const installed = await getInstalled(entry.id);
        if (installed) {
          return {
            ...base,
            status: 'installed',
            version: installed.version,
            updateTo: installed.version === spec.version ? undefined : spec.version,
          };
        }
        const onPath = await findOnPath(spec.entryBin);
        if (onPath) return { ...base, status: 'on-path', path: onPath };
        return { ...base, status: 'available', approxMb: spec.approxMb };
      }
      const onPath = await findOnPath(spec.bin);
      if (onPath) return { ...base, status: 'on-path', path: onPath };
      return { ...base, status: 'missing-tool', installHint: spec.installHint };
    }),
  );
}

/** The same list for a host: its installs, its login PATH, its platform's hints. */
export async function listHostStatuses(target: HostLspTarget): Promise<LanguageServerStatus[]> {
  const runtime = target.runtime();
  const which = (bin: string): Promise<string | null> => runtime.which(bin).catch(() => null);
  return Promise.all(
    LANGUAGE_REGISTRY.map(async (entry): Promise<LanguageServerStatus> => {
      const base = { id: entry.id, name: entry.name, extensions: entry.extensions };
      const spec = entry.server;
      if (spec.installType === 'builtin') return { ...base, status: 'builtin' };
      if (spec.installType === 'npm') {
        if (isInstallingOnHost(target.hostId, entry.id)) return { ...base, status: 'installing' };
        const installed = await getInstalledOnHost(target, entry.id).catch(() => null);
        if (installed) {
          return {
            ...base,
            status: 'installed',
            version: installed.version,
            updateTo: installed.version === spec.version ? undefined : spec.version,
          };
        }
        const onPath = await which(spec.entryBin);
        if (onPath) return { ...base, status: 'on-path', path: onPath };
        return { ...base, status: 'available', approxMb: spec.approxMb };
      }
      const onPath = await which(spec.bin);
      if (onPath) return { ...base, status: 'on-path', path: onPath };
      return {
        ...base,
        status: 'missing-tool',
        installHint: installHintFor(spec, target.platform) ?? spec.installHint,
      };
    }),
  );
}

const HOST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * The machine a `ls:*` request names: `{ local: true }` for none, the host's
 * target, or an error - a malformed or option-shaped id, a host this machine
 * does not know, a host that is away or whose daemon predates `lsp`.
 */
function machineOf(
  hostId: unknown,
): { local: true } | { target: HostLspTarget } | { error: string; code: string } {
  if (hostId === undefined || hostId === null) return { local: true };
  if (typeof hostId !== 'string' || !HOST_ID_RE.test(hostId)) {
    return { error: 'Invalid host', code: 'EINVAL' };
  }
  const target = hosts?.target(hostId) ?? null;
  if (!target) return { error: 'Unknown host', code: 'EINVAL' };
  if (!target.connected()) return { error: `${target.label} is not connected`, code: 'EHOSTDOWN' };
  if (!target.supports()) {
    return {
      error: `Update the runtime on ${target.label} to use language servers there`,
      code: 'UNSUPPORTED',
    };
  }
  return { target };
}

export function registerLanguageServersIpc(deps: { hosts?: LanguageServerHosts } = {}): () => void {
  hosts = deps.hosts ?? null;

  ipcMain.handle('lsp:start', async (event, args: { language?: string; root?: string }) => {
    if (!isTrustedSender(event)) return { error: 'Untrusted sender' };
    const language = args?.language;
    const root = args?.root;
    if (typeof language !== 'string' || typeof root !== 'string' || !language || !root) {
      return { error: 'Missing language or root' };
    }
    return start(event.sender, language, root);
  });

  // Fire-and-forget sends (no reply): request/response correlation is the
  // renderer protocol's job, an invoke round-trip per message buys nothing.
  ipcMain.on('lsp:send', (event, args: { serverId?: string; message?: unknown }) => {
    if (!isTrustedSender(event)) return;
    const managed = args?.serverId ? byId.get(args.serverId) : undefined;
    if (!managed || managed.disposed || managed.wcId !== event.sender.id) return;
    if (typeof args.message !== 'object' || args.message === null) return;
    managed.send(args.message);
  });

  ipcMain.on('lsp:stop', (event, args: { serverId?: string }) => {
    if (!isTrustedSender(event)) return;
    const managed = args?.serverId ? byId.get(args.serverId) : undefined;
    if (!managed || managed.disposed || managed.wcId !== event.sender.id) return;
    // Floored: a duplicate stop (a view unmounting twice, a renderer retry)
    // must not drive the count negative, or the next start's refs++ would
    // leave a live server that nothing can ever release.
    managed.refs = Math.max(0, managed.refs - 1);
    if (managed.refs > 0) return;
    // Re-arm rather than stack: without this each extra stop left another live
    // timer holding a reference to the server.
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = setTimeout(() => kill(managed), IDLE_KILL_MS);
  });

  ipcMain.handle('ls:list', async (event, args?: { hostId?: unknown }) => {
    if (!isTrustedSender(event)) return { languages: [] as LanguageServerStatus[] };
    const machine = machineOf(args?.hostId);
    if ('error' in machine) return { error: machine.error, code: machine.code };
    if ('local' in machine) return { languages: await listStatuses() };
    try {
      return { languages: await listHostStatuses(machine.target) };
    } catch {
      return { error: `${machine.target.label} is not connected`, code: 'EHOSTDOWN' };
    }
  });

  // Install ids are validated against the static registry - the renderer never
  // supplies URLs or paths.
  ipcMain.handle('ls:install', async (event, args: { languageId?: string; hostId?: unknown }) => {
    if (!isTrustedSender(event)) return { error: 'Untrusted sender' };
    const languageId = args?.languageId;
    const sender = event.sender;
    if (
      typeof languageId !== 'string' ||
      !LANGUAGE_REGISTRY.some((e) => e.id === languageId && e.server.installType === 'npm')
    ) {
      return { error: 'Unknown language' };
    }
    const machine = machineOf(args?.hostId);
    if ('error' in machine) return { error: machine.error, code: machine.code };
    const notify = (p: InstallProgress): void => {
      if (!sender.isDestroyed()) sender.send('ls:progress', p);
    };
    try {
      if ('local' in machine) await installServer(languageId, notify);
      else await installServerOnHost(machine.target, languageId, notify);
      return { ok: true as const };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('ls:uninstall', async (event, args: { languageId?: string; hostId?: unknown }) => {
    if (!isTrustedSender(event)) return { error: 'Untrusted sender' };
    const languageId = args?.languageId;
    if (typeof languageId !== 'string' || !LANGUAGE_REGISTRY.some((e) => e.id === languageId)) {
      return { error: 'Unknown language' };
    }
    const machine = machineOf(args?.hostId);
    if ('error' in machine) return { error: machine.error, code: machine.code };
    if ('local' in machine) {
      killServersForLanguage(languageId, null);
      await removeServer(languageId);
      return { ok: true as const };
    }
    killServersForLanguage(languageId, machine.target.hostId);
    try {
      await removeServerOnHost(machine.target, languageId);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true as const };
  });

  return () => {
    ipcMain.removeHandler('lsp:start');
    ipcMain.removeAllListeners('lsp:send');
    ipcMain.removeAllListeners('lsp:stop');
    ipcMain.removeHandler('ls:list');
    ipcMain.removeHandler('ls:install');
    ipcMain.removeHandler('ls:uninstall');
    for (const managed of [...byId.values()]) kill(managed);
    hosts = null;
  };
}
