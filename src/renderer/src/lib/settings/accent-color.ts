import { useSyncExternalStore } from 'react';

/**
 * App accent color (Settings → General): one hex value that recolors every
 * primary-green surface - buttons, links, focus rings, selected states, the
 * logo - by re-deriving the design system's green tokens from it.
 *
 * The palette in globals.css derives everything green from `--primary`,
 * `--primary-hover`, `--primary-foreground`, `--accent`, `--accent-foreground`,
 * `--ring` (per mode) and the mode-independent `--electric-*` ramp. Instead of
 * inline vars on <html> (which couldn't differ between light and dark), the
 * override is a <style> tag with `:root:not(.dark)` / `:root.dark` blocks -
 * higher specificity than the globals.css `:root` / `.dark` rules, so it wins
 * in both modes and keeps working when the theme is toggled. At the default
 * green the tag is removed entirely, leaving the hand-tuned design palette
 * pixel-exact.
 *
 * Derived shades follow the electric ramp's lightness ladder, anchored at the
 * chosen color (= the light-mode `--primary`, stop 500), so any hue produces
 * the same relationships the green design has: dark-mode primary is the 400
 * stop, hovers move one stop, tinted backgrounds are the ramp ends.
 *
 * Store shape follows terminal/editor/ui-font-settings: module-level value,
 * persisted to localStorage, `storage` listener fanning changes out to other
 * windows (torn-off sessions), `useSyncExternalStore` hook for React.
 */

const STORAGE_KEY = 'double0-accent-color';

/** The design's green (electric-500 = light-mode `--primary`). */
export const DEFAULT_ACCENT_COLOR = '#7da82f';

/** Preset swatches from the design (Screen/Settings → sec-accent). */
export const ACCENT_PRESETS: { id: string; label: string; value: string }[] = [
  { id: 'moss', label: 'Moss (default)', value: DEFAULT_ACCENT_COLOR },
  { id: 'blue', label: 'Blue', value: '#4f9cf7' },
  { id: 'violet', label: 'Violet', value: '#9a6ff2' },
  { id: 'teal', label: 'Teal', value: '#2fbfa5' },
  { id: 'amber', label: 'Amber', value: '#e0a63c' },
  { id: 'red', label: 'Red', value: '#e5484d' },
];

/**
 * The same swatches offered as project colors (Settings › Projects, the project
 * dialogs). There "no color" is the default - a project follows the accent -
 * so the moss loses its "(default)".
 */
export const PROJECT_COLOR_PRESETS = ACCENT_PRESETS.map((preset) =>
  preset.id === 'moss' ? { ...preset, label: 'Moss' } : preset,
);

const HEX_RE = /^#[0-9a-f]{6}$/i;

function sanitizeAccentColor(raw: unknown): string {
  return typeof raw === 'string' && HEX_RE.test(raw) ? raw.toLowerCase() : DEFAULT_ACCENT_COLOR;
}

// --- Store -----------------------------------------------------------------------

function load(): string {
  if (typeof window === 'undefined') return DEFAULT_ACCENT_COLOR;
  try {
    return sanitizeAccentColor(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_ACCENT_COLOR;
  }
}

let accentColor = load();
const listeners = new Set<(color: string) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    accentColor = load();
    for (const listener of listeners) listener(accentColor);
  });
}

export function getAccentColor(): string {
  return accentColor;
}

export function updateAccentColor(color: string): void {
  accentColor = sanitizeAccentColor(color);
  try {
    window.localStorage.setItem(STORAGE_KEY, accentColor);
  } catch {
    // Storage failure - the color still applies for this session.
  }
  for (const listener of listeners) listener(accentColor);
}

export function subscribeAccentColor(listener: (color: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAccentColor(): string {
  return useSyncExternalStore(subscribeAccentColor, getAccentColor);
}

// --- Project accent ------------------------------------------------------------------
//
// While a project with a color of its own is open, that color is the accent
// (a private plan): the window that shows the project sets it
// as an override over the stored accent and clears it on leaving. The stored
// accent above stays what Settings › General shows and edits. Settings ›
// Projects can switch the override off (`double0-project-accent`, CARRIED).

const PROJECT_ACCENT_KEY = 'double0-project-accent';

function loadProjectAccentEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(PROJECT_ACCENT_KEY) !== 'false';
  } catch {
    return true;
  }
}

let projectAccentEnabled = loadProjectAccentEnabled();
let projectAccent: string | null = null;
const projectAccentListeners = new Set<(enabled: boolean) => void>();
const effectiveListeners = new Set<(color: string) => void>();

/** The accent this window paints with: the open project's color, else the stored one. */
export function getEffectiveAccentColor(): string {
  return projectAccentEnabled && projectAccent ? projectAccent : accentColor;
}

let lastEffective = getEffectiveAccentColor();

function notifyEffective(): void {
  const next = getEffectiveAccentColor();
  if (next === lastEffective) return;
  lastEffective = next;
  for (const listener of effectiveListeners) listener(next);
}

subscribeAccentColor(notifyEffective);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== PROJECT_ACCENT_KEY) return;
    projectAccentEnabled = loadProjectAccentEnabled();
    for (const listener of projectAccentListeners) listener(projectAccentEnabled);
    notifyEffective();
  });
}

/** Paint this window with a project's color (null = back to the stored accent). */
export function setProjectAccent(color: string | null): void {
  projectAccent = color && HEX_RE.test(color) ? color.toLowerCase() : null;
  notifyEffective();
}

export function subscribeEffectiveAccentColor(listener: (color: string) => void): () => void {
  effectiveListeners.add(listener);
  return () => effectiveListeners.delete(listener);
}

export function getProjectAccentEnabled(): boolean {
  return projectAccentEnabled;
}

export function updateProjectAccentEnabled(enabled: boolean): void {
  projectAccentEnabled = enabled;
  try {
    window.localStorage.setItem(PROJECT_ACCENT_KEY, String(enabled));
  } catch {
    // Storage failure - the switch still applies for this session.
  }
  for (const listener of projectAccentListeners) listener(projectAccentEnabled);
  notifyEffective();
}

export function subscribeProjectAccentEnabled(listener: (enabled: boolean) => void): () => void {
  projectAccentListeners.add(listener);
  return () => projectAccentListeners.delete(listener);
}

export function useProjectAccentEnabled(): boolean {
  return useSyncExternalStore(subscribeProjectAccentEnabled, getProjectAccentEnabled);
}

// --- Palette derivation ------------------------------------------------------------

type Hsl = { h: number; s: number; l: number };

function hexToHsl(hex: string): Hsl {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = d / (l > 0.5 ? 2 - max - min : max + min);
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

function hslToHex({ h, s, l }: Hsl): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const channel = (n: number): string => {
    const c = ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/**
 * Lightness ladder, calibrated on the electric ramp (base #7da82f, L 42):
 * lighter stops interpolate from the base toward the tint ceiling, darker
 * stops toward the shade floor, so any base lightness yields a full ramp with
 * the design's proportions. Hue and saturation stay the base's.
 */
const TINT_CEILING = 95.5;
const SHADE_FLOOR = 8;
const TINTS = { 400: 0.21, 300: 0.3, 200: 0.585, 100: 0.81, 50: 1 } as const;
const SHADES = { 600: 0.26, 700: 0.47, 800: 0.68, 900: 0.85 } as const;
/** The near-black "ink" (dark-mode `--accent` / `--primary-foreground`, design #1f2d0c). */
const INK = 0.91;

export type AccentModeTokens = {
  primary: string;
  primaryForeground: string;
  primaryHover: string;
  accent: string;
  accentForeground: string;
};

export type AccentPalette = {
  /** electric-* replacement ramp; the base color is stop 500. */
  ramp: Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, string>;
  light: AccentModeTokens;
  dark: AccentModeTokens;
};

/** Derive the full token set from one accent hex (exported for tests). */
export function buildAccentPalette(base: string): AccentPalette {
  const { h, s, l } = hexToHsl(base);
  const tint = (t: number): string => hslToHex({ h, s, l: l + (TINT_CEILING - l) * t });
  const shade = (t: number): string => hslToHex({ h, s, l: l - (l - SHADE_FLOOR) * t });
  const ramp = {
    50: tint(TINTS[50]),
    100: tint(TINTS[100]),
    200: tint(TINTS[200]),
    300: tint(TINTS[300]),
    400: tint(TINTS[400]),
    500: base,
    600: shade(SHADES[600]),
    700: shade(SHADES[700]),
    800: shade(SHADES[800]),
    900: shade(SHADES[900]),
  };
  const ink = shade(INK);
  return {
    ramp,
    light: {
      primary: base,
      // White like the design's green, unless the accent is too light to carry it.
      primaryForeground: l > 68 ? ink : '#ffffff',
      primaryHover: ramp[600],
      accent: ramp[50],
      accentForeground: ramp[700],
    },
    dark: {
      primary: ramp[400],
      primaryForeground: ink,
      primaryHover: ramp[300],
      accent: ink,
      accentForeground: ramp[200],
    },
  };
}

// --- Live application ----------------------------------------------------------------

const STYLE_ELEMENT_ID = 'double0-accent-overrides';

function modeBlock(selector: string, tokens: AccentModeTokens): string {
  return (
    `${selector} {\n` +
    `  --primary: ${tokens.primary};\n` +
    `  --primary-foreground: ${tokens.primaryForeground};\n` +
    `  --primary-hover: ${tokens.primaryHover};\n` +
    `  --accent: ${tokens.accent};\n` +
    `  --accent-foreground: ${tokens.accentForeground};\n` +
    `  --ring: ${tokens.primary};\n` +
    `}`
  );
}

function accentCss(palette: AccentPalette): string {
  const ramp = Object.entries(palette.ramp)
    .map(([stop, color]) => `  --electric-${stop}: ${color};`)
    .join('\n');
  return [
    `html:root {\n${ramp}\n}`,
    modeBlock(':root:not(.dark)', palette.light),
    modeBlock(':root.dark', palette.dark),
  ].join('\n');
}

function applyAccentToDocument(color: string): void {
  const existing = document.getElementById(STYLE_ELEMENT_ID);
  if (color === DEFAULT_ACCENT_COLOR) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = accentCss(buildAccentPalette(color));
  if (!existing) document.head.appendChild(style);
}

/**
 * Apply the accent (the open project's, else the stored one) to this window
 * and keep it applied. Called once at startup (before first paint) in every
 * window, like the theme class and the app font.
 */
export function initAccentColor(): void {
  applyAccentToDocument(getEffectiveAccentColor());
  subscribeEffectiveAccentColor(applyAccentToDocument);
}
