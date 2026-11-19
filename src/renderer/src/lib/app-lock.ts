import { useSyncExternalStore } from 'react';

/**
 * Whether something covers the whole window and owns the keyboard - the
 * extension's lock (`AuthSlot.Lock`) marks `<html>` while it shows. The
 * window-level shortcut handlers (`use-app-shortcuts.ts`,
 * `workspace-shortcuts.tsx`) stand down then: they listen on `window` in the
 * capture phase, so an `inert` page behind the cover would not stop them.
 * Terminals and editors need no check - an inert subtree holds no focus.
 */
export const APP_LOCKED_ATTR = 'data-app-locked';

export function isAppLocked(doc: Document = document): boolean {
  return doc.documentElement.hasAttribute(APP_LOCKED_ATTR);
}

export function setAppLocked(locked: boolean, doc: Document = document): void {
  if (locked) doc.documentElement.setAttribute(APP_LOCKED_ATTR, '');
  else doc.documentElement.removeAttribute(APP_LOCKED_ATTR);
}

/**
 * Whether the window is locked, as React state: follows the attribute, so a
 * component can stand back while a cover owns the window (the error screen
 * waits under it - rendered inside the inert root above the cover, it hid
 * the cover's own buttons and took no click itself).
 */
export function useAppLocked(): boolean {
  return useSyncExternalStore(subscribeAppLock, () => isAppLocked());
}

function subscribeAppLock(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [APP_LOCKED_ATTR],
  });
  return () => observer.disconnect();
}
