import { useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';

/**
 * The app's header is the window's title bar (main/window-chrome.ts): no OS
 * title bar on any platform. macOS draws its traffic lights over the header's
 * left end, Windows and Linux their minimise / maximise / close buttons over
 * its right end - the header keeps that room free, and drops the left room in
 * macOS full screen, where the traffic lights are gone, and on the seeded demo
 * instance, which hides them (footage never captures the native buttons).
 */
export type WindowChrome = {
  platform: string;
  /** A local instance (`pnpm dev`, a localhost build): the header shows DEV. */
  local: boolean;
  /** The seeded marketing instance (main/app-env.ts › `isDemoInstance`): its traffic lights are hidden. */
  demo?: boolean;
  fullScreen: boolean;
};

/**
 * Where the logo starts beside the traffic lights: the three buttons end at
 * ~74px (measured on macOS 26), then a ~20px gap - a little more than the
 * logo keeps from the divider, so the lights read as the OS's, not a part of
 * the brand mark.
 */
export const TRAFFIC_LIGHTS_INSET = 94;

/** Space between the header's last control and the OS window controls. */
const CONTROLS_GAP = 12;

/**
 * The header's padding on the side the OS controls take. Only that side: the
 * other keeps the header's own `px-*`. Under the controls overlay the CSS
 * `titlebar-area-*` env variables say where the free strip ends; without an
 * overlay (full screen) they are unset and only the gap remains.
 */
export function titleBarInsets(chrome: WindowChrome): CSSProperties {
  if (chrome.platform === 'darwin') {
    return chrome.fullScreen || chrome.demo ? {} : { paddingLeft: TRAFFIC_LIGHTS_INSET };
  }
  if (chrome.platform === 'win32' || chrome.platform === 'linux') {
    return {
      paddingRight: `calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + ${CONTROLS_GAP}px)`,
    };
  }
  return {};
}

type Bridge = {
  platform?: () => string;
  isLocal?: () => boolean;
  isDemo?: () => boolean;
  isFullScreen?: () => boolean;
  onFullScreenChange?: (cb: (fullScreen: boolean) => void) => () => void;
};

// The bridge may be missing or a catch-all stub (tests, the headless drive):
// every read is type-checked, never trusted.
const bridge = (): Bridge =>
  (typeof window !== 'undefined' ? (window.api?.windowChrome as Bridge | undefined) : undefined) ??
  {};

const read = <T>(value: unknown, fallback: T): T =>
  typeof value === typeof fallback ? (value as T) : fallback;

let snapshot: WindowChrome | null = null;

function current(): WindowChrome {
  const b = bridge();
  const next: WindowChrome = {
    platform: read(b.platform?.(), ''),
    local: read(b.isLocal?.(), false),
    demo: read(b.isDemo?.(), false),
    fullScreen: read(b.isFullScreen?.(), false),
  };
  if (
    !snapshot ||
    snapshot.platform !== next.platform ||
    snapshot.local !== next.local ||
    snapshot.demo !== next.demo ||
    snapshot.fullScreen !== next.fullScreen
  ) {
    snapshot = next;
  }
  return snapshot;
}

function subscribe(onChange: () => void): () => void {
  const off = bridge().onFullScreenChange?.(() => onChange());
  return typeof off === 'function' ? off : () => {};
}

export function useWindowChrome(): WindowChrome {
  return useSyncExternalStore(subscribe, current, current);
}
