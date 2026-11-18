import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EDITOR_SETTINGS,
  parseStoredEditorSettings,
  PREBUILT_EDITOR_THEMES,
  resolveDiffPalette,
  resolveEditorPalette,
} from '@renderer/lib/settings/editor-settings';

const bg = (id: string): string | undefined =>
  PREBUILT_EDITOR_THEMES.find((t) => t.id === id)?.palette.background;

describe('resolveEditorPalette - auto follows the app appearance', () => {
  it('defaults to the adaptive "auto" theme', () => {
    expect(DEFAULT_EDITOR_SETTINGS.themeId).toBe('auto');
  });

  it('resolves auto to Double0 Dark in dark mode and GitHub Light in light mode', () => {
    const s = { ...DEFAULT_EDITOR_SETTINGS, themeId: 'auto' as const };
    expect(resolveEditorPalette(s, 'dark').background).toBe(bg('double0-dark'));
    expect(resolveEditorPalette(s, 'light').background).toBe(bg('github-light'));
  });

  it('keeps a fixed theme regardless of the app appearance', () => {
    const s = { ...DEFAULT_EDITOR_SETTINGS, themeId: 'one-dark' as const };
    expect(resolveEditorPalette(s, 'dark').background).toBe(bg('one-dark'));
    expect(resolveEditorPalette(s, 'light').background).toBe(bg('one-dark'));
  });

  it('resolves the diff palette for auto against the app mode, never the fallback mismatch', () => {
    const s = { ...DEFAULT_EDITOR_SETTINGS, themeId: 'auto' as const };
    expect(resolveDiffPalette(true, s).background).toBe(bg('double0-dark'));
    expect(resolveDiffPalette(false, s).background).toBe(bg('github-light'));
  });
});

describe('parseStoredEditorSettings - legacy blob migration', () => {
  it('migrates a pre-"auto" blob pinning the old default to auto', () => {
    const raw = JSON.stringify({ themeId: 'double0-dark', fontFamily: 'fira-code' });
    const s = parseStoredEditorSettings(raw);
    expect(s.themeId).toBe('auto');
    // Migration only touches the theme - the rest of the blob survives.
    expect(s.fontFamily).toBe('fira-code');
  });

  it('keeps double0-dark when the blob carries the version stamp (explicit pick)', () => {
    const raw = JSON.stringify({ themeId: 'double0-dark', v: 2 });
    expect(parseStoredEditorSettings(raw).themeId).toBe('double0-dark');
  });

  it('leaves other legacy themes untouched', () => {
    const raw = JSON.stringify({ themeId: 'one-dark' });
    expect(parseStoredEditorSettings(raw).themeId).toBe('one-dark');
  });
});
