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
