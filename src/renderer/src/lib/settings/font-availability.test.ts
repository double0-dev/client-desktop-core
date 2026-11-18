import { describe, expect, it, vi } from 'vitest';

import { offeredFontFamilies } from '@renderer/lib/settings/font-availability';
import { TERMINAL_FONT_FAMILIES } from '@renderer/lib/settings/terminal-settings';
import { UI_FONT_FAMILIES } from '@renderer/lib/settings/ui-font-settings';

const ids = (families: { id: string }[]) => families.map((f) => f.id);

describe('offeredFontFamilies', () => {
  // On Windows every macOS-only choice fell through to Consolas, so picking
  // SF Mono, Menlo or Monaco changed nothing on screen.
  it('hides a family whose local font a Windows machine does not have', () => {
    const windows = new Set(['Consolas', 'Cascadia Code']);
    const offered = ids(
      offeredFontFamilies(TERMINAL_FONT_FAMILIES, 'system', (f) => windows.has(f), false),
    );
    expect(offered).toEqual(['system', 'cascadia-code', 'consolas']);
  });

  // On Linux all six original choices fell through to DejaVu Sans Mono, and
  // the fonts an Ubuntu install does ship were never listed (2026-10-29).
  it('lists the fonts a Linux machine has instead of the macOS ones', () => {
    const ubuntu = new Set(['DejaVu Sans Mono', 'Ubuntu Mono', 'Ubuntu Sans Mono', 'Noto Mono']);
    const offered = ids(
      offeredFontFamilies(TERMINAL_FONT_FAMILIES, 'system', (f) => ubuntu.has(f), false),
    );
    expect(offered).toEqual([
      'system',
      'dejavu-sans-mono',
      'ubuntu-mono',
      'ubuntu-sans-mono',
      'noto-mono',
    ]);
  });

  it('keeps the selected family even when its font is missing', () => {
    // A setting imported from a Mac must stay visible, or the select would
    // silently show its first option while the stored id says otherwise.
    const offered = ids(offeredFontFamilies(TERMINAL_FONT_FAMILIES, 'menlo', () => false, false));
    expect(offered).toEqual(['system', 'menlo']);
  });

  it('always offers stacks and bundled faces', () => {
    const offered = ids(offeredFontFamilies(UI_FONT_FAMILIES, 'default', () => false, false));
    expect(offered).toEqual(['inter', 'system-sans', 'system']);
  });

  it('keeps the original list on macOS, unprobed', () => {
    // On a Mac nothing about the pickers may change: no probe (a stock Mac
    // reaches SF Mono only through `ui-monospace`, so its probe fails) and no
    // Windows / Linux families added.
    const isInstalled = vi.fn(() => false);
    const offered = ids(offeredFontFamilies(TERMINAL_FONT_FAMILIES, 'system', isInstalled, true));
    expect(offered).toEqual([
      'system',
      'jetbrains-mono',
      'sf-mono',
      'menlo',
      'monaco',
      'fira-code',
    ]);
    expect(isInstalled).not.toHaveBeenCalled();
    // A Windows / Linux id imported from another machine stays visible while selected.
    expect(
      ids(offeredFontFamilies(TERMINAL_FONT_FAMILIES, 'consolas', isInstalled, true)),
    ).toContain('consolas');
  });
});

describe('the font lists', () => {
  it('probes every local mono font by the name its stack puts first', () => {
    for (const family of TERMINAL_FONT_FAMILIES.filter((f) => f.probe)) {
      expect(family.css.replace(/"/g, '').startsWith(`${family.probe},`), family.id).toBe(true);
    }
  });
});
