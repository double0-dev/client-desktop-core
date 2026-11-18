import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_APPLIED_EVENT } from './settings-events';

/** "Scroll long names on hover": on by default, remembered, live across windows. */

const KEY = 'double0-hover-scroll';

async function fresh() {
  vi.resetModules();
  return import('./hover-scroll-settings');
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('hover scroll settings', () => {
  it('is on by default', async () => {
    expect((await fresh()).getHoverScrollSettings()).toEqual({ enabled: true });
  });

  it('remembers switching it off across a restart', async () => {
    const store = await fresh();
    const seen = vi.fn();
    store.subscribeHoverScrollSettings(seen);
    store.updateHoverScrollSettings({ enabled: false });
    expect(seen).toHaveBeenCalledWith({ enabled: false });
    expect((await fresh()).getHoverScrollSettings().enabled).toBe(false);
  });

  it('falls back to on for a stored value it cannot read', async () => {
    window.localStorage.setItem(KEY, '{"enabled":"nope"}');
    expect((await fresh()).getHoverScrollSettings().enabled).toBe(true);
    window.localStorage.setItem(KEY, 'not json');
    expect((await fresh()).getHoverScrollSettings().enabled).toBe(true);
  });

  it('follows an import or another window', async () => {
    const store = await fresh();
    window.localStorage.setItem(KEY, JSON.stringify({ enabled: false }));
    window.dispatchEvent(new Event(SETTINGS_APPLIED_EVENT));
    expect(store.getHoverScrollSettings().enabled).toBe(false);

    window.localStorage.removeItem(KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(store.getHoverScrollSettings().enabled).toBe(true);
  });
});
