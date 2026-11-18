import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/double0-test-user-data' } }));
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));

import {
  getInstalledOnHost,
  installServerOnHost,
  isInstallingOnHost,
  removeServerOnHost,
  type HostLspTarget,
  type InstallProgress,
} from './language-server-install';
import { npmTarballs, registryEntry, type NpmServerSpec } from './language-registry';

/**
 * A host's language servers from main's side (plan 29 spec › 4.2): finding
 * the install over the host's files, the install asked of the host, and the
 * relay from this machine when the host cannot reach the registry.
 */

type Ev = { type: string } & Record<string, unknown>;

function target(over: Partial<HostLspTarget> & { files?: Record<string, string> } = {}) {
  const files = over.files ?? {};
  const listeners = new Set<(ev: Ev) => void>();
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const transfers: Buffer[] = [];
  const rm = vi.fn(async () => undefined);
  const t: HostLspTarget = {
    hostId: 'h1',
    label: 'build-box',
    platform: 'linux',
    supports: () => true,
    connected: () => true,
    call: async <T>(op: string, args: Record<string, unknown>): Promise<T> => {
      calls.push({ op, args });
      return { ok: true } as T;
    },
    cast: () => true,
    onEvent: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onDisconnected: () => () => undefined,
    root: async () => '/home/emmaw/.double0',
    runtime: () =>
      ({
        fs: {
          readdir: async (path: string) => {
            const names = new Set<string>();
            for (const f of Object.keys(files)) {
              if (f.startsWith(`${path}/`)) names.add(f.slice(path.length + 1).split('/')[0]);
            }
            if (names.size === 0) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            return [...names].map((name) => ({ name, isDirectory: () => true }));
          },
          readFile: async (path: string) => {
            if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            return Buffer.from(files[path]);
          },
          rm,
        },
      }) as never,
    putTransfer: async (body) => {
      transfers.push(body);
      return `t-${transfers.length}`;
    },
    ...over,
  };
  return { t, calls, transfers, rm, emit: (ev: Ev) => listeners.forEach((l) => l(ev)) };
}

const BASE = '/home/emmaw/.double0/language-servers/python';

describe("a host's installs", () => {
  it('finds the pinned install first, skipping incomplete versions', async () => {
    const { t } = target({
      files: {
        [`${BASE}/1.1.411/manifest.json`]: JSON.stringify({ version: '1.1.411', entry: 'x.js' }),
        [`${BASE}/1.2.0/package.json`]: '{}',
      },
    });
    expect(await getInstalledOnHost(t, 'python')).toEqual({ version: '1.1.411', entry: 'x.js' });
    // A built-in or detect-only language has no install.
    expect(await getInstalledOnHost(t, 'go')).toBeNull();
    expect(await getInstalledOnHost(target().t, 'python')).toBeNull();
  });

  it('removes every version on the host', async () => {
    const { t, rm } = target();
    await removeServerOnHost(t, 'python');
    expect(rm).toHaveBeenCalledWith(BASE, { recursive: true, force: true });
  });
});

describe('installing on a host', () => {
  const spec = registryEntry('yaml')!.server as NpmServerSpec;

  it("asks the host to fetch the registry's pinned tarballs, passing its progress on", async () => {
    const h = target();
    h.t.call = async <T>(op: string, args: Record<string, unknown>): Promise<T> => {
      h.calls.push({ op, args });
      h.emit({ type: 'lsp-install-progress', installId: args.installId, done: 3, total: 9 });
      // Another install's progress is not this one's.
      h.emit({ type: 'lsp-install-progress', installId: 'other', done: 1, total: 1 });
      return { ok: true } as T;
    };
    const progress: InstallProgress[] = [];
    const fetchTarball = vi.fn(async () => Buffer.alloc(0));
    await installServerOnHost(h.t, 'yaml', (p) => progress.push(p), fetchTarball);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].args.tarballs).toEqual(
      npmTarballs(spec).map((x) => ({ name: x.name, url: x.url, integrity: x.integrity })),
    );
    expect(fetchTarball).not.toHaveBeenCalled();
    const total = 1 + spec.lockedDeps.length;
    expect(progress).toEqual([
      { languageId: 'yaml', hostId: 'h1', phase: 'download', done: 0, total },
      { languageId: 'yaml', hostId: 'h1', phase: 'download', done: 3, total },
      { languageId: 'yaml', hostId: 'h1', phase: 'done', done: total, total },
    ]);
  });

  /** The relay path: no egress on the host, so this machine fetches and sends. */
  it('relays every tarball from this machine when the host has no egress', async () => {
    const h = target();
    let asked = 0;
    h.t.call = async <T>(op: string, args: Record<string, unknown>): Promise<T> => {
      h.calls.push({ op, args });
      asked += 1;
      return (
        asked === 1
          ? { ok: false, error: 'This host cannot reach the npm registry.', code: 'ENOEGRESS' }
          : { ok: true }
      ) as T;
    };
    const fetchTarball = vi.fn(async (url: string) => Buffer.from(url));
    await installServerOnHost(h.t, 'yaml', () => undefined, fetchTarball);
    const tarballs = npmTarballs(spec);
    // Each fetched here with its pinned integrity (checked here, and again there).
    expect(fetchTarball.mock.calls).toEqual(tarballs.map((x) => [x.url, x.integrity]));
    expect(h.transfers.map(String)).toEqual(tarballs.map((x) => x.url));
    expect(h.calls).toHaveLength(2);
    expect(
      (h.calls[1].args.tarballs as Array<{ transferId?: string }>).map((x) => x.transferId),
    ).toEqual(tarballs.map((_, i) => `t-${i + 1}`));
  });

  it('reports a refused install as an error and lets the next try run', async () => {
    const h = target();
    h.t.call = async <T>(): Promise<T> =>
      ({
        ok: false,
        error: 'Integrity mismatch for yaml-language-server',
        code: 'EINTEGRITY',
      }) as T;
    const progress: InstallProgress[] = [];
    await expect(installServerOnHost(h.t, 'yaml', (p) => progress.push(p))).rejects.toThrow(
      /Integrity mismatch/,
    );
    expect(progress.pop()).toMatchObject({ phase: 'error', hostId: 'h1' });
    expect(isInstallingOnHost('h1', 'yaml')).toBe(false);
  });
});
