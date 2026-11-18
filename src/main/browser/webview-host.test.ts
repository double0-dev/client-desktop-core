import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from '../ipc-util';

/**
 * The preview half of the webview plumbing (core - the editor's file preview
 * uses it too), through its real handler with Electron stubbed: a file as a
 * `d0-preview:` URL, and a remote host's file read through its runtime. The
 * browser tab's IPC is Pro's (the official build).
 */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

type FakeGuest = {
  id: number;
  type: string;
  hostWebContents: { id: number } | null;
  isDestroyed: () => boolean;
  getType: () => string;
  getURL: () => string;
  executeJavaScript: ReturnType<typeof vi.fn>;
  capturePage: ReturnType<typeof vi.fn>;
  enableDeviceEmulation: ReturnType<typeof vi.fn>;
  disableDeviceEmulation: ReturnType<typeof vi.fn>;
  setZoomFactor: ReturnType<typeof vi.fn>;
  isDevToolsOpened: () => boolean;
  openDevTools: ReturnType<typeof vi.fn>;
  closeDevTools: ReturnType<typeof vi.fn>;
  session: { fetch: ReturnType<typeof vi.fn> };
};
const guests = new Map<number, FakeGuest>();

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  net: { fetch: vi.fn() },
  session: {
    fromPartition: () => ({ clearStorageData: vi.fn(), clearCache: vi.fn() }),
  },
  webContents: { fromId: (id: number) => guests.get(id) ?? null },
}));

const { registerPreviewIpc } = await import('./webview-host');
registerPreviewIpc();

const event = (id: number) => {
  const mainFrame = { url: `${APP_ORIGIN}/index.html` };
  return { senderFrame: mainFrame, sender: { mainFrame, id } };
};
const invoke = async <T = unknown>(channel: string, payload: unknown, from = 1): Promise<T> =>
  (await handlers.get(channel)!(event(from), payload)) as T;

describe('browser:previewUrl', () => {
  const root = mkdtempSync(join(tmpdir(), 'double0-preview-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'index.html'), '<p>hi</p>');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('mints a URL for a file inside an existing folder', async () => {
    const url = await invoke<string>('browser:previewUrl', {
      root,
      file: join(root, 'docs', 'index.html'),
    });
    expect(url).toMatch(/^d0-preview:\/\/[0-9a-f]+\/docs\/index\.html$/);
  });

  it('refuses a file outside it or a folder that does not exist', async () => {
    expect(await invoke('browser:previewUrl', { root, file: '/etc/passwd' })).toBeNull();
    expect(
      await invoke('browser:previewUrl', {
        root: join(root, 'nope'),
        file: join(root, 'nope', 'a'),
      }),
    ).toBeNull();
  });
});

describe("previews of a remote host's files (plan 29 spec › 7.5)", async () => {
  const { setRuntimeResolver, createLocalRuntime } = await import('../host-runtime');
  const { previewHostOf, readHostPreview } = await import('./webview-host');
  const fsp = await import('node:fs/promises');
  const { symlinkSync } = await import('node:fs');
  // The "host": a folder here, reached only through a runtime that says it
  // is h1's - what the handler sees for a remote project.
  const hostDir = mkdtempSync(join(tmpdir(), 'double0-hostpreview-'));
  mkdirSync(join(hostDir, 'site'));
  writeFileSync(join(hostDir, 'site', 'index.html'), '<p>from build-box</p>');
  writeFileSync(join(hostDir, 'secret.txt'), 'not yours');
  symlinkSync(join(hostDir, 'secret.txt'), join(hostDir, 'site', 'escape.html'));
  const reads: string[] = [];
  const local = createLocalRuntime();
  const hostRuntime = {
    ...local,
    remote: { hostId: 'h1' },
    realpath: (p: string) => fsp.realpath(p),
    fs: {
      ...local.fs,
      stat: (p: string) => fsp.stat(p),
      readFile: (p: string) => {
        reads.push(p);
        return fsp.readFile(p);
      },
    },
  } as unknown as ReturnType<typeof createLocalRuntime>;
  let onHost = true;
  const restore = setRuntimeResolver((p) =>
    onHost && p && p.startsWith(hostDir) ? hostRuntime : local,
  );
  afterAll(() => {
    restore();
    rmSync(hostDir, { recursive: true, force: true });
  });

  it("mints a token that records the host, and serves the file through the host's files", async () => {
    const url = await invoke<string>('browser:previewUrl', {
      root: join(hostDir, 'site'),
      file: join(hostDir, 'site', 'index.html'),
    });
    expect(url).toMatch(/^d0-preview:\/\/[0-9a-f]+\/index\.html$/);
    expect(previewHostOf(url)).toBe('h1');
    const file = await readHostPreview(
      'h1',
      join(hostDir, 'site'),
      join(hostDir, 'site', 'index.html'),
    );
    expect(file?.body.toString()).toBe('<p>from build-box</p>');
    expect(file?.type).toBe('text/html; charset=utf-8');
    expect(reads.at(-1)).toContain('index.html');
  });

  it('refuses a link out of the folder (checked on the host) and the folder itself', async () => {
    const root = join(hostDir, 'site');
    expect(await readHostPreview('h1', root, join(root, 'escape.html'))).toBeNull();
    expect(await readHostPreview('h1', root, root)).toBeNull();
  });

  it('serves nothing once the folder no longer resolves to that host', async () => {
    const root = join(hostDir, 'site');
    expect(await readHostPreview('h2', root, join(root, 'index.html'))).toBeNull();
    onHost = false;
    try {
      expect(await readHostPreview('h1', root, join(root, 'index.html'))).toBeNull();
    } finally {
      onHost = true;
    }
  });
});
