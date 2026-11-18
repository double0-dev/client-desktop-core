import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TITLE_BAR_COLORS, TITLE_BAR_HEIGHT, windowChromeOptions } from './window-chrome';

const GLOBALS_CSS = fileURLToPath(new URL('../renderer/src/assets/globals.css', import.meta.url));
const TITLE_BAR_TSX = fileURLToPath(
  new URL('../renderer/src/components/title-bar.tsx', import.meta.url),
);

/** A token's value in the `<selector> { … }` block of globals.css that declares it. */
function token(css: string, selector: string, name: string): string {
  const blocks = css
    .split(`\n${selector} {`)
    .slice(1)
    .map((b) => b.slice(0, b.indexOf('\n}')));
  const values = blocks.flatMap((b) => {
    const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(b);
    return match ? [match[1].trim()] : [];
  });
  expect(values).toHaveLength(1);
  return values[0];
}

describe('window chrome', () => {
  it('moves the macOS traffic lights into the header, centred on its height', () => {
    const full = windowChromeOptions('darwin', 'full', 'dark');
    expect(full.titleBarStyle).toBe('hidden');
    expect(full.titleBarOverlay).toBeUndefined();
    expect(full.trafficLightPosition).toEqual({ x: 14, y: 20 });
    // A torn-off window's header is shorter - the lights must follow it, or
    // they hang below its bottom border.
    expect(windowChromeOptions('darwin', 'compact', 'dark').trafficLightPosition).toEqual({
      x: 14,
      y: 10,
    });
  });

  it.each(['win32', 'linux'] as const)(
    'overlays the native controls on %s at the header height, in the theme colours',
    (platform) => {
      const opts = windowChromeOptions(platform, 'compact', 'light');
      expect(opts.titleBarStyle).toBe('hidden');
      expect(opts.trafficLightPosition).toBeUndefined();
      expect(opts.titleBarOverlay).toEqual({
        color: '#ffffff',
        symbolColor: '#71717a',
        height: TITLE_BAR_HEIGHT.compact,
      });
    },
  );

  it('places the controls for the heights the headers really have', () => {
    // The traffic lights' y and the overlay's height are computed from these
    // numbers; a header resized in title-bar.tsx alone would leave the lights
    // off-centre and the overlay taller or shorter than the bar.
    const src = readFileSync(TITLE_BAR_TSX, 'utf8');
    const table = /const HEIGHT_CLASS = \{([^}]*)\}/.exec(src)![1];
    const px = (kind: string): number =>
      Number(new RegExp(`${kind}: 'h-(\\d+)'`).exec(table)![1]) * 4;
    expect(px('full')).toBe(TITLE_BAR_HEIGHT.full);
    expect(px('compact')).toBe(TITLE_BAR_HEIGHT.compact);
  });

  it('tints the overlay exactly like the header (globals.css tokens)', () => {
    // The overlay is painted by the OS, not CSS: a token change that skipped
    // this table would leave a mismatched block at the header's right end.
    const css = readFileSync(GLOBALS_CSS, 'utf8');
    for (const [theme, selector] of [
      ['light', ':root'],
      ['dark', '.dark'],
    ] as const) {
      expect(TITLE_BAR_COLORS[theme]).toEqual({
        color: token(css, selector, 'surface'),
        symbolColor: token(css, selector, 'foreground-muted'),
      });
    }
  });
});
