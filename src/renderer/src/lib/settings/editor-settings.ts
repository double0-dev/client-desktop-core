import { useSyncExternalStore } from 'react';

import { resolveStoredTheme, type Theme } from '@renderer/lib/settings/theme';
import { TERMINAL_FONT_FAMILIES } from '@renderer/lib/settings/terminal-settings';
import { isDarkColor } from '@renderer/lib/utils';

/**
 * Code-editor appearance settings (design: `Screen/Settings - Editor`): three
 * prebuilt color themes + a user-editable custom theme, plus font controls.
 * Mirrors `terminal-settings.ts` - a module-level store persisted to
 * localStorage, with a `storage` listener fanning changes out to other windows.
 * `monaco/monaco-theme.ts` maps the resolved palette onto the Monaco theme.
 */

export type EditorThemeId = 'auto' | 'double0-dark' | 'one-dark' | 'github-light' | 'custom';

/** The fixed palettes - everything except the adaptive "auto" and user "custom". */
export type FixedEditorThemeId = Exclude<EditorThemeId, 'auto' | 'custom'>;

/** The 8 editable syntax slots, in display order. */
export const SYNTAX_SLOTS = [
  'keyword',
  'string',
  'function',
  'type',
  'number',
  'comment',
  'property',
  'tag',
] as const;

export type SyntaxSlot = (typeof SYNTAX_SLOTS)[number];

export type CustomEditorColors = {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  /** Syntax palette in `SYNTAX_SLOTS` order. */
  syntax: string[];
};

export type EditorSettings = {
  themeId: EditorThemeId;
  custom: CustomEditorColors;
  /** Id into `EDITOR_FONT_FAMILIES`. */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
};

export type EditorPalette = {
  dark: boolean;
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  /** Operators/punctuation. Prebuilt themes pin it; custom falls back to foreground. */
  punctuation: string;
  syntax: Record<SyntaxSlot, string>;
};

export type PrebuiltEditorTheme = {
  id: FixedEditorThemeId;
  name: string;
  palette: EditorPalette;
};

export const PREBUILT_EDITOR_THEMES: PrebuiltEditorTheme[] = [
  {
    // The original hardcoded double0 theme, with
    // the previously-transparent background pinned to the dark app background.
    id: 'double0-dark',
    name: 'Double0 Dark',
    palette: {
      dark: true,
      background: '#0a0a0a',
      foreground: '#e4e4e7',
      cursor: '#a8c945',
      selection: '#262c14',
      punctuation: '#a1a1aa',
      syntax: {
        keyword: '#d4e290',
        string: '#a8c945',
        function: '#60a5fa',
        type: '#34d399',
        number: '#fbbf24',
        comment: '#52525b',
        property: '#93c5fd',
        tag: '#f87171',
      },
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    palette: {
      dark: true,
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      selection: '#3e4451',
      punctuation: '#abb2bf',
      syntax: {
        keyword: '#c678dd',
        string: '#98c379',
        function: '#61afef',
        type: '#e5c07b',
        number: '#d19a66',
        comment: '#5c6370',
        property: '#56b6c2',
        tag: '#e06c75',
      },
    },
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    palette: {
      dark: false,
      background: '#ffffff',
      foreground: '#1f2328',
      cursor: '#0969da',
      selection: '#add6ff',
      punctuation: '#57606a',
      syntax: {
        keyword: '#cf222e',
        string: '#0a3069',
        function: '#8250df',
        type: '#953800',
        number: '#0550ae',
        comment: '#6e7781',
        property: '#0550ae',
        tag: '#116329',
      },
    },
  },
];

/** Same curated mono stacks as the terminal picker. */
export const EDITOR_FONT_FAMILIES = TERMINAL_FONT_FAMILIES;

export const EDITOR_FONT_SIZE = { min: 8, max: 24, step: 1 };
export const EDITOR_LINE_HEIGHT = { min: 1, max: 2, step: 0.1 };

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  // "auto" tracks the app's light/dark appearance out of the box; in dark mode
  // it is identical to Double0 Dark, so existing dark users see no change.
  themeId: 'auto',
  custom: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selection: '#45475a',
    syntax: [
      '#cba6f7',
      '#a6e3a1',
      '#89b4fa',
      '#f9e2af',
      '#fab387',
      '#6c7086',
      '#94e2d5',
      '#f38ba8',
    ],
  },
  fontFamily: 'jetbrains-mono',
  fontSize: 12,
  lineHeight: 1.6,
};

export const EDITOR_SETTINGS_STORAGE_KEY = 'double0-editor-settings';

const HEX_RE = /^#[0-9a-f]{6}$/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeHex(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_RE.test(value) ? value.toLowerCase() : fallback;
}

/** Validate a parsed JSON blob field-by-field - a corrupt entry degrades to defaults. */
function sanitize(raw: unknown): EditorSettings {
  const d = DEFAULT_EDITOR_SETTINGS;
  if (typeof raw !== 'object' || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const themeId =
    r.themeId === 'custom' ||
    r.themeId === 'auto' ||
    PREBUILT_EDITOR_THEMES.some((t) => t.id === r.themeId)
      ? (r.themeId as EditorThemeId)
      : d.themeId;
  const rc = (typeof r.custom === 'object' && r.custom !== null ? r.custom : {}) as Record<
    string,
    unknown
  >;
  const rawSyntax = Array.isArray(rc.syntax) ? rc.syntax : [];
  return {
    themeId,
    custom: {
      background: sanitizeHex(rc.background, d.custom.background),
      foreground: sanitizeHex(rc.foreground, d.custom.foreground),
      cursor: sanitizeHex(rc.cursor, d.custom.cursor),
      selection: sanitizeHex(rc.selection, d.custom.selection),
      syntax: d.custom.syntax.map((fallback, i) => sanitizeHex(rawSyntax[i], fallback)),
    },
    fontFamily: EDITOR_FONT_FAMILIES.some((f) => f.id === r.fontFamily)
      ? (r.fontFamily as string)
      : d.fontFamily,
    fontSize:
      typeof r.fontSize === 'number' && Number.isFinite(r.fontSize)
        ? clamp(Math.round(r.fontSize), EDITOR_FONT_SIZE.min, EDITOR_FONT_SIZE.max)
        : d.fontSize,
    lineHeight:
      typeof r.lineHeight === 'number' && Number.isFinite(r.lineHeight)
        ? clamp(Math.round(r.lineHeight * 10) / 10, EDITOR_LINE_HEIGHT.min, EDITOR_LINE_HEIGHT.max)
        : d.lineHeight,
  };
}

/**
 * Storage-format version, stamped on every write since the "auto" theme
 * shipped. A stored blob WITHOUT the stamp predates "auto" - its persisted
 * 'double0-dark' is the old implicit default (saved as a side effect of
 * changing any other setting, e.g. the editor font), not a user choice, so it
 * migrates to 'auto'. Any theme picked after the stamp exists stays fixed.
 */
const STORAGE_VERSION = 2;

/** Parse + sanitize a persisted JSON string, migrating legacy blobs (exported for tests). */
export function parseStoredEditorSettings(raw: string | null): EditorSettings {
  if (!raw) return DEFAULT_EDITOR_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    const s = sanitize(parsed);
    const legacy = typeof parsed === 'object' && parsed !== null && !('v' in parsed);
    return legacy && s.themeId === 'double0-dark' ? { ...s, themeId: 'auto' } : s;
  } catch {
    return DEFAULT_EDITOR_SETTINGS;
  }
}

function load(): EditorSettings {
  if (typeof window === 'undefined') return DEFAULT_EDITOR_SETTINGS;
  return parseStoredEditorSettings(window.localStorage.getItem(EDITOR_SETTINGS_STORAGE_KEY));
}

let settings: EditorSettings = load();
const listeners = new Set<(settings: EditorSettings) => void>();

// Editors in torn-off windows must restyle when settings change in another
// window's Settings dialog; `storage` fires in every OTHER window on the origin.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== EDITOR_SETTINGS_STORAGE_KEY) return;
    settings = load();
    for (const listener of listeners) listener(settings);
  });
}

export function getEditorSettings(): EditorSettings {
  return settings;
}

export type EditorSettingsPatch = Partial<Omit<EditorSettings, 'custom'>> & {
  custom?: Partial<CustomEditorColors>;
};

export function updateEditorSettings(patch: EditorSettingsPatch): void {
  settings = sanitize({ ...settings, ...patch, custom: { ...settings.custom, ...patch.custom } });
  try {
    window.localStorage.setItem(
      EDITOR_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...settings, v: STORAGE_VERSION }),
    );
  } catch {
    // Storage failure - settings still apply for this session.
  }
  for (const listener of listeners) listener(settings);
}

export function subscribeEditorSettings(listener: (settings: EditorSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditorSettings(): EditorSettings {
  return useSyncExternalStore(
    (onStoreChange) => subscribeEditorSettings(onStoreChange),
    getEditorSettings,
  );
}

/**
 * Resolve the active settings into a full palette. `appTheme` only matters for
 * the "auto" theme, which follows the app's light/dark appearance (dark →
 * Double0 Dark, light → GitHub Light - the same pairing as the Changes diff);
 * it defaults to the persisted app theme so non-reactive callers stay correct.
 */
export function resolveEditorPalette(
  s: EditorSettings = settings,
  appTheme: Theme = resolveStoredTheme(),
): EditorPalette {
  if (s.themeId !== 'custom') {
    const id: FixedEditorThemeId =
      s.themeId === 'auto' ? (appTheme === 'light' ? 'github-light' : 'double0-dark') : s.themeId;
    const prebuilt = PREBUILT_EDITOR_THEMES.find((t) => t.id === id) ?? PREBUILT_EDITOR_THEMES[0];
    return prebuilt.palette;
  }
  const c = s.custom;
  const [keyword, string, fn, type, number, comment, property, tag] = c.syntax;
  return {
    dark: isDarkColor(c.background),
    background: c.background,
    foreground: c.foreground,
    cursor: c.cursor,
    selection: c.selection,
    punctuation: c.foreground,
    syntax: { keyword, string, function: fn, type, number, comment, property, tag },
  };
}

/**
 * Palette for the Changes diff view. Unlike the editor - which paints its own
 * background, so a dark editor theme stays legible even in the app's light mode
 * - the diff renders on the app background. So the palette must match the app's
 * light/dark mode: honour the user's editor theme when its mode matches (nice
 * consistency), otherwise fall back to a built-in palette for the app mode so
 * text never washes out (e.g. a dark editor theme on a light app background).
 */
export function resolveDiffPalette(appDark: boolean, s: EditorSettings = settings): EditorPalette {
  const p = resolveEditorPalette(s, appDark ? 'dark' : 'light');
  if (p.dark === appDark) return p;
  const fallbackId = appDark ? 'double0-dark' : 'github-light';
  return (PREBUILT_EDITOR_THEMES.find((t) => t.id === fallbackId) ?? PREBUILT_EDITOR_THEMES[0])
    .palette;
}

export function resolveEditorFontCss(s: EditorSettings = settings): string {
  return (
    EDITOR_FONT_FAMILIES.find((f) => f.id === s.fontFamily)?.css ?? EDITOR_FONT_FAMILIES[0].css
  );
}
