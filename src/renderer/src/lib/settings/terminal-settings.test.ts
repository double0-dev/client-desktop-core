import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_SETTINGS,
  parseStoredTerminalSettings,
  PREBUILT_TERMINAL_THEMES,
  resolveTerminalTheme,
} from '@renderer/lib/settings/terminal-settings';

const bg = (id: string): string | undefined =>
  PREBUILT_TERMINAL_THEMES.find((t) => t.id === id)?.theme.background;

describe('resolveTerminalTheme - auto follows the app appearance', () => {
  it('defaults to the adaptive "auto" theme', () => {
    expect(DEFAULT_TERMINAL_SETTINGS.themeId).toBe('auto');
  });

  it('resolves auto to Double0 Dark in dark mode and Double0 Light in light mode', () => {
    const s = { ...DEFAULT_TERMINAL_SETTINGS, themeId: 'auto' as const };
    expect(resolveTerminalTheme(s, 'dark').background).toBe(bg('double0-dark'));
    expect(resolveTerminalTheme(s, 'light').background).toBe(bg('double0-light'));
  });

  it('keeps a fixed theme regardless of the app appearance', () => {
    const s = { ...DEFAULT_TERMINAL_SETTINGS, themeId: 'dracula' as const };
    expect(resolveTerminalTheme(s, 'dark').background).toBe(bg('dracula'));
    expect(resolveTerminalTheme(s, 'light').background).toBe(bg('dracula'));
  });

  it('rides the scrollbar slider tone off the resolved background', () => {
    const s = { ...DEFAULT_TERMINAL_SETTINGS, themeId: 'auto' as const };
    // Dark bg → light slider; light bg → dark slider.
    expect(resolveTerminalTheme(s, 'dark').scrollbarSliderBackground).toBe('#fafafa4d');
    expect(resolveTerminalTheme(s, 'light').scrollbarSliderBackground).toBe('#0a0a0a4d');
  });
});

describe('auto resolves through the per-mode choices', () => {
  it('uses the custom palette when a mode slot points at it', () => {
    const s = {
      ...DEFAULT_TERMINAL_SETTINGS,
      themeId: 'auto' as const,
      autoDark: 'custom' as const,
    };
    expect(resolveTerminalTheme(s, 'dark').background).toBe(s.custom.background);
    expect(resolveTerminalTheme(s, 'light').background).toBe(bg('double0-light'));
  });
});

describe('parseStoredTerminalSettings - legacy blob migration', () => {
  it('migrates a pre-"auto" blob pinning the old default to auto', () => {
    const raw = JSON.stringify({ themeId: 'double0-dark' });
    expect(parseStoredTerminalSettings(raw).themeId).toBe('auto');
  });

  it('migrates a legacy dark custom palette to auto with custom as the dark choice', () => {
    const raw = JSON.stringify({
      themeId: 'custom',
      custom: { ...DEFAULT_TERMINAL_SETTINGS.custom, background: '#0d0d0d' },
    });
    const s = parseStoredTerminalSettings(raw);
    expect(s.themeId).toBe('auto');
    expect(s.autoDark).toBe('custom');
    expect(s.autoLight).toBe('double0-light');
    // Native mode keeps the custom look; the other mode follows the app.
    expect(resolveTerminalTheme(s, 'dark').background).toBe('#0d0d0d');
    expect(resolveTerminalTheme(s, 'light').background).toBe(bg('double0-light'));
  });

  it('migrates a legacy light custom palette to auto with custom as the light choice', () => {
    const raw = JSON.stringify({
      themeId: 'custom',
      custom: { ...DEFAULT_TERMINAL_SETTINGS.custom, background: '#f5f5f5' },
    });
    const s = parseStoredTerminalSettings(raw);
    expect(s.autoLight).toBe('custom');
    expect(s.autoDark).toBe('double0-dark');
  });

  it('keeps stamped blobs untouched (explicit picks)', () => {
    expect(
      parseStoredTerminalSettings(JSON.stringify({ themeId: 'double0-dark', v: 2 })).themeId,
    ).toBe('double0-dark');
    expect(parseStoredTerminalSettings(JSON.stringify({ themeId: 'custom', v: 2 })).themeId).toBe(
      'custom',
    );
  });

  it('leaves legacy picks of named fixed themes untouched', () => {
    expect(parseStoredTerminalSettings(JSON.stringify({ themeId: 'dracula' })).themeId).toBe(
      'dracula',
    );
  });
});

describe('the terminal engine choice', () => {
  it('defaults to xterm.js, so an existing install keeps its terminals', () => {
    expect(parseStoredTerminalSettings(JSON.stringify({ v: 2, themeId: 'auto' })).engine).toBe(
      'xterm',
    );
  });

  it('keeps a stored Ghostty choice and drops an unknown engine', () => {
    expect(parseStoredTerminalSettings(JSON.stringify({ v: 2, engine: 'ghostty' })).engine).toBe(
      'ghostty',
    );
    expect(parseStoredTerminalSettings(JSON.stringify({ v: 2, engine: 'gpu' })).engine).toBe(
      'xterm',
    );
  });
});
