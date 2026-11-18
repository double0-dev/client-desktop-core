import { useSyncExternalStore } from 'react';
import type { ITheme } from '@xterm/xterm';

import { resolveStoredTheme, useAppTheme, type Theme } from '@renderer/lib/settings/theme';
import { isDarkColor } from '@renderer/lib/utils';

/**
 * Terminal appearance settings (design: `Screen/Settings - Terminal`): three
 * prebuilt color themes + a user-editable custom theme, plus font controls.
 *
 * Lives in a module-level store (not React state) because the consumers are
 * pooled xterm instances in `terminal-pool.ts` that outlive any component
 * mount. Persisted to localStorage like the app theme; `terminal-pool`
 * subscribes and re-applies options to every live terminal on change.
 */

export type TerminalThemeId =
  'auto' | 'double0-dark' | 'double0-light' | 'dracula' | 'solarized-light' | 'custom';

/** The fixed palettes - everything except the adaptive "auto" and user "custom". */
export type FixedTerminalThemeId = Exclude<TerminalThemeId, 'auto' | 'custom'>;

/** What "auto" resolves to per app mode - any concrete palette, incl. Custom. */
export type TerminalAutoChoice = FixedTerminalThemeId | 'custom';

/** The 8 base ANSI slots, in xterm order. */
export const ANSI_SLOTS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const;

/**
 * The engine terminals run on: xterm.js, or the Ghostty engine (ghostty-web,
 * experimental). Read when a window boots - lib/terminal/engine.ts.
 */
export type TerminalEngine = 'xterm' | 'ghostty';

export const TERMINAL_ENGINES: { id: TerminalEngine; label: string }[] = [
  { id: 'xterm', label: 'xterm.js' },
  { id: 'ghostty', label: 'Ghostty (experimental)' },
];

export type CustomTerminalColors = {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  /** Base ANSI palette in `ANSI_SLOTS` order; bright variants reuse these. */
  ansi: string[];
};

export type TerminalSettings = {
  themeId: TerminalThemeId;
  /**
   * The palettes "auto" resolves to in dark/light app mode. Defaults pair the
   * two Double0 themes; the legacy migration points the matching-mode slot at
   * 'custom' so a pre-"auto" custom palette keeps its look in its native mode
   * while the other mode follows the app.
   */
  autoDark: TerminalAutoChoice;
  autoLight: TerminalAutoChoice;
  custom: CustomTerminalColors;
  /** Id into `TERMINAL_FONT_FAMILIES`. */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** Lines of scrollback kept per terminal (memory scales with open terminals). */
  scrollback: number;
  /**
   * Mouse-wheel / trackpad scroll speed - xterm's `scrollSensitivity` multiplier.
   * 1 is xterm's slow default; higher moves more content per gesture (applies to
   * both scrollback and wheel-forwarding into full-screen TUIs like Claude Code).
   */
  scrollSpeed: number;
  /**
   * Start zsh and bash with the shell integration (main/shell-integration.ts) that
   * reports each command and its exit status to the Inputs list. Read when a
   * terminal spawns - a change reaches new terminals only.
   */
  shellIntegration: boolean;
  /** Terminal engine - applies when a window reloads (see TerminalEngine). */
  engine: TerminalEngine;
};

export type PrebuiltTerminalTheme = {
  id: FixedTerminalThemeId;
  name: string;
  theme: ITheme;
};

export const PREBUILT_TERMINAL_THEMES: PrebuiltTerminalTheme[] = [
  {
    id: 'double0-dark',
    name: 'Double0 Dark',
    theme: {
      background: '#0d0d0d',
      foreground: '#e4e4e7',
      cursor: '#a8c945',
      cursorAccent: '#0d0d0d',
      selectionBackground: '#3f3f46',
      black: '#18181b',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#facc15',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#e4e4e7',
      brightBlack: '#52525b',
      brightRed: '#fca5a5',
      brightGreen: '#86efac',
      brightYellow: '#fde047',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#fafafa',
    },
  },
  {
    // Light companion to Double0 Dark - the palette "auto" resolves to when the
    // app is in light mode. Darker ANSI values so text stays legible on white.
    id: 'double0-light',
    name: 'Double0 Light',
    theme: {
      background: '#fafafa',
      foreground: '#27272a',
      cursor: '#4d7c0f',
      cursorAccent: '#fafafa',
      selectionBackground: '#d4d4d8',
      black: '#27272a',
      red: '#dc2626',
      green: '#16a34a',
      yellow: '#ca8a04',
      blue: '#2563eb',
      magenta: '#9333ea',
      cyan: '#0891b2',
      white: '#a1a1aa',
      brightBlack: '#52525b',
      brightRed: '#ef4444',
      brightGreen: '#22c55e',
      brightYellow: '#eab308',
      brightBlue: '#3b82f6',
      brightMagenta: '#a855f7',
      brightCyan: '#06b6d4',
      brightWhite: '#3f3f46',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    theme: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#657b83',
      cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },
];

export type TerminalFontFamily = {
  id: string;
  label: string;
  css: string;
  /**
   * The local font the choice needs (`font-availability.ts`): the pickers hide
   * it where it is not installed, since it would render as the fallback.
   */
  probe?: string;
  /** Offered on Windows and Linux only; macOS keeps its original list. */
  notOnMac?: boolean;
};

const SYSTEM_MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** A local font in front of the system mono stack, listed only where installed. */
function localMono(id: string, name: string, notOnMac = false): TerminalFontFamily {
  const css = name.includes(' ') ? `"${name}"` : name;
  return {
    id,
    label: name,
    css: `${css}, ${SYSTEM_MONO_STACK}`,
    probe: name,
    ...(notOnMac ? { notOnMac } : {}),
  };
}

// On Windows and Linux every OS's fonts are listed and each machine shows the
// ones it has; macOS shows the original six unfiltered (`offeredFontFamilies`).
// Ids are never removed - a stored id that leaves the list resets to the default.
export const TERMINAL_FONT_FAMILIES: TerminalFontFamily[] = [
  { id: 'system', label: 'System mono', css: SYSTEM_MONO_STACK },
  localMono('jetbrains-mono', 'JetBrains Mono'),
  localMono('sf-mono', 'SF Mono'),
  localMono('menlo', 'Menlo'),
  localMono('monaco', 'Monaco'),
  localMono('fira-code', 'Fira Code'),
  localMono('cascadia-code', 'Cascadia Code', true),
  localMono('cascadia-mono', 'Cascadia Mono', true),
  localMono('consolas', 'Consolas', true),
  localMono('dejavu-sans-mono', 'DejaVu Sans Mono', true),
  localMono('ubuntu-mono', 'Ubuntu Mono', true),
  localMono('ubuntu-sans-mono', 'Ubuntu Sans Mono', true),
  localMono('liberation-mono', 'Liberation Mono', true),
  localMono('noto-sans-mono', 'Noto Sans Mono', true),
  localMono('noto-mono', 'Noto Mono', true),
];

export const TERMINAL_FONT_SIZE = { min: 8, max: 24, step: 1 };
export const TERMINAL_LINE_HEIGHT = { min: 1, max: 2, step: 0.1 };
export const TERMINAL_SCROLLBACK = { min: 1000, max: 50000, step: 1000 };
export const TERMINAL_SCROLL_SPEED = { min: 1, max: 5, step: 1 };

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  // "auto" tracks the app's light/dark appearance out of the box; in dark mode
  // it is identical to Double0 Dark, so existing dark users see no change.
  themeId: 'auto',
  autoDark: 'double0-dark',
  autoLight: 'double0-light',
  custom: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selection: '#45475a',
    ansi: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#cdd6f4'],
  },
  fontFamily: 'system',
  fontSize: 13,
  lineHeight: 1.2,
  scrollback: 5000,
  // Faster than xterm's default of 1 - the built-in speed feels sluggish next to
  // a native scroll container. Users can dial it back in Settings → Terminal.
  scrollSpeed: 3,
  shellIntegration: true,
  engine: 'xterm',
};

export const TERMINAL_SETTINGS_STORAGE_KEY = 'double0-terminal-settings';

const HEX_RE = /^#[0-9a-f]{6}$/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeHex(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_RE.test(value) ? value.toLowerCase() : fallback;
}

/** Validate a parsed JSON blob field-by-field - a corrupt entry degrades to defaults. */
function sanitize(raw: unknown): TerminalSettings {
  const d = DEFAULT_TERMINAL_SETTINGS;
  if (typeof raw !== 'object' || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const themeId =
    r.themeId === 'custom' ||
    r.themeId === 'auto' ||
    PREBUILT_TERMINAL_THEMES.some((t) => t.id === r.themeId)
      ? (r.themeId as TerminalThemeId)
      : d.themeId;
  const autoChoice = (value: unknown, fallback: TerminalAutoChoice): TerminalAutoChoice =>
    value === 'custom' || PREBUILT_TERMINAL_THEMES.some((t) => t.id === value)
      ? (value as TerminalAutoChoice)
      : fallback;
  const rc = (typeof r.custom === 'object' && r.custom !== null ? r.custom : {}) as Record<
    string,
    unknown
  >;
  const rawAnsi = Array.isArray(rc.ansi) ? rc.ansi : [];
  return {
    themeId,
    autoDark: autoChoice(r.autoDark, d.autoDark),
    autoLight: autoChoice(r.autoLight, d.autoLight),
    custom: {
      background: sanitizeHex(rc.background, d.custom.background),
      foreground: sanitizeHex(rc.foreground, d.custom.foreground),
      cursor: sanitizeHex(rc.cursor, d.custom.cursor),
      selection: sanitizeHex(rc.selection, d.custom.selection),
      ansi: d.custom.ansi.map((fallback, i) => sanitizeHex(rawAnsi[i], fallback)),
    },
    fontFamily: TERMINAL_FONT_FAMILIES.some((f) => f.id === r.fontFamily)
      ? (r.fontFamily as string)
      : d.fontFamily,
    fontSize:
      typeof r.fontSize === 'number' && Number.isFinite(r.fontSize)
        ? clamp(Math.round(r.fontSize), TERMINAL_FONT_SIZE.min, TERMINAL_FONT_SIZE.max)
        : d.fontSize,
    lineHeight:
      typeof r.lineHeight === 'number' && Number.isFinite(r.lineHeight)
        ? clamp(
            Math.round(r.lineHeight * 10) / 10,
            TERMINAL_LINE_HEIGHT.min,
            TERMINAL_LINE_HEIGHT.max,
          )
        : d.lineHeight,
    scrollback:
      typeof r.scrollback === 'number' && Number.isFinite(r.scrollback)
        ? clamp(Math.round(r.scrollback), TERMINAL_SCROLLBACK.min, TERMINAL_SCROLLBACK.max)
        : d.scrollback,
    scrollSpeed:
      typeof r.scrollSpeed === 'number' && Number.isFinite(r.scrollSpeed)
        ? clamp(Math.round(r.scrollSpeed), TERMINAL_SCROLL_SPEED.min, TERMINAL_SCROLL_SPEED.max)
        : d.scrollSpeed,
    shellIntegration:
      typeof r.shellIntegration === 'boolean' ? r.shellIntegration : d.shellIntegration,
    engine: TERMINAL_ENGINES.some((e) => e.id === r.engine)
      ? (r.engine as TerminalEngine)
      : d.engine,
  };
}

/**
 * Storage-format version, stamped on every write since the "auto" theme
 * shipped. A stored blob WITHOUT the stamp predates "auto" - its persisted
 * 'double0-dark' is the old implicit default (saved as a side effect of
 * changing any other setting), not a user choice, so it migrates to 'auto'.
 * Any theme picked after the stamp exists stays fixed.
 */
const STORAGE_VERSION = 2;

/** Parse + sanitize a persisted JSON string, migrating legacy blobs (exported for tests). */
export function parseStoredTerminalSettings(raw: string | null): TerminalSettings {
  if (!raw) return DEFAULT_TERMINAL_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    const s = sanitize(parsed);
    const legacy = typeof parsed === 'object' && parsed !== null && !('v' in parsed);
    if (legacy && s.themeId === 'double0-dark') return { ...s, themeId: 'auto' };
    // A legacy Custom palette becomes the "auto" choice for its own mode: its
    // look is preserved there, and the other mode now follows the app -
    // pre-"auto" users had no way to opt into following, so this is the
    // behavior they were missing, at zero visual cost.
    if (legacy && s.themeId === 'custom') {
      return isDarkColor(s.custom.background)
        ? { ...s, themeId: 'auto', autoDark: 'custom' }
        : { ...s, themeId: 'auto', autoLight: 'custom' };
    }
    return s;
  } catch {
    return DEFAULT_TERMINAL_SETTINGS;
  }
}

function load(): TerminalSettings {
  if (typeof window === 'undefined') return DEFAULT_TERMINAL_SETTINGS;
  return parseStoredTerminalSettings(window.localStorage.getItem(TERMINAL_SETTINGS_STORAGE_KEY));
}

let settings: TerminalSettings = load();
const listeners = new Set<(settings: TerminalSettings) => void>();

// Settings edited in one window (e.g. the main window's Settings dialog) must
// restyle terminals living in torn-off windows too. `storage` fires in every
// OTHER window sharing the origin, so re-load and fan out there.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== TERMINAL_SETTINGS_STORAGE_KEY) return;
    settings = load();
    for (const listener of listeners) listener(settings);
  });
}

export function getTerminalSettings(): TerminalSettings {
  return settings;
}

export type TerminalSettingsPatch = Partial<Omit<TerminalSettings, 'custom'>> & {
  custom?: Partial<CustomTerminalColors>;
};

export function updateTerminalSettings(patch: TerminalSettingsPatch): void {
  settings = sanitize({ ...settings, ...patch, custom: { ...settings.custom, ...patch.custom } });
  try {
    window.localStorage.setItem(
      TERMINAL_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...settings, v: STORAGE_VERSION }),
    );
  } catch {
    // Storage failure - settings still apply for this session.
  }
  for (const listener of listeners) listener(settings);
}

export function subscribeTerminalSettings(
  listener: (settings: TerminalSettings) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTerminalSettings(): TerminalSettings {
  return useSyncExternalStore(
    (onStoreChange) => subscribeTerminalSettings(onStoreChange),
    getTerminalSettings,
  );
}

/**
 * Resolve the active settings into a full xterm `ITheme`. `appTheme` only
 * matters for the "auto" theme, which follows the app's light/dark appearance;
 * it defaults to the persisted app theme so non-reactive callers stay correct.
 */
export function resolveTerminalTheme(
  s: TerminalSettings = settings,
  appTheme: Theme = resolveStoredTheme(),
): ITheme {
  const base = resolveBaseTerminalTheme(s, appTheme);
  // xterm 6 draws its own DOM scrollbar, so the thumb colors must ride the
  // theme - CSS can't reach them. Same values as the --scrollbar-thumb-on-*
  // tokens in globals.css, keyed by the theme background's tone.
  const onDark = isDarkColor(base.background ?? '#0d0d0d');
  return {
    ...base,
    scrollbarSliderBackground: onDark ? '#fafafa4d' : '#0a0a0a4d',
    scrollbarSliderHoverBackground: onDark ? '#fafafa73' : '#0a0a0a73',
    scrollbarSliderActiveBackground: onDark ? '#fafafa73' : '#0a0a0a73',
  };
}

function resolveBaseTerminalTheme(s: TerminalSettings, appTheme: Theme): ITheme {
  const choice: TerminalAutoChoice =
    s.themeId === 'auto' ? (appTheme === 'light' ? s.autoLight : s.autoDark) : s.themeId;
  if (choice !== 'custom') {
    const prebuilt =
      PREBUILT_TERMINAL_THEMES.find((t) => t.id === choice) ?? PREBUILT_TERMINAL_THEMES[0];
    return prebuilt.theme;
  }
  const c = s.custom;
  const [black, red, green, yellow, blue, magenta, cyan, white] = c.ansi;
  return {
    background: c.background,
    foreground: c.foreground,
    cursor: c.cursor,
    cursorAccent: c.background,
    selectionBackground: c.selection,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    // Bright variants reuse the base palette - the editor exposes 8 slots.
    brightBlack: black,
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: white,
  };
}

export function resolveTerminalFontCss(s: TerminalSettings = settings): string {
  return (
    TERMINAL_FONT_FAMILIES.find((f) => f.id === s.fontFamily)?.css ?? TERMINAL_FONT_FAMILIES[0].css
  );
}

/**
 * Reactive resolved theme for React consumers: re-renders when the terminal
 * settings change AND when the app flips light/dark (so the "auto" theme, and
 * the terminal background swatches derived from it, follow along live).
 */
export function useTerminalTheme(): ITheme {
  return resolveTerminalTheme(useTerminalSettings(), useAppTheme());
}
