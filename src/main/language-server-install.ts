import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  npmTarballs,
  orderInstalledVersions,
  registryEntry,
  tarballUrl,
} from './language-registry';
import { findOnPath } from './user-path';
import type { HostRuntime } from './host-runtime';
import type { CallOp, LspInstallResult } from './daemon/protocol';

/**
 * Downloads, verifies, and lays out npm-distributed language servers under
 * `userData/language-servers/<languageId>/<version>/` - tarballs come straight
 * from registry.npmjs.org (integrity-checked against the hashes pinned in the
 * registry), transitive deps land in a flat node_modules, and the whole
 * install commits with an atomic dir rename from a `.partial` staging dir.
 * Servers run under ELECTRON_RUN_AS_NODE, so no user Node/npm is ever needed.
 *
 * Pure library - IPC registration and process lifecycle live in
 * language-servers.ts; nothing here imports it (no cycle).
 */

export type InstalledServer = {
  version: string;
  /** Server entry script, relative to the install dir. */
  entry: string;
  dir: string;
};

export type InstallProgress = {
  languageId: string;
  /** The host the install runs on (plan 29 › M9); absent = this machine. */
  hostId?: string;
  phase: 'download' | 'done' | 'error';
  /** Packages fetched so far / total (main package + locked deps). */
  done: number;
  total: number;
  error?: string;
};

type Manifest = { package: string; version: string; entry: string };

function baseDir(): string {
  return join(app.getPath('userData'), 'language-servers');
}

export async function fetchVerified(url: string, integrity: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (integrity) {
    const [algo, expected] = integrity.split('-', 2);
    const actual = createHash(algo).update(buf).digest('base64');
    if (actual !== expected) throw new Error(`Integrity mismatch for ${url}`);
  }
  return buf;
}

async function extractTarball(buf: Buffer, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Loaded here, on an install, rather than with main at every launch.
  const tar = await import('tar');
  // npm tarballs nest everything under `package/`; strip it.
  await pipeline(Readable.from(buf), tar.x({ cwd: dir, strip: 1 }));
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as Manifest;
    return typeof parsed.entry === 'string' && typeof parsed.version === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** The usable install for a language: the registry-pinned version when
 * present, else the newest complete install (predates an app update). */
export async function getInstalled(languageId: string): Promise<InstalledServer | null> {
  const entry = registryEntry(languageId);
  if (!entry || entry.server.installType !== 'npm') return null;
  const spec = entry.server;
  const root = join(baseDir(), languageId);
  let versions: string[];
  try {
    versions = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.endsWith('.partial'))
      .map((d) => d.name);
  } catch {
    return null;
  }
  for (const version of orderInstalledVersions(versions, spec.version)) {
    const dir = join(root, version);
    const manifest = await readManifest(dir);
    if (manifest) return { version: manifest.version, entry: manifest.entry, dir };
  }
  return null;
}

const inFlight = new Map<string, Promise<void>>();

export function isInstalling(languageId: string): boolean {
  return inFlight.has(languageId);
}

export function installServer(
  languageId: string,
  onProgress: (p: InstallProgress) => void,
): Promise<void> {
  const existing = inFlight.get(languageId);
  if (existing) return existing;
  const run = doInstall(languageId, onProgress).finally(() => inFlight.delete(languageId));
  inFlight.set(languageId, run);
  return run;
}

async function doInstall(
  languageId: string,
  onProgress: (p: InstallProgress) => void,
): Promise<void> {
  const entry = registryEntry(languageId);
  if (entry?.server.installType !== 'npm') {
    onProgress({ languageId, phase: 'error', done: 0, total: 0, error: 'Not installable' });
    return;
  }
  const spec = entry.server;
  const finalDir = join(baseDir(), languageId, spec.version);
  const staging = `${finalDir}.partial`;
  const total = 1 + spec.lockedDeps.length;
  let done = 0;
  const tick = (): void => onProgress({ languageId, phase: 'download', done, total });

  try {
    await rm(staging, { recursive: true, force: true });
    tick();

    await extractTarball(
      await fetchVerified(tarballUrl(spec.package, spec.version), spec.integrity),
      staging,
    );
    done++;
    tick();

    // Flat node_modules - the tree was verified conflict-free at curation
    // time. Modest concurrency; npm's CDN shrugs this off.
    const queue = [...spec.lockedDeps];
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      for (;;) {
        const dep = queue.shift();
        if (!dep) return;
        await extractTarball(
          await fetchVerified(tarballUrl(dep.name, dep.version), dep.integrity),
          join(staging, 'node_modules', dep.name),
        );
        done++;
        tick();
      }
    });
    await Promise.all(workers);

    // The entry script comes from the package's own bin map - robust against
    // layout drift between versions; `entryBin` is just the lookup key.
    const pkg = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const binEntry =
      typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.[spec.entryBin] ?? pkg.bin?.[spec.package]);
    if (!binEntry) throw new Error(`No bin entry '${spec.entryBin}' in ${spec.package}`);

    const manifest: Manifest = { package: spec.package, version: spec.version, entry: binEntry };
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

    await rm(finalDir, { recursive: true, force: true });
    await rename(staging, finalDir);
    onProgress({ languageId, phase: 'done', done, total });
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    onProgress({ languageId, phase: 'error', done, total, error: String(err) });
    throw err;
  }
}

/** Delete a language's installs (all versions). Caller kills running servers first. */
export async function removeServer(languageId: string): Promise<void> {
  await rm(join(baseDir(), languageId), { recursive: true, force: true });
}

export type ServerCommand = {
  cmd: string;
  args: string[];
  /** Run under Electron-as-Node (installed JS servers). */
  runAsNode: boolean;
};

/** How to launch a language's server: installed copy first (deterministic,
 * pinned), then whatever is on the user's PATH. Null = nothing runnable. */
export async function resolveServerCommand(languageId: string): Promise<ServerCommand | null> {
  const entry = registryEntry(languageId);
  if (!entry) return null;
  const spec = entry.server;
  if (spec.installType === 'builtin') return null;
  if (spec.installType === 'npm') {
    const installed = await getInstalled(languageId);
    if (installed) {
      return {
        cmd: process.execPath,
        args: [join(installed.dir, installed.entry), ...spec.args],
        runAsNode: true,
      };
    }
    const onPath = await findOnPath(spec.entryBin);
    return onPath ? { cmd: onPath, args: spec.args, runAsNode: false } : null;
  }
  const onPath = await findOnPath(spec.bin);
  return onPath ? { cmd: onPath, args: spec.args, runAsNode: false } : null;
}

// --- a remote host's servers (a private plan › 4.2) ---

/**
 * What main needs of one connected host to find, install and remove its
 * language servers. Built in index.ts over the remote hosts (`RemoteHosts`);
 * tests pass a fake.
 */
export type HostLspTarget = {
  hostId: string;
  /** The host's name in the UI (`build-box`). */
  label: string;
  /** The host's platform (`linux`, `darwin`), null while unknown. */
  platform: string | null;
  /** Connected now, and its daemon announces `lsp`. */
  supports(): boolean;
  /** Connected now (whatever its daemon announces). */
  connected(): boolean;
  call<T>(op: CallOp, args: Record<string, unknown>): Promise<T>;
  /** `lspSend` to this build's daemon - false when not connected (nothing queued). */
  cast(op: 'lspSend', args: Record<string, unknown>): boolean;
  onEvent(listener: (ev: { type: string } & Record<string, unknown>) => void): () => void;
  onDisconnected(listener: () => void): () => void;
  /** `~/.double0` on the host. */
  root(): Promise<string>;
  runtime(): HostRuntime;
  /** Bytes sent ahead of the call that uses them; resolves with the transfer id. */
  putTransfer(body: Buffer): Promise<string>;
};

const hostInstalls = new Map<string, Promise<void>>();
const hostKey = (hostId: string, languageId: string): string => `${hostId}::${languageId}`;

export function isInstallingOnHost(hostId: string, languageId: string): boolean {
  return hostInstalls.has(hostKey(hostId, languageId));
}

/** The host's usable install of a language (pinned first, else newest complete). */
export async function getInstalledOnHost(
  target: HostLspTarget,
  languageId: string,
): Promise<{ version: string; entry: string } | null> {
  const entry = registryEntry(languageId);
  if (!entry || entry.server.installType !== 'npm') return null;
  const fs = target.runtime().fs;
  const base = `${(await target.root()).replace(/\/+$/, '')}/language-servers/${languageId}`;
  let versions: string[];
  try {
    const listed = (await fs.readdir(base, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
    versions = listed.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  for (const version of orderInstalledVersions(versions, entry.server.version)) {
    try {
      const parsed = JSON.parse(
        String(await fs.readFile(`${base}/${version}/manifest.json`, 'utf8')),
      ) as Partial<Manifest>;
      if (typeof parsed.entry === 'string' && typeof parsed.version === 'string') {
        return { version, entry: parsed.entry };
      }
    } catch {
      // Not a complete install.
    }
  }
  return null;
}

/** Fetch a tarball on this machine, its integrity checked here too (the relay path). */
export type TarballFetcher = (url: string, integrity: string) => Promise<Buffer>;

/**
 * Install a language's pinned server on a host: the host fetches the
 * tarballs itself; when it cannot reach the registry (ENOEGRESS) this
 * machine fetches each one (integrity checked here AND on the host), sends it
 * with `transferPut` and asks again with the transfer ids. A second click
 * while one runs joins it.
 */
export function installServerOnHost(
  target: HostLspTarget,
  languageId: string,
  onProgress: (p: InstallProgress) => void,
  fetchTarball: TarballFetcher = fetchVerified,
): Promise<void> {
  const key = hostKey(target.hostId, languageId);
  const existing = hostInstalls.get(key);
  if (existing) return existing;
  const run = doInstallOnHost(target, languageId, onProgress, fetchTarball).finally(() =>
    hostInstalls.delete(key),
  );
  hostInstalls.set(key, run);
  return run;
}

async function doInstallOnHost(
  target: HostLspTarget,
  languageId: string,
  onProgress: (p: InstallProgress) => void,
  fetchTarball: TarballFetcher,
): Promise<void> {
  const hostId = target.hostId;
  const entry = registryEntry(languageId);
  if (entry?.server.installType !== 'npm') {
    onProgress({ languageId, hostId, phase: 'error', done: 0, total: 0, error: 'Not installable' });
    throw new Error('Not installable');
  }
  const spec = entry.server;
  const tarballs = npmTarballs(spec);
  const total = tarballs.length;
  const installId = randomUUID();
  const off = target.onEvent((ev) => {
    if (ev.type !== 'lsp-install-progress' || ev.installId !== installId) return;
    const done = typeof ev.done === 'number' ? ev.done : 0;
    onProgress({ languageId, hostId, phase: 'download', done, total });
  });
  const ask = (withTransfers?: string[]): Promise<LspInstallResult> =>
    target.call<LspInstallResult>('lspInstall', {
      installId,
      languageId,
      version: spec.version,
      tarballs: tarballs.map((t, i) => ({
        name: t.name,
        url: t.url,
        integrity: t.integrity,
        ...(withTransfers ? { transferId: withTransfers[i] } : {}),
      })),
    });
  try {
    onProgress({ languageId, hostId, phase: 'download', done: 0, total });
    let result = await ask();
    if (!result.ok && result.code === 'ENOEGRESS') {
      // The host has no way out: relay every tarball from here.
      const ids: string[] = [];
      for (const t of tarballs) {
        ids.push(await target.putTransfer(await fetchTarball(t.url, t.integrity)));
      }
      result = await ask(ids);
    }
    if (!result.ok) throw new Error(result.error);
    onProgress({ languageId, hostId, phase: 'done', done: total, total });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ languageId, hostId, phase: 'error', done: 0, total, error: message });
    throw err;
  } finally {
    off();
  }
}

/** Delete a language's installs on a host (all versions). Callers stop its servers first. */
export async function removeServerOnHost(target: HostLspTarget, languageId: string): Promise<void> {
  const base = `${(await target.root()).replace(/\/+$/, '')}/language-servers/${languageId}`;
  await target.runtime().fs.rm(base, { recursive: true, force: true });
}
