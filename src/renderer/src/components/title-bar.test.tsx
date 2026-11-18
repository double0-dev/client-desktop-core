import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DevBadge, TitleBar } from '@renderer/components/title-bar';
import { TRAFFIC_LIGHTS_INSET, titleBarInsets } from '@renderer/lib/window-chrome';

/** The preload's `windowChrome` bridge, with a full-screen push main would send. */
function fakeChrome(
  platform: string,
  opts: { local?: boolean; demo?: boolean; fullScreen?: boolean } = {},
) {
  let fullScreen = opts.fullScreen ?? false;
  const listeners = new Set<(v: boolean) => void>();
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      windowChrome: {
        platform: () => platform,
        isLocal: () => opts.local ?? false,
        isDemo: () => opts.demo ?? false,
        isFullScreen: () => fullScreen,
        onFullScreenChange: (cb: (v: boolean) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
    },
  });
  return {
    setFullScreen(value: boolean) {
      fullScreen = value;
      for (const cb of listeners) cb(value);
    },
    listeners,
  };
}

afterEach(() => {
  Reflect.deleteProperty(window, 'api');
});

describe('TitleBar', () => {
  it('drags the window and leaves room for the macOS traffic lights before the logo', () => {
    fakeChrome('darwin');
    render(<TitleBar className="px-3.5">logo</TitleBar>);
    const bar = screen.getByRole('banner');
    expect(bar).toHaveAttribute('data-titlebar');
    expect(bar).toHaveClass('[-webkit-app-region:drag]');
    expect(bar.style.paddingLeft).toBe(`${TRAFFIC_LIGHTS_INSET}px`);
  });

  it('gives the room back when macOS enters full screen, and takes it again on leave', () => {
    // The traffic lights are gone in full screen; a header that kept the inset
    // would show an empty gap before the logo.
    const chrome = fakeChrome('darwin');
    const { unmount } = render(<TitleBar />);
    const bar = screen.getByRole('banner');
    expect(bar.style.paddingLeft).toBe(`${TRAFFIC_LIGHTS_INSET}px`);

    act(() => chrome.setFullScreen(true));
    expect(bar.style.paddingLeft).toBe('');

    act(() => chrome.setFullScreen(false));
    expect(bar.style.paddingLeft).toBe(`${TRAFFIC_LIGHTS_INSET}px`);

    unmount();
    expect(chrome.listeners.size).toBe(0);
  });

  it('starts in full screen when main already reported it', () => {
    // A window restored into full screen enters it before React mounts.
    fakeChrome('darwin', { fullScreen: true });
    render(<TitleBar />);
    expect(screen.getByRole('banner').style.paddingLeft).toBe('');
  });

  it('keeps no traffic-light room on the demo instance, which hides them', () => {
    // Footage of the page never captures the native buttons (main hides them).
    fakeChrome('darwin', { demo: true });
    render(<TitleBar />);
    expect(screen.getByRole('banner').style.paddingLeft).toBe('');
  });

  it('keeps the header clear of the native controls overlay on Windows and Linux', () => {
    // Right padding = the overlay's width (everything right of the free
    // strip) + a gap; the fallbacks make it just the gap when the overlay is
    // gone (full screen).
    for (const platform of ['win32', 'linux']) {
      const style = titleBarInsets({ platform, local: false, fullScreen: false });
      expect(style.paddingLeft).toBeUndefined();
      expect(style.paddingRight).toBe(
        'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 12px)',
      );
    }
  });

  it('sits on the surface colour the OS paints its controls overlay in', () => {
    // A transparent bar over the page background left a lighter slab under
    // the Windows / Linux controls (sign-in, the not-found screens).
    fakeChrome('win32');
    render(<TitleBar className="absolute" />);
    expect(screen.getByRole('banner')).toHaveClass('bg-surface', 'h-14');
  });

  it('is the compact height in a torn-off window', () => {
    fakeChrome('darwin');
    render(<TitleBar size="compact" />);
    const bar = screen.getByRole('banner');
    expect(bar).toHaveClass('h-9');
    expect(bar).not.toHaveClass('h-14');
  });

  it('renders as a plain header without a bridge (tests, the headless drive)', () => {
    render(<TitleBar />);
    expect(screen.getByRole('banner').getAttribute('style') ?? '').toBe('');
  });
});

describe('DevBadge', () => {
  it('marks a local instance', () => {
    fakeChrome('darwin', { local: true });
    render(<DevBadge />);
    expect(screen.getByText('DEV')).toBeInTheDocument();
  });

  it('is absent in a release build', () => {
    fakeChrome('darwin', { local: false });
    render(<DevBadge />);
    expect(screen.queryByText('DEV')).not.toBeInTheDocument();
  });
});
