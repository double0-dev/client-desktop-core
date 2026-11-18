import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';

/**
 * Settings › Sessions › After quit: the Keep-running switch, its mirror into
 * main (which owns the quit sequence) and the cross-window fan-out.
 */
beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

async function load(setKeepRunning = vi.fn(async () => {})) {
  stubApi({ sessions: { setKeepRunning, stopAll: vi.fn(async () => true) } });
  const store = await import('@renderer/lib/settings/session-daemon-settings');
  return { store, setKeepRunning };
}

describe('session daemon settings', () => {
  it('keeps sessions running by default and tells main so at boot', async () => {
    const { store, setKeepRunning } = await load();
    expect(store.getSessionDaemonSettings()).toEqual({ keepRunning: true });
    // Main starts from its own file; the window's truth reaches it at once.
    expect(setKeepRunning).toHaveBeenCalledWith(true);
  });

  it('persists a change, mirrors it into main and notifies subscribers', async () => {
    const { store, setKeepRunning } = await load();
    const seen: boolean[] = [];
    store.subscribeSessionDaemonSettings((s) => seen.push(s.keepRunning));
    store.updateSessionDaemonSettings({ keepRunning: false });
    expect(store.getSessionDaemonSettings().keepRunning).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(store.SESSION_DAEMON_SETTINGS_KEY)!)).toEqual({
      keepRunning: false,
    });
    expect(setKeepRunning).toHaveBeenLastCalledWith(false);
    expect(seen).toEqual([false]);
  });

  it('reads a stored choice back and ignores a malformed one', async () => {
    window.localStorage.setItem('double0-session-daemon', JSON.stringify({ keepRunning: false }));
    const first = await load();
    expect(first.store.getSessionDaemonSettings().keepRunning).toBe(false);
    window.localStorage.setItem('double0-session-daemon', '{"keepRunning":"later"}');
    vi.resetModules();
    const second = await load();
    expect(second.store.getSessionDaemonSettings().keepRunning).toBe(true);
  });

  it("follows another window's write through the storage event, main included", async () => {
    const { store, setKeepRunning } = await load();
    setKeepRunning.mockClear();
    window.localStorage.setItem(
      store.SESSION_DAEMON_SETTINGS_KEY,
      JSON.stringify({ keepRunning: false }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: store.SESSION_DAEMON_SETTINGS_KEY }));
    expect(store.getSessionDaemonSettings().keepRunning).toBe(false);
    expect(setKeepRunning).toHaveBeenCalledWith(false);
  });
});
