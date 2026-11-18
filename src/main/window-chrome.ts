import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron';
import type { ThemeHint } from './theme-hint';

/**
 * The window frame: no OS title bar anywhere - the app's own header is the
 * title bar (drag region, window controls, the DEV badge). macOS keeps its
 * traffic lights, moved into the header before the logo; Windows and Linux
 * get the OS's own minimise / maximise / close buttons overlaid on the
 * header's right end (Window Controls Overlay - Snap Layouts on Windows 11
 * keep working), tinted like the header.
 *
 * Pure (types only from Electron) so the geometry is testable; index.ts
 * applies it in `createWindow` and re-tints the overlay on a theme change.
 * The preload imports `LOCAL_ENV_ARG` and `DEMO_ARG` from here as a value, so this module
 * must stay free of Electron (or any other) value imports.
 */

/** Which header a window renders: the app chrome (h-14) or a torn-off window's (h-9). */
export type TitleBarKind = 'full' | 'compact';

/** The header heights in px - `HEIGHT_CLASS` in components/title-bar.tsx (asserted equal). */
export const TITLE_BAR_HEIGHT: Record<TitleBarKind, number> = { full: 56, compact: 36 };

/** The traffic lights' button frames are 16px tall on macOS; centred in the header. */
const TRAFFIC_LIGHT_FRAME = 16;

/** Left edge of the traffic lights - the header's own `px-3.5` inset. */
export const TRAFFIC_LIGHT_X = 14;

/** The header colours per theme: `--surface` and `--foreground-muted` in globals.css. */
export const TITLE_BAR_COLORS: Record<ThemeHint, { color: string; symbolColor: string }> = {
  dark: { color: '#111114', symbolColor: '#a1a1aa' },
  light: { color: '#ffffff', symbolColor: '#71717a' },
};

export function titleBarOverlay(theme: ThemeHint, kind: TitleBarKind): TitleBarOverlayOptions {
  return { ...TITLE_BAR_COLORS[theme], height: TITLE_BAR_HEIGHT[kind] };
}

export function windowChromeOptions(
  platform: NodeJS.Platform,
  kind: TitleBarKind,
  theme: ThemeHint,
): Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'trafficLightPosition' | 'titleBarOverlay'
> {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: {
        x: TRAFFIC_LIGHT_X,
        y: Math.round((TITLE_BAR_HEIGHT[kind] - TRAFFIC_LIGHT_FRAME) / 2),
      },
    };
  }
  return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(theme, kind) };
}

/**
 * The flag main passes a window's renderer (`additionalArguments`) so the
 * preload can tell the header to show the DEV badge before anything loads.
 */
export const LOCAL_ENV_ARG = '--double0-env=local';

/**
 * The flag main passes a demo instance's renderer (app-env.ts ›
 * `isDemoInstance`): the header drops the room it keeps for the traffic
 * lights, which main hides on that window.
 */
export const DEMO_ARG = '--double0-demo';
