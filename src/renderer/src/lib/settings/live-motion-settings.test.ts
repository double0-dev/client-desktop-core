import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_APPLIED_EVENT } from './settings-events';

/**
 * "Animate live status": the choice reaches <html> as `data-live-motion`,
 * which globals.css reads - at window start, on a change, and when another
 * window or an import / reset changes it.
 */

const KEY = 'double0-live-motion';

async function fresh() {
  vi.resetModules();
  return import('./live-motion-settings');
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.liveMotion;
});

describe('live motion settings', () => {
  // The endless breathing cost ~30% of a core while agents worked: the
  // default pulses on change only (user decision 2026-11-05).
  it('pulses only on change by default, and says so on <html> at start', async () => {
    const store = await fresh();
    store.initLiveMotion();
    expect(store.getLiveMotionSettings()).toEqual({ motion: 'change' });
    expect(document.documentElement.dataset.liveMotion).toBe('change');
  });

  it('keeps an explicit choice of the original endless breathing', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ motion: 'always' }));
    expect((await fresh()).getLiveMotionSettings().motion).toBe('always');
  });

  it('applies and keeps a change', async () => {
    const store = await fresh();
    store.updateLiveMotionSettings({ motion: 'off' });
    expect(document.documentElement.dataset.liveMotion).toBe('off');
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ motion: 'off' });
    const again = await fresh();
    again.initLiveMotion();
    expect(again.getLiveMotionSettings().motion).toBe('off');
  });

  it('reads an unknown or hand-broken value as the default', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ motion: 'sometimes' }));
    expect((await fresh()).getLiveMotionSettings().motion).toBe('change');
    window.localStorage.setItem(KEY, '{not json');
    expect((await fresh()).getLiveMotionSettings().motion).toBe('change');
  });

  it("follows another window's change and an import or reset in this one", async () => {
    const store = await fresh();
    window.localStorage.setItem(KEY, JSON.stringify({ motion: 'off' }));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(document.documentElement.dataset.liveMotion).toBe('off');
    window.localStorage.removeItem(KEY);
    window.dispatchEvent(new Event(SETTINGS_APPLIED_EVENT));
    expect(store.getLiveMotionSettings().motion).toBe('change');
    expect(document.documentElement.dataset.liveMotion).toBe('change');
  });
});

describe('globals.css', () => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/src/assets/globals.css'), 'utf8');

  it('caps every live animation in "change" mode and stills them in "off"', () => {
    expect(css).toMatch(
      /html\[data-live-motion='change'\] \.status-dot-live,\s*html\[data-live-motion='change'\] \.status-dot-live::after,\s*html\[data-live-motion='change'\] \.live-band::after \{\s*animation-iteration-count: 3;/,
    );
    expect(css).toMatch(
      /html\[data-live-motion='off'\] \.status-dot-live,\s*html\[data-live-motion='off'\] \.live-band::after \{\s*animation: none;/,
    );
  });

  // One endless animation makes the whole window redraw every frame: a
  // waiting session left breathing kept 39% of the GPU process busy.
  it('keeps nothing breathing in the default mode, not even a waiting session', () => {
    expect(css).not.toMatch(
      /data-live-motion='change'\][^{]*\{\s*animation-iteration-count: infinite/,
    );
  });

  // The waiting-state renames are more specific than the reduced-motion
  // rules; outside a no-preference block they would turn the motion back on
  // for someone who asked for none.
  it('restarts on working → waiting only where motion is welcome', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
    const end = block.indexOf('\n}\n');
    expect(block.slice(0, end)).toContain('.status-dot-live.bg-warning::after');
    expect(block.slice(0, end)).toContain('.live-band-needs-input::after');
    expect(css.indexOf('animation-name: status-dot-core-wait')).toBeGreaterThan(
      css.indexOf('@media (prefers-reduced-motion: no-preference)'),
    );
  });
});
