import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorComponentProps } from '@tanstack/react-router';
import {
  beginBoot,
  isStartingFresh,
  resetStartFreshForTest,
  startFreshRequested,
  windowActions,
} from '@renderer/lib/start-fresh';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import { AppErrorScreen, HELP_EMAIL, RouteErrorScreen } from './app-error-screen';

/**
 * The window's error screen: what happened and ways out that work even when
 * the failure repeats on every launch (lib/start-fresh.ts) - a plain reload
 * restores the very view that crashed.
 */

let reload: ReturnType<typeof vi.spyOn>;
let close: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetStartFreshForTest();
  window.sessionStorage.clear();
  reload = vi.spyOn(windowActions, 'reload').mockImplementation(() => {});
  close = vi.spyOn(windowActions, 'close').mockImplementation(() => {});
});
afterEach(() => {
  reload.mockRestore();
  close.mockRestore();
  resetRendererExtensionForTest();
  resetStartFreshForTest();
  window.sessionStorage.clear();
});

describe('the error screen', () => {
  it('says what failed, with a title strip to move the window by', () => {
    render(<AppErrorScreen error={new Error('accounts.map is not a function')} />);
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByText('accounts.map is not a function')).toBeInTheDocument();
    expect(document.querySelector('[data-titlebar]')).not.toBeNull();
    expect(screen.getByRole('button', { name: HELP_EMAIL })).toBeInTheDocument();
  });

  it('Reload reloads, and the next boot restores as usual', async () => {
    const user = userEvent.setup();
    render(<AppErrorScreen error={new Error('x')} />);
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(startFreshRequested()).toBe(false);
  });

  it('Start fresh reloads without the last view - once', async () => {
    const user = userEvent.setup();
    render(<AppErrorScreen error={new Error('x')} />);
    await user.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(reload).toHaveBeenCalledTimes(1);
    // The reload's boot honours it, and only that boot.
    expect(beginBoot()).toBe(true);
    expect(isStartingFresh()).toBe(true);
    expect(beginBoot()).toBe(false);
  });

  it('says the next reload starts fresh when it failed again right after one', () => {
    beginBoot(Date.now() - 20_000);
    const first = render(<AppErrorScreen error={new Error('x')} />);
    expect(screen.queryByText(/next reload starts fresh/)).toBeNull();
    first.unmount();
    // The user pressed Reload: a new boot, and the same crash at once.
    beginBoot();
    render(<AppErrorScreen error={new Error('x')} />);
    expect(screen.getByText(/next reload starts fresh/)).toBeInTheDocument();
    expect(startFreshRequested()).toBe(true);
  });

  it('a torn-off window offers to close and give its tabs back instead', async () => {
    const user = userEvent.setup();
    render(<AppErrorScreen detached error={new Error('x')} />);
    expect(screen.queryByRole('button', { name: 'Start fresh' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Close window' }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('opens a mail draft to the help address', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AppErrorScreen error={new Error('x')} />);
    await user.click(screen.getByRole('button', { name: HELP_EMAIL }));
    expect(open).toHaveBeenCalledWith(`mailto:${HELP_EMAIL}`);
    open.mockRestore();
  });
});

describe('the error screen as the cover', () => {
  // A dialog open under the cover (a modal listens on `document` for Escape
  // and for a press outside it, which `inert` does not stop) was dismissed by
  // Escape or a click on the cover - and lost what was typed in it.
  it('neither Escape nor a press on it reaches a dialog open underneath', () => {
    const dismissed: string[] = [];
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismissed.push('escape');
    };
    const onPress = (): void => {
      dismissed.push('press');
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    document.addEventListener('mousedown', onPress);
    try {
      render(<AppErrorScreen cover error={new Error('x')} />);
      const reloadButton = screen.getByRole('button', { name: 'Reload' });
      fireEvent.keyDown(document.body, { key: 'Escape' });
      fireEvent.pointerDown(reloadButton);
      fireEvent.mouseDown(reloadButton);
      expect(dismissed).toEqual([]);
    } finally {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress);
      document.removeEventListener('mousedown', onPress);
    }
  });
});

describe("the router's default error component", () => {
  it('shows the error screen with its Reload and reports the error', () => {
    const reportError = vi.fn();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    installRendererExtension({ edition: 'pro', railTools: [], reportError });
    const error = new Error('route broke');
    render(
      <RouteErrorScreen {...({ error, reset: () => {} } as unknown as ErrorComponentProps)} />,
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start fresh' })).toBeInTheDocument();
    expect(reportError).toHaveBeenCalledWith(error, 'route');
    quiet.mockRestore();
  });
});
