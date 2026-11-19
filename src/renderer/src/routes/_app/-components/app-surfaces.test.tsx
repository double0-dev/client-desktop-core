import { act, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import type { HostsSlot, RendererExtension } from '@renderer/lib/extension/types';
import { resetStartFreshForTest } from '@renderer/lib/start-fresh';
import { isAppLocked, setAppLocked } from '@renderer/lib/app-lock';
import { AppSurfaces } from './app-surfaces';

/**
 * The app layout's parts fail on their own (components/slot-boundary.tsx).
 * Before, any render throw anywhere in the window reached the router's
 * default error screen, which replaced everything - the cover included: a
 * status bar item that kept a reply of the wrong shape took every window
 * down at launch (2026-11-18).
 */

const failing = { workspace: false };
vi.mock('@renderer/routes/_app/-components/workspace/workspace', () => ({
  WorkspaceHost: () => {
    if (failing.workspace) throw new Error('workspace broke');
    return <div data-testid="workspace">workspace</div>;
  },
}));
vi.mock('@renderer/routes/_app/-components/search-everywhere/search-everywhere', () => ({
  SearchEverywhere: () => <div data-testid="search">search</div>,
}));
vi.mock('@renderer/routes/_app/-components/new-project-host', () => ({
  NewProjectHost: () => <div data-testid="new-project">new project</div>,
}));

const USER = { id: '00000000-0000-4000-8000-000000000000', email: 'emmaw@example.com' };
const Throws = (): never => {
  throw new Error('slot broke');
};
const Plain = () => <div data-testid="cover">cover</div>;

/**
 * A stand-in for the extension's cover that does what the real one does
 * (plan-lock.tsx › useCoverHost): a layer of its own under <body>, every
 * other <body> child `inert`, the app marked locked - and all of it undone
 * when it goes. `cover.up` / `cover.broken` drive it from the test.
 */
const cover = {
  up: true,
  broken: false,
  listeners: new Set<() => void>(),
  set(patch: Partial<{ up: boolean; broken: boolean }>) {
    Object.assign(cover, patch);
    for (const l of cover.listeners) l();
  },
};
function RealisticCover() {
  const state = useSyncExternalStore(
    (l) => {
      cover.listeners.add(l);
      return () => cover.listeners.delete(l);
    },
    () => `${cover.up}|${cover.broken}`,
  );
  const [host, setHost] = useState<HTMLElement | null>(null);
  const up = state.startsWith('true');
  useLayoutEffect(() => {
    if (!up) return;
    const el = document.createElement('div');
    el.setAttribute('data-test-cover', '');
    document.body.appendChild(el);
    const madeInert: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child === el || !(child instanceof HTMLElement) || child.inert) continue;
      child.inert = true;
      madeInert.push(child);
    }
    const previous = document.activeElement as HTMLElement | null;
    previous?.blur();
    setAppLocked(true);
    setHost(el);
    return () => {
      for (const child of madeInert) child.inert = false;
      setAppLocked(false);
      el.remove();
      setHost(null);
      // The real cover gives the keyboard back to what had it.
      if (previous && previous !== document.body && previous.isConnected) previous.focus();
    };
  }, [up]);
  if (!up || !host) return null;
  if (cover.broken) throw new Error('cover broke');
  return createPortal(<button type="button">Check again</button>, host);
}

/** Inert itself or under an inert ancestor: no click, no focus, no keys. */
function inertAt(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if ((node as HTMLElement).inert) return true;
  }
  return false;
}

function install(slots: {
  dialogs?: () => React.JSX.Element;
  lock?: () => React.JSX.Element | null;
}) {
  installRendererExtension({
    edition: 'pro',
    railTools: [],
    hosts: slots.dialogs ? ({ AppDialogs: slots.dialogs } as unknown as HostsSlot) : undefined,
    auth: slots.lock
      ? ({ Lock: slots.lock } as unknown as NonNullable<RendererExtension['auth']>)
      : undefined,
  });
}

let quiet: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  failing.workspace = false;
  cover.up = true;
  cover.broken = false;
  resetStartFreshForTest();
  quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  resetRendererExtensionForTest();
  quiet.mockRestore();
  window.sessionStorage.clear();
  setAppLocked(false);
});

describe('the app layout parts', () => {
  it('drops a failing extension dialog and keeps every sibling and the cover', () => {
    install({ dialogs: Throws, lock: Plain });
    render(<AppSurfaces user={USER} />);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
    expect(screen.getByTestId('search')).toBeInTheDocument();
    expect(screen.getByTestId('new-project')).toBeInTheDocument();
    expect(screen.getByTestId('cover')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a usable error screen, with its message, for a failing workspace', () => {
    failing.workspace = true;
    install({ lock: () => null });
    render(<AppSurfaces user={USER} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    // "Write to us with the message above" - the message is there.
    expect(alert).toHaveTextContent('workspace broke');
    expect(inertAt(screen.getByRole('button', { name: 'Reload' }))).toBe(false);
    expect(screen.getByTestId('search')).toBeInTheDocument();
  });

  it('keeps the cover usable over a failing workspace - the error screen waits until it goes', async () => {
    // The screen rendered inside the inert root ABOVE the cover: it hid
    // Check again and Sign out, and its own buttons took no click.
    failing.workspace = true;
    install({ lock: RealisticCover });
    const view = render(<AppSurfaces user={USER} />);
    const check = screen.getByRole('button', { name: 'Check again' });
    expect(inertAt(check)).toBe(false);
    expect(view.container.inert).toBe(true);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    // The plan comes back: the cover goes, and the error screen is usable.
    act(() => cover.set({ up: false }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(inertAt(screen.getByRole('button', { name: 'Reload' }))).toBe(false);
  });

  it('keeps the window locked when the cover itself fails: the error screen covers, the rest is inert', () => {
    install({ lock: Throws });
    const view = render(<AppSurfaces user={USER} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    // Outside the app's root, which is inert: the keyboard and the shortcuts
    // cannot reach the workspace behind it.
    expect(view.container.contains(alert)).toBe(false);
    expect(inertAt(alert)).toBe(false);
    expect(inertAt(screen.getByTestId('workspace'))).toBe(true);
    expect(isAppLocked()).toBe(true);
  });

  it('stays locked when a cover that was up fails - its own cleanup must not unlock the app', () => {
    // A cover that throws on a later render unmounts, and its cleanup lifted
    // inert, unlocked the app and gave the terminal its focus back.
    cover.up = false;
    install({ lock: RealisticCover });
    const view = render(
      <>
        <input aria-label="terminal" />
        <AppSurfaces user={USER} />
      </>,
    );
    screen.getByLabelText('terminal').focus();
    act(() => cover.set({ up: true }));
    expect(isAppLocked()).toBe(true);
    act(() => cover.set({ broken: true }));
    expect(isAppLocked()).toBe(true);
    expect(view.container.inert).toBe(true);
    const alert = screen.getByRole('alert');
    expect(inertAt(alert)).toBe(false);
    expect(view.container.contains(document.activeElement)).toBe(false);
  });
});
