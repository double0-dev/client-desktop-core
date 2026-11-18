import { useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';

import {
  TERMINAL_FONT_FAMILIES,
  type TerminalFontFamily,
} from '@renderer/lib/settings/terminal-settings';

/**
 * UI font settings (Settings → General / File explorer): tiny stores following the terminal/editor-settings pattern (module-level store,
 * persisted to localStorage, `storage` listener fanning changes out to other
 * windows).
 *
 * - app: one global font that replaces every UI font EXCEPT the terminal, the
 *   code editor and any surface with a font of its own (they keep theirs).
 *   Applied by re-pointing the Tailwind `--font-sans`/`--font-mono` theme
 *   variables on <html> (see `initAppFont`), so every `font-sans`/`font-mono`
 *   utility and the body font resolve to it. Its size scales every text class
 *   in the app (via `--ui-font-scale`, see globals.css) and is the base size
 *   for the File explorer. The built-ins ("Default" / "Default") are the OS UI
 *   font (globals.css `--font-sans`, nothing bundled) at `APP_BASE_FONT_SIZE`.
 * - explorer: per-surface family + size that cascades to the app font. Family
 *   `'default'` follows the app font (or the built-in fonts when no app font is
 *   set); a concrete family re-points the same variables on the surface's root
 *   only, beating the global override there. Size `null` follows the app size
 *   (or the surface's built-in size when that is unset too).
 * - an extension's own surface stores go through `createFontStore` too.
 */

export type UiFontFamily = TerminalFontFamily;

/** Sentinel family id: no override - follow the app font / built-in fonts. */
export const DEFAULT_FONT_FAMILY = 'default';

/**
 * The OS UI font: San Francisco on macOS, Segoe UI on Windows, Roboto or the
 * fontconfig sans on Linux. Mirrors the `--font-sans` default in globals.css
 * (the test keeps them equal), so "Default" and "System Sans" render the same.
 */
export const SYSTEM_SANS_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";

/** Mirrors the `--font-mono` default in globals.css (for settings previews). */
export const DEFAULT_MONO_CSS =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, monospace";

/** The curated sans choices + the same mono stacks the terminal/editor offer. */
export const UI_FONT_FAMILIES: UiFontFamily[] = [
  { id: 'inter', label: 'Inter', css: `'Inter Variable', ${SYSTEM_SANS_STACK}` },
  { id: 'system-sans', label: 'System Sans', css: SYSTEM_SANS_STACK },
  ...TERMINAL_FONT_FAMILIES,
];

export const UI_FONT_SIZE = { min: 8, max: 24, step: 1 };

/**
 * The built-in app size - what a null app `fontSize` ("Default") renders at.
 * The design is authored at 12px (`APP_FONT_SCALE_BASE`); the app ships at 14
 * (user decision 2026-09-16), so a fresh install runs at a UI scale of 14/12.
 */
export const APP_BASE_FONT_SIZE = 14;

/** Built-in sizes, used when neither the surface nor the app sets one. */
// The explorer follows the app size, so its built-in is the app's built-in.
export const EXPLORER_BASE_FONT_SIZE = APP_BASE_FONT_SIZE;

export type UiFontSettings = {
  /** Id into `UI_FONT_FAMILIES`, or `'default'` (app: built-in fonts; surfaces: app font). */
  fontFamily: string;
  /** Pixel size, or null (app: built-in sizes; surfaces: app size). */
  fontSize: number | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeFamily(value: unknown): string {
  return value === DEFAULT_FONT_FAMILY || UI_FONT_FAMILIES.some((f) => f.id === value)
    ? (value as string)
    : DEFAULT_FONT_FAMILY;
}

function sanitizeSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(Math.round(value), UI_FONT_SIZE.min, UI_FONT_SIZE.max)
    : null;
}

export function sanitizeUiFont(raw: unknown): UiFontSettings {
  const r = raw as Record<string, unknown> | null;
  return { fontFamily: sanitizeFamily(r?.fontFamily), fontSize: sanitizeSize(r?.fontSize) };
}

type FontStore<T> = {
  storageKey: string;
  get: () => T;
  update: (patch: Partial<T>) => void;
  subscribe: (listener: (settings: T) => void) => () => void;
  useValue: () => T;
};

/** One localStorage-backed store; `sanitize` defines the shape and defaults. */
export function createFontStore<T extends object>(
  storageKey: string,
  sanitize: (raw: unknown) => T,
): FontStore<T> {
  const load = (): T => {
    if (typeof window === 'undefined') return sanitize(null);
    try {
      const raw = window.localStorage.getItem(storageKey);
      return sanitize(raw ? JSON.parse(raw) : null);
    } catch {
      return sanitize(null);
    }
  };

  let settings = load();
  const listeners = new Set<(settings: T) => void>();

  // Settings edited in one window must restyle the others (torn-off sessions);
  // `storage` fires in every OTHER window on the origin.
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== storageKey) return;
      settings = load();
      for (const listener of listeners) listener(settings);
    });
  }

  const get = (): T => settings;

  const update = (patch: Partial<T>): void => {
    settings = sanitize({ ...settings, ...patch });
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(settings));
    } catch {
      // Storage failure - settings still apply for this session.
    }
    for (const listener of listeners) listener(settings);
  };

  const subscribe = (listener: (settings: T) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const useValue = (): T => useSyncExternalStore(subscribe, get);

  return { storageKey, get, update, subscribe, useValue };
}

export const appFontSettings = createFontStore<UiFontSettings>('double0-app-font', sanitizeUiFont);

// The surface keys are "-v2": the first cut of this feature stored concrete
// sizes (no null = follow-the-app-size state), so values written by it would
// silently pin every surface and dead-end the app-wide size. Fresh keys start
// those surfaces back at "App font" / "App size".
export const explorerFontSettings = createFontStore<UiFontSettings>(
  'double0-explorer-font-v2',
  sanitizeUiFont,
);

/** The family's CSS stack, or null for `'default'` (= no override). */
export function resolveUiFontCss(familyId: string): string | null {
  return UI_FONT_FAMILIES.find((f) => f.id === familyId)?.css ?? null;
}

/** A surface's effective size: its own → the app size → its built-in size. */
export function resolveSurfaceFontSize(
  surface: UiFontSettings,
  app: UiFontSettings,
  builtinSize: number,
): number {
  return surface.fontSize ?? app.fontSize ?? builtinSize;
}

/**
 * Inline declarations that re-point every font inside a surface: descendants
 * using `font-sans`/`font-mono` resolve the re-pointed variables, everything
 * else inherits `fontFamily`. Empty when the surface follows the app font.
 */
function fontOverrideVars(familyId: string): CSSProperties {
  const css = resolveUiFontCss(familyId);
  if (!css) return {};
  return { fontFamily: css, '--font-sans': css, '--font-mono': css } as CSSProperties;
}

/** Root style for the file explorer: rows inherit the size; family if overridden. */
export function useExplorerFontStyle(): CSSProperties {
  const surface = explorerFontSettings.useValue();
  const app = appFontSettings.useValue();
  return {
    fontSize: `${resolveSurfaceFontSize(surface, app, EXPLORER_BASE_FONT_SIZE)}px`,
    ...fontOverrideVars(surface.fontFamily),
  };
}

/**
 * The design's body text size - every px in the design and every text class in
 * the app is authored at this size, so it is what a UI scale of 1 means. Not
 * the shipped default: see `APP_BASE_FONT_SIZE`.
 */
const APP_FONT_SCALE_BASE = 12;

/**
 * The UI scale for an app size: `size / 12`, the built-in size when null,
 * rounded to what `--ui-font-scale` carries so JS and CSS agree.
 */
export function appFontScale(fontSize: number | null): number {
  return Math.round(((fontSize ?? APP_BASE_FONT_SIZE) / APP_FONT_SCALE_BASE) * 1000) / 1000;
}

/**
 * The live app-font scale, matching the `--ui-font-scale` CSS var. Multiply a
 * base px size by it to get the on-screen px where JS needs the scaled value -
 * e.g. a virtualized row height that must track the app font like the chrome
 * around it.
 */
export function useAppFontScale(): number {
  return appFontScale(appFontSettings.useValue().fontSize);
}

function applyAppFontToDocument(s: UiFontSettings): void {
  const css = resolveUiFontCss(s.fontFamily);
  const style = document.documentElement.style;
  if (css) {
    style.setProperty('--font-sans', css);
    style.setProperty('--font-mono', css);
  } else {
    style.removeProperty('--font-sans');
    style.removeProperty('--font-mono');
  }
  // Every text class resolves through `--ui-font-scale` (globals.css), so this
  // scales the whole UI's text; terminal/editor content is inline-styled from
  // its own settings and unaffected. Always written, even for the default size:
  // the built-in 14px is not the design's 12px, so "unset" is a scale of its
  // own (14/12), not the stylesheet's `, 1` fallback.
  style.setProperty('--ui-font-scale', String(appFontScale(s.fontSize)));
}

/**
 * Apply the stored app font to this window and keep it applied. Called once at
 * startup (before first paint) in every window, like the theme class.
 */
export function initAppFont(): void {
  applyAppFontToDocument(appFontSettings.get());
  appFontSettings.subscribe(applyAppFontToDocument);
}
