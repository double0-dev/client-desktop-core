import { describe, expect, it, vi } from 'vitest';
import { BROWSER_PARTITION } from './guard';

/**
 * Core's webview guard (a private plan › M5): every
 * `<webview>` a window attaches - the editor's file preview in either build,
 * a browser tab in the official one - is vetted, may open no window and
 * navigates only to browsable URLs, BEFORE anything Pro hooks in through
 * `onGuestAttached` (a tab's popups-as-tabs, its key handback, its console).
 */

const { appHandlers } = vi.hoisted(() => ({
  appHandlers: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  app: {
    on: (event: string, fn: (...args: unknown[]) => void) => appHandlers.set(event, fn),
    getPath: () => '/tmp/double0-webview-guards-test',
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  net: { fetch: vi.fn() },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      protocol: { handle: vi.fn() },
    }),
  },
  webContents: { fromId: () => null },
}));

type Handler = (...args: unknown[]) => unknown;

function fakeContents(type: string) {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    getType: () => type,
    on: (event: string, fn: Handler) => handlers.set(event, fn),
  };
}

function fakeGuest() {
  const handlers = new Map<string, Handler>();
  const order: string[] = [];
  const guest = {
    id: 42,
    handlers,
    order,
    windowOpen: null as Handler | null,
    setWindowOpenHandler: (fn: Handler) => {
      order.push('windowOpen');
      guest.windowOpen = fn;
    },
    on: (event: string, fn: Handler) => {
      order.push(event);
      handlers.set(event, fn);
    },
  };
  return guest;
}

async function installed() {
  vi.resetModules();
  appHandlers.clear();
  const host = await import('./webview-host');
  host.installBrowserGuards();
  const window = fakeContents('window');
  appHandlers.get('web-contents-created')!({}, window);
  return { host, window };
}

describe('the webview guard', () => {
  it('guards a guest before onGuestAttached listeners see it', async () => {
    const { host, window } = await installed();
    const seen: string[] = [];
    const guest = fakeGuest();
    const off = host.onGuestAttached((g, h) => {
      // The guard is already on: no window, no navigation off the web.
      seen.push(
        `attached ${String((g as unknown as { id: number }).id)} to ${h === (window as unknown) ? 'its window' : '?'}`,
      );
      seen.push(...guest.order);
    });
    window.handlers.get('did-attach-webview')!({}, guest);
    expect(seen).toEqual([
      'attached 42 to its window',
      'windowOpen',
      'will-navigate',
      'will-redirect',
    ]);
    // No page opens a window of its own.
    expect(guest.windowOpen!({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
    const prevented = vi.fn();
    guest.handlers.get('will-navigate')!({ preventDefault: prevented }, 'file:///etc/passwd');
    expect(prevented).toHaveBeenCalledTimes(1);
    guest.handlers.get('will-navigate')!({ preventDefault: prevented }, 'http://localhost:5173/');
    expect(prevented).toHaveBeenCalledTimes(1);
    off();
    window.handlers.get('did-attach-webview')!({}, fakeGuest());
    // Unsubscribed: the next guest is guarded, the listener hears nothing.
    expect(seen).toHaveLength(4);
  });

  it('refuses a webview off the browser partition before it attaches', async () => {
    const { window } = await installed();
    const prevent = vi.fn();
    window.handlers.get('will-attach-webview')!(
      { preventDefault: prevent },
      { partition: 'persist:other', sandbox: true, nodeIntegration: false },
      { partition: 'persist:other', src: 'https://example.com/' },
    );
    expect(prevent).toHaveBeenCalled();
    const allow = vi.fn();
    window.handlers.get('will-attach-webview')!(
      { preventDefault: allow },
      {
        partition: BROWSER_PARTITION,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
      { partition: BROWSER_PARTITION, src: 'about:blank' },
    );
    expect(allow).not.toHaveBeenCalled();
  });
});
