import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_BASE_FONT_SIZE,
  DEFAULT_FONT_FAMILY,
  EXPLORER_BASE_FONT_SIZE,
  SYSTEM_SANS_STACK,
  UI_FONT_FAMILIES,
  UI_FONT_SIZE,
  appFontScale,
  resolveSurfaceFontSize,
  resolveUiFontCss,
  type UiFontSettings,
} from '@renderer/lib/settings/ui-font-settings';

type Module = typeof import('@renderer/lib/settings/ui-font-settings');

/** Seed localStorage, then load a fresh module copy (the stores read at import). */
async function loadWith(entries: Record<string, unknown> = {}): Promise<Module> {
  for (const [key, value] of Object.entries(entries)) {
    window.localStorage.setItem(key, JSON.stringify(value));
  }
  vi.resetModules();
  return import('@renderer/lib/settings/ui-font-settings');
}

beforeEach(() => {
  vi.resetModules();
  document.documentElement.removeAttribute('style');
});

describe('resolveUiFontCss', () => {
  it('returns the stack for a known family', () => {
    expect(resolveUiFontCss('inter')).toContain('Inter Variable');
  });

  it('returns null for the follow-the-app sentinel', () => {
    expect(resolveUiFontCss(DEFAULT_FONT_FAMILY)).toBeNull();
  });

  it('returns null for a family that no longer exists', () => {
    expect(resolveUiFontCss('comic-sans')).toBeNull();
  });

  it('offers a non-empty CSS stack for every listed family', () => {
    for (const family of UI_FONT_FAMILIES) {
      expect(family.css, family.id).toBeTruthy();
    }
    expect(new Set(UI_FONT_FAMILIES.map((f) => f.id)).size).toBe(UI_FONT_FAMILIES.length);
  });
});

describe('the built-in app font', () => {
  // "Default" leaves `--font-sans` to the stylesheet, so the stylesheet's stack
  // is the shipped default: it must be the OS UI font (nothing bundled), and
  // the same stack the explicit "System Sans" choice uses - otherwise picking
  // System Sans on a default install would visibly change the font.
  it('is the System Sans stack in globals.css, with no bundled face in front', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/assets/globals.css'), 'utf8');
    const match = css.match(/--font-sans:\s*([^;]+);/);
    expect(match, '--font-sans in globals.css').not.toBeNull();
    const stack = match![1].replace(/\s+/g, ' ').trim();
    expect(stack).toBe(SYSTEM_SANS_STACK);
    expect(stack).not.toContain('Inter');
    expect(resolveUiFontCss('system-sans')).toBe(SYSTEM_SANS_STACK);
  });

  it('ships at 14px: a UI scale of 14/12 over the 12px design', () => {
    expect(APP_BASE_FONT_SIZE).toBe(14);
    expect(appFontScale(null)).toBe(1.167);
    expect(appFontScale(12)).toBe(1);
    expect(appFontScale(24)).toBe(2);
  });

  it('is what the explorer falls back to, since the explorer follows the app size', () => {
    expect(EXPLORER_BASE_FONT_SIZE).toBe(APP_BASE_FONT_SIZE);
  });
});

describe('resolveSurfaceFontSize - surface → app → built-in', () => {
  const app = (fontSize: number | null): UiFontSettings => ({ fontFamily: 'default', fontSize });
  const surface = (fontSize: number | null): UiFontSettings => ({
    fontFamily: 'default',
    fontSize,
  });

  it('prefers the surface size', () => {
    expect(resolveSurfaceFontSize(surface(15), app(13), EXPLORER_BASE_FONT_SIZE)).toBe(15);
  });

  it('falls back to the app size', () => {
    expect(resolveSurfaceFontSize(surface(null), app(13), EXPLORER_BASE_FONT_SIZE)).toBe(13);
  });

  it('falls back to the built-in size when neither is set', () => {
    expect(resolveSurfaceFontSize(surface(null), app(null), EXPLORER_BASE_FONT_SIZE)).toBe(
      EXPLORER_BASE_FONT_SIZE,
    );
    expect(resolveSurfaceFontSize(surface(null), app(null), 11)).toBe(11);
  });
});

describe('stored settings are sanitized', () => {
  it('defaults an unset store', async () => {
    const m = await loadWith();
    expect(m.appFontSettings.get()).toEqual({ fontFamily: 'default', fontSize: null });
  });

  it('reads a valid stored blob', async () => {
    const m = await loadWith({ 'double0-app-font': { fontFamily: 'inter', fontSize: 14 } });
    expect(m.appFontSettings.get()).toEqual({ fontFamily: 'inter', fontSize: 14 });
  });

  it('rejects an unknown family', async () => {
    const m = await loadWith({ 'double0-app-font': { fontFamily: 'papyrus', fontSize: 14 } });
    expect(m.appFontSettings.get().fontFamily).toBe(DEFAULT_FONT_FAMILY);
  });

  it('clamps a size outside the allowed range', async () => {
    const small = await loadWith({ 'double0-app-font': { fontSize: 2 } });
    expect(small.appFontSettings.get().fontSize).toBe(UI_FONT_SIZE.min);

    window.localStorage.clear();
    const big = await loadWith({ 'double0-app-font': { fontSize: 400 } });
    expect(big.appFontSettings.get().fontSize).toBe(UI_FONT_SIZE.max);
  });

  it('rounds a fractional size', async () => {
    const m = await loadWith({ 'double0-app-font': { fontSize: 13.6 } });
    expect(m.appFontSettings.get().fontSize).toBe(14);
  });

  it('treats a non-numeric size as "follow"', async () => {
    const m = await loadWith({ 'double0-app-font': { fontSize: 'large' } });
    expect(m.appFontSettings.get().fontSize).toBeNull();
  });

  it('survives corrupt JSON', async () => {
    window.localStorage.setItem('double0-app-font', '{oops');
    vi.resetModules();
    const m = (await import('@renderer/lib/settings/ui-font-settings')) as Module;
    expect(m.appFontSettings.get()).toEqual({ fontFamily: 'default', fontSize: null });
  });
});

describe('the stores are independent', () => {
  it('uses a distinct storage key per surface', async () => {
    const m = await loadWith();
    expect(m.appFontSettings.storageKey).not.toBe(m.explorerFontSettings.storageKey);
  });

  it('keeps the explorer key on the -v2 name that reset the old pinned sizes', async () => {
    const m = await loadWith();
    expect(m.explorerFontSettings.storageKey).toBe('double0-explorer-font-v2');
  });

  it('does not let a write on one surface touch another', async () => {
    const m = await loadWith();
    m.explorerFontSettings.update({ fontSize: 16 });
    expect(m.explorerFontSettings.get().fontSize).toBe(16);
    expect(m.appFontSettings.get().fontSize).toBeNull();
  });
});

describe('updating', () => {
  it('persists and notifies', async () => {
    const m = await loadWith();
    const listener = vi.fn();
    m.appFontSettings.subscribe(listener);

    m.appFontSettings.update({ fontFamily: 'inter' });

    expect(m.appFontSettings.get().fontFamily).toBe('inter');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem('double0-app-font')!)).toMatchObject({
      fontFamily: 'inter',
    });
  });

  it('sanitizes the patch', async () => {
    const m = await loadWith();
    m.appFontSettings.update({ fontSize: 999 });
    expect(m.appFontSettings.get().fontSize).toBe(UI_FONT_SIZE.max);
  });

  it('re-reads on a storage event from another window', async () => {
    const m = await loadWith();
    const listener = vi.fn();
    m.appFontSettings.subscribe(listener);

    window.localStorage.setItem(
      'double0-app-font',
      JSON.stringify({ fontFamily: 'inter', fontSize: 15 }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: 'double0-app-font' }));

    expect(m.appFontSettings.get()).toEqual({ fontFamily: 'inter', fontSize: 15 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('initAppFont - what actually lands on <html>', () => {
  const style = (): CSSStyleDeclaration => document.documentElement.style;

  it('re-points the Tailwind font variables for a chosen family', async () => {
    const m = await loadWith({ 'double0-app-font': { fontFamily: 'inter', fontSize: null } });
    m.initAppFont();
    expect(style().getPropertyValue('--font-sans')).toContain('Inter Variable');
    expect(style().getPropertyValue('--font-mono')).toContain('Inter Variable');
  });

  it('leaves the variables alone for the default family', async () => {
    const m = await loadWith();
    m.initAppFont();
    expect(style().getPropertyValue('--font-sans')).toBe('');
    expect(style().getPropertyValue('--font-mono')).toBe('');
  });

  it('sets the UI scale from the app size (the 12px design size = 1)', async () => {
    const m = await loadWith({ 'double0-app-font': { fontSize: 12 } });
    m.initAppFont();
    expect(style().getPropertyValue('--ui-font-scale')).toBe('1');
  });

  it('scales up and down around the base size', async () => {
    const up = await loadWith({ 'double0-app-font': { fontSize: 15 } });
    up.initAppFont();
    expect(style().getPropertyValue('--ui-font-scale')).toBe('1.25');

    document.documentElement.removeAttribute('style');
    window.localStorage.clear();
    const down = await loadWith({ 'double0-app-font': { fontSize: 9 } });
    down.initAppFont();
    expect(style().getPropertyValue('--ui-font-scale')).toBe('0.75');
  });

  // The built-in size is 14, not the design's 12, so a default install still
  // needs the scale written: the stylesheet's `, 1` fallback would render the
  // design size instead.
  it('writes the built-in 14px scale when no app size is chosen', async () => {
    const m = await loadWith();
    m.initAppFont();
    expect(style().getPropertyValue('--ui-font-scale')).toBe('1.167');
  });

  it('restyles the window when the setting changes afterwards', async () => {
    const m = await loadWith();
    m.initAppFont();
    m.appFontSettings.update({ fontFamily: 'inter', fontSize: 18 });
    expect(style().getPropertyValue('--font-sans')).toContain('Inter Variable');
    expect(style().getPropertyValue('--ui-font-scale')).toBe('1.5');
  });

  it('clears the family and restores the built-in scale when both go back to default', async () => {
    const m = await loadWith({ 'double0-app-font': { fontFamily: 'inter', fontSize: 16 } });
    m.initAppFont();
    m.appFontSettings.update({ fontFamily: DEFAULT_FONT_FAMILY, fontSize: null });
    expect(style().getPropertyValue('--font-sans')).toBe('');
    expect(style().getPropertyValue('--ui-font-scale')).toBe('1.167');
  });
});
