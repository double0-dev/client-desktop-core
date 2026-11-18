import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_CLEANUP_DEFAULTS,
  SESSION_CLEANUP_SETTINGS_KEY,
  durationMs,
  formatDuration,
  sanitizeSessionCleanup,
} from '@renderer/lib/settings/session-cleanup-settings';

type Module = typeof import('@renderer/lib/settings/session-cleanup-settings');

/** The store reads localStorage at import - seed, then load a fresh copy. */
async function loadWith(stored: unknown): Promise<Module> {
  if (stored !== undefined) {
    window.localStorage.setItem(SESSION_CLEANUP_SETTINGS_KEY, JSON.stringify(stored));
  }
  vi.resetModules();
  return import('@renderer/lib/settings/session-cleanup-settings');
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
  window.localStorage.clear();
});

describe('defaults', () => {
  it('archives after a week, as the app did before this was a setting, and never deletes', async () => {
    const m = await loadWith(undefined);
    expect(m.getSessionCleanupSettings()).toEqual({
      autoArchive: true,
      archiveAfter: { amount: 7, unit: 'days' },
      autoDelete: false,
      deleteAfter: { amount: 30, unit: 'days' },
      removeWorktree: true,
    });
    expect(durationMs(m.getSessionCleanupSettings().archiveAfter)).toBe(7 * DAY);
  });
});

describe('sanitizeSessionCleanup', () => {
  it('fills every missing field from the defaults', () => {
    expect(sanitizeSessionCleanup({ autoDelete: true })).toEqual({
      ...SESSION_CLEANUP_DEFAULTS,
      autoDelete: true,
    });
    expect(sanitizeSessionCleanup('garbage')).toEqual(SESSION_CLEANUP_DEFAULTS);
  });

  it('clamps the amount to a whole number from 1 to 999', () => {
    const s = (amount: unknown) =>
      sanitizeSessionCleanup({ archiveAfter: { amount, unit: 'hours' } }).archiveAfter.amount;
    expect(s(0)).toBe(1);
    expect(s(-5)).toBe(1);
    expect(s(2.6)).toBe(3);
    expect(s(5000)).toBe(999);
    // A hand-edited import with a non-number keeps the default amount.
    expect(s('12')).toBe(7);
    expect(s(Number.NaN)).toBe(7);
  });

  it('falls back to the default unit for one it does not know', () => {
    expect(
      sanitizeSessionCleanup({ deleteAfter: { amount: 2, unit: 'months' } }).deleteAfter,
    ).toEqual({ amount: 2, unit: 'days' });
  });
});

describe('durationMs / formatDuration', () => {
  it('converts each unit', () => {
    expect(durationMs({ amount: 3, unit: 'hours' })).toBe(3 * HOUR);
    expect(durationMs({ amount: 2, unit: 'days' })).toBe(2 * DAY);
    expect(durationMs({ amount: 1, unit: 'weeks' })).toBe(7 * DAY);
  });

  it('reads singular for one', () => {
    expect(formatDuration({ amount: 1, unit: 'weeks' })).toBe('1 week');
    expect(formatDuration({ amount: 30, unit: 'days' })).toBe('30 days');
  });
});

describe('store', () => {
  it('persists an update and tells subscribers', async () => {
    const m = await loadWith(undefined);
    const seen = vi.fn();
    m.subscribeSessionCleanupSettings(seen);
    m.updateSessionCleanupSettings({ autoDelete: true, deleteAfter: { amount: 2, unit: 'weeks' } });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem(SESSION_CLEANUP_SETTINGS_KEY)!)).toMatchObject({
      autoDelete: true,
      deleteAfter: { amount: 2, unit: 'weeks' },
    });
    const reloaded = await loadWith(undefined);
    expect(reloaded.getSessionCleanupSettings().deleteAfter).toEqual({ amount: 2, unit: 'weeks' });
  });

  it('picks up a change another window wrote', async () => {
    const m = await loadWith(undefined);
    window.localStorage.setItem(
      SESSION_CLEANUP_SETTINGS_KEY,
      JSON.stringify({ autoArchive: false }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_CLEANUP_SETTINGS_KEY }));
    expect(m.getSessionCleanupSettings().autoArchive).toBe(false);
  });
});
