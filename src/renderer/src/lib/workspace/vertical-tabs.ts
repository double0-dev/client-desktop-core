import { useSyncExternalStore } from 'react';

/**
 * Vertical tabs (Settings → General → Workspace): list each session's open tabs
 * in a dock panel (the rail's "Tabs" tool) instead of the horizontal per-pane
 * tab strips. Off by default.
 *
 * A tiny localStorage-backed store following the same pattern as
 * live-motion-settings.ts: module-level state, a `storage` listener fanning
 * changes to other windows, and applied directly by the settings import
 * (`applyAppSettings` calls `setVerticalTabs`).
 */

export const VERTICAL_TABS_KEY = 'double0-workspace-vertical-tabs';

function load(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(VERTICAL_TABS_KEY) === '1';
  } catch {
    return false;
  }
}

let enabled = load();
const listeners = new Set<(on: boolean) => void>();

if (typeof window !== 'undefined') {
  // Settings edited in one window must reach the others (torn-off sessions); a
  // settings-transfer import also writes this key and dispatches `storage`.
  window.addEventListener('storage', (event) => {
    if (event.key !== VERTICAL_TABS_KEY) return;
    enabled = load();
    for (const listener of listeners) listener(enabled);
  });
}

export function getVerticalTabs(): boolean {
  return enabled;
}

export function setVerticalTabs(on: boolean): void {
  enabled = on;
  try {
    window.localStorage.setItem(VERTICAL_TABS_KEY, on ? '1' : '0');
  } catch {
    // Storage failure - the change still applies for this session.
  }
  for (const listener of listeners) listener(enabled);
}

export function subscribeVerticalTabs(listener: (on: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVerticalTabs(): boolean {
  return useSyncExternalStore(subscribeVerticalTabs, getVerticalTabs);
}
