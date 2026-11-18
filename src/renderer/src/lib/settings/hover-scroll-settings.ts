import { useSyncExternalStore } from 'react';
import { SETTINGS_APPLIED_EVENT } from './settings-events';

/**
 * Settings → General → "Scroll long names on hover": whether text that does
 * not fit its row (a session's name and activity line, a branch or tag)
 * slides sideways while the row is hovered (components/hover-scroll-text.tsx).
 * On by default; off keeps the ellipsis and the tooltip only.
 *
 * Same store pattern as the other settings: module state + localStorage +
 * `storage` fan-out to other windows + SETTINGS_APPLIED_EVENT re-decode.
 */
export type HoverScrollSettings = { enabled: boolean };

export const HOVER_SCROLL_SETTINGS_KEY = 'double0-hover-scroll';

const DEFAULTS: HoverScrollSettings = { enabled: true };

export function sanitizeHoverScroll(raw: unknown): HoverScrollSettings {
  const enabled = (raw as Record<string, unknown> | null)?.enabled;
  return { enabled: typeof enabled === 'boolean' ? enabled : DEFAULTS.enabled };
}

function load(): HoverScrollSettings {
  if (typeof window === 'undefined') return sanitizeHoverScroll(null);
  try {
    const raw = window.localStorage.getItem(HOVER_SCROLL_SETTINGS_KEY);
    return sanitizeHoverScroll(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeHoverScroll(null);
  }
}

let settings = load();
const listeners = new Set<(s: HoverScrollSettings) => void>();

function reread(): void {
  settings = load();
  for (const listener of listeners) listener(settings);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    // A null key is a storage clear (Reset all settings in another window).
    if (event.key === HOVER_SCROLL_SETTINGS_KEY || event.key === null) reread();
  });
  window.addEventListener(SETTINGS_APPLIED_EVENT, reread);
}

export function getHoverScrollSettings(): HoverScrollSettings {
  return settings;
}

export function updateHoverScrollSettings(patch: Partial<HoverScrollSettings>): void {
  settings = sanitizeHoverScroll({ ...settings, ...patch });
  try {
    window.localStorage.setItem(HOVER_SCROLL_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage failure - the change still applies for this session.
  }
  for (const listener of listeners) listener(settings);
}

export function subscribeHoverScrollSettings(
  listener: (s: HoverScrollSettings) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHoverScrollSettings(): HoverScrollSettings {
  return useSyncExternalStore(subscribeHoverScrollSettings, getHoverScrollSettings);
}
