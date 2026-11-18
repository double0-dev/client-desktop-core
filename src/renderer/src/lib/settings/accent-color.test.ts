import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_COLOR,
  buildAccentPalette,
  getAccentColor,
  updateAccentColor,
} from '@renderer/lib/settings/accent-color';

const HEX = /^#[0-9a-f]{6}$/;

/** HSL lightness (0-100) - enough to assert ramp ordering. */
function lightness(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return ((Math.max(r, g, b) + Math.min(r, g, b)) / 2) * 100;
}

describe('buildAccentPalette', () => {
  it('anchors the chosen color as light primary / ramp 500', () => {
    for (const preset of ACCENT_PRESETS) {
      const palette = buildAccentPalette(preset.value);
      expect(palette.light.primary).toBe(preset.value);
      expect(palette.ramp[500]).toBe(preset.value);
    }
  });

  it('produces valid hex for every derived token', () => {
    const palette = buildAccentPalette('#4f9cf7');
    for (const color of Object.values(palette.ramp)) expect(color).toMatch(HEX);
    for (const mode of [palette.light, palette.dark]) {
      for (const color of Object.values(mode)) expect(color).toMatch(HEX);
    }
  });

  it('orders the ramp light to dark like the electric ramp', () => {
    const stops = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
    for (const preset of ACCENT_PRESETS) {
      const ramp = buildAccentPalette(preset.value).ramp;
      for (let i = 1; i < stops.length; i++) {
        expect(lightness(ramp[stops[i]])).toBeLessThan(lightness(ramp[stops[i - 1]]));
      }
    }
  });

  it('approximates the design green palette for the default accent', () => {
    const palette = buildAccentPalette(DEFAULT_ACCENT_COLOR);
    // Design: dark --primary #a8c945 (L 53), dark --accent #1f2d0c (L 11).
    expect(lightness(palette.dark.primary)).toBeCloseTo(53, 0);
    expect(lightness(palette.dark.accent)).toBeCloseTo(11, 0);
    expect(palette.light.primaryForeground).toBe('#ffffff');
  });

  it('flips light-mode text to ink when the accent is too light for white', () => {
    const palette = buildAccentPalette('#e8c987');
    expect(palette.light.primaryForeground).not.toBe('#ffffff');
    expect(lightness(palette.light.primaryForeground)).toBeLessThan(20);
  });
});

describe('accent color store', () => {
  it('lowercases valid values and falls back to the default on garbage', () => {
    updateAccentColor('#ABCDEF');
    expect(getAccentColor()).toBe('#abcdef');
    updateAccentColor('rebeccapurple');
    expect(getAccentColor()).toBe(DEFAULT_ACCENT_COLOR);
  });
});

describe('project accent', () => {
  // The override is module state; re-import per test so one test's open
  // project or switch never leaks into the next.
  async function freshModule() {
    vi.resetModules();
    return import('@renderer/lib/settings/accent-color');
  }

  beforeEach(() => window.localStorage.clear());

  it("paints with the open project's color and returns to the stored accent on leaving", async () => {
    const m = await freshModule();
    m.updateAccentColor('#4f9cf7');
    const seen: string[] = [];
    m.subscribeEffectiveAccentColor((c) => seen.push(c));
    m.setProjectAccent('#E5484D');
    expect(m.getEffectiveAccentColor()).toBe('#e5484d');
    // The stored accent - what Settings › General shows - is untouched.
    expect(m.getAccentColor()).toBe('#4f9cf7');
    m.setProjectAccent(null);
    expect(m.getEffectiveAccentColor()).toBe('#4f9cf7');
    expect(seen).toEqual(['#e5484d', '#4f9cf7']);
  });

  it('keeps the stored accent for a project without a color or an invalid one', async () => {
    const m = await freshModule();
    m.setProjectAccent(null);
    expect(m.getEffectiveAccentColor()).toBe(m.DEFAULT_ACCENT_COLOR);
    m.setProjectAccent('red');
    expect(m.getEffectiveAccentColor()).toBe(m.DEFAULT_ACCENT_COLOR);
  });

  it('a stored accent change under an open project does not show until it is left', async () => {
    const m = await freshModule();
    m.setProjectAccent('#2fbfa5');
    m.updateAccentColor('#9a6ff2');
    expect(m.getEffectiveAccentColor()).toBe('#2fbfa5');
    m.setProjectAccent(null);
    expect(m.getEffectiveAccentColor()).toBe('#9a6ff2');
  });

  it('the switch turns the override off live and persists', async () => {
    const m = await freshModule();
    m.setProjectAccent('#2fbfa5');
    m.updateProjectAccentEnabled(false);
    expect(m.getEffectiveAccentColor()).toBe(m.DEFAULT_ACCENT_COLOR);
    expect(window.localStorage.getItem('double0-project-accent')).toBe('false');
    m.updateProjectAccentEnabled(true);
    expect(m.getEffectiveAccentColor()).toBe('#2fbfa5');
  });

  it('follows the switch flipped in another window', async () => {
    window.localStorage.setItem('double0-project-accent', 'false');
    const m = await freshModule();
    m.setProjectAccent('#2fbfa5');
    expect(m.getEffectiveAccentColor()).toBe(m.DEFAULT_ACCENT_COLOR);
    window.localStorage.removeItem('double0-project-accent');
    window.dispatchEvent(new StorageEvent('storage', { key: 'double0-project-accent' }));
    expect(m.getProjectAccentEnabled()).toBe(true);
    expect(m.getEffectiveAccentColor()).toBe('#2fbfa5');
  });
});
