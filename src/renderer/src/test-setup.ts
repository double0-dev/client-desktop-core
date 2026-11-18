import '@testing-library/jest-dom/vitest';
import { act, cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { unmountClosedImperativeRoots } from '@renderer/lib/imperative-root';

// `waitFor` / `findBy*` give up after 1 s by default: enough on an idle Mac,
// not on the loaded release runner, where changes-view's "takes the second
// reveal" timed out on a commit that did land (v0.5.3's check). A broken
// expectation still fails, just later.
configure({ asyncUtilTimeout: 4000 });

/**
 * Shared setup for the `renderer` Vitest project (jsdom).
 *
 * jsdom gives us a DOM and localStorage, but not the pieces of the Electron /
 * browser environment the app leans on: the preload bridge (`window.api`),
 * `matchMedia`, and the observer APIs layout code constructs on mount. They are
 * stubbed here so a module under test exercises its real path instead of its
 * "no window" fallback. Tests that care about a specific bridge call override
 * the stub themselves.
 */

/** Enough of the observer contract for components that construct one on mount;
 * nothing under test asserts on observations. */
const StubObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
};

// Module scope, not beforeEach: xterm measures glyphs through a canvas the
// moment it is imported, which is before any hook runs. jsdom defines
// getContext only to throw "Not implemented", flooding the output; nothing
// under test reads pixels, so a null context (the "unsupported" answer) is
// enough.
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();

  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  window.ResizeObserver ??= StubObserver as unknown as typeof ResizeObserver;
  window.IntersectionObserver ??= StubObserver as unknown as typeof IntersectionObserver;
  // jsdom implements neither; Radix and the pane geometry call them on mount.
  Element.prototype.scrollIntoView ??= vi.fn();
  // Programmatic scrolling (the merge view's conflict navigation, ...) is a no-op too.
  Element.prototype.scrollTo ??= vi.fn();
  window.HTMLElement.prototype.releasePointerCapture ??= vi.fn();
  window.HTMLElement.prototype.hasPointerCapture ??= vi.fn();
});

afterEach(() => {
  cleanup();
  // An answered imperative dialog unmounts its root on a 250 ms timer; one
  // left pending at the end of a file fired after teardown and failed the
  // release check (`lib/imperative-root.ts`).
  act(() => unmountClosedImperativeRoots());
});
