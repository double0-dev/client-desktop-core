import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

/**
 * The app theme as main last heard it from a renderer (`native-theme`), kept on
 * disk so the NEXT launch can open its first window in the right colours before
 * any renderer has run: the native appearance (`nativeTheme.themeSource`) and
 * the window's `backgroundColor`, which is what shows until the page paints.
 * Dark-first like the renderer's `resolveStoredTheme` - only an explicit
 * "light" reads as light. The renderer stays the authority; this is a hint.
 */
export type ThemeHint = 'light' | 'dark';

export const THEME_HINT_FILE = 'theme-hint';

/** The renderer's `--background` per theme (globals.css `:root` / `.dark`). */
export const WINDOW_BACKGROUND: Record<ThemeHint, string> = {
  dark: '#0a0a0a',
  light: '#fafafa',
};

export function parseThemeHint(raw: string): ThemeHint {
  return raw.trim() === 'light' ? 'light' : 'dark';
}

/** Read once at startup - a missing or unreadable file is the dark default. */
export function readThemeHint(path: string): ThemeHint {
  try {
    return parseThemeHint(readFileSync(path, 'utf8'));
  } catch {
    return 'dark';
  }
}

/** Best-effort, off the main thread; a failed write only costs the next launch's hint. */
export async function writeThemeHint(path: string, theme: ThemeHint): Promise<void> {
  await writeFile(path, `${theme}\n`, 'utf8').catch(() => {});
}
