import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

/** How long a closed dialog's root stays mounted: its close animation. */
const CLOSE_ANIMATION_MS = 250;

/** Roots whose dialog has answered and whose unmount is still on its timer. */
const closing = new Set<() => void>();

/**
 * Mount a one-off root into `document.body` for an imperative dialog
 * (`confirmDialog`, the delete dialog, an extension's own). `render` gets `done`:
 * calling it resolves the promise and, once the close animation has had time
 * to play, unmounts the root again.
 */
export function presentImperative<T>(render: (done: (value: T) => void) => ReactNode): Promise<T> {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const done = (value: T): void => {
      resolve(value);
      const unmount = (): void => {
        clearTimeout(timer);
        closing.delete(unmount);
        root.unmount();
        container.remove();
      };
      const timer = setTimeout(unmount, CLOSE_ANIMATION_MS);
      closing.add(unmount);
    };
    root.render(render(done));
  });
}

/**
 * Unmount every answered dialog's root now instead of on its timer. The
 * renderer test setup calls it after each test: a timer left pending fired
 * after the file's environment was torn down - `window is not defined` from
 * React's unmount, an unhandled error that failed the v0.7.0 and v0.7.1
 * release checks on a loaded Mac.
 */
export function unmountClosedImperativeRoots(): void {
  for (const unmount of [...closing]) unmount();
}
