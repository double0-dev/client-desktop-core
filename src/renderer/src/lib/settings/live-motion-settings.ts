import { useSyncExternalStore } from 'react';
import { SETTINGS_APPLIED_EVENT } from './settings-events';

/**
 * Settings → General → "Animate live status": how the live status dots and
 * row bands move (globals.css › status-dot-live / live-band). Measured on the
 * demo world (2026-11-05): their endless 2.4s cycles kept the GPU process at
 * ~25-30% of a core and the page restyling ~27 times a second while any
 * session was live; frozen, ~2%.
 *
 * - `always` - breathe for as long as the session is live (the original look).
 * - `change` ("Reduced", the default - user decision 2026-11-05): pulse a few
 *   times when a dot or band turns live or switches between working and
 *   waiting on you, then hold still. Most people never open Settings, and the
 *   endless breathing cost every one of them ~30% of a core while agents
 *   worked. Nothing keeps breathing, not even a waiting session: one endless
 *   animation makes the whole window redraw every frame (measured).
 * - `off` - never move; the colour alone tells the state (as under
 *   prefers-reduced-motion).
 *
 * Applied as `data-live-motion` on <html>, which globals.css reads. Same store
 * pattern as the other settings: module state + localStorage + `storage`
 * fan-out to other windows + SETTINGS_APPLIED_EVENT re-decode.
 */
export type LiveMotion = 'always' | 'change' | 'off';

export type LiveMotionSettings = { motion: LiveMotion };

export const LIVE_MOTION_SETTINGS_KEY = 'double0-live-motion';

export const LIVE_MOTION_OPTIONS: ReadonlyArray<{ id: LiveMotion; label: string }> = [
  { id: 'always', label: 'Always' },
  { id: 'change', label: 'Reduced' },
  { id: 'off', label: 'Off' },
];

const DEFAULTS: LiveMotionSettings = { motion: 'change' };

export function sanitizeLiveMotion(raw: unknown): LiveMotionSettings {
  const motion = (raw as Record<string, unknown> | null)?.motion;
  return {
    motion:
      motion === 'always' || motion === 'change' || motion === 'off' ? motion : DEFAULTS.motion,
  };
}

function load(): LiveMotionSettings {
  if (typeof window === 'undefined') return sanitizeLiveMotion(null);
  try {
    const raw = window.localStorage.getItem(LIVE_MOTION_SETTINGS_KEY);
    return sanitizeLiveMotion(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeLiveMotion(null);
  }
}

let settings = load();
const listeners = new Set<(s: LiveMotionSettings) => void>();

/** Put the choice on <html>, where globals.css reads it. */
function apply(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.liveMotion = settings.motion;
}

function reread(): void {
  settings = load();
  apply();
  for (const listener of listeners) listener(settings);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    // A null key is a storage clear (Reset all settings in another window).
    if (event.key === LIVE_MOTION_SETTINGS_KEY || event.key === null) reread();
  });
  window.addEventListener(SETTINGS_APPLIED_EVENT, reread);
  apply();
}

/** Called once at window start (main.tsx), beside initAppFont / initAccentColor. */
export function initLiveMotion(): void {
  apply();
}

export function getLiveMotionSettings(): LiveMotionSettings {
  return settings;
}

export function updateLiveMotionSettings(patch: Partial<LiveMotionSettings>): void {
  settings = sanitizeLiveMotion({ ...settings, ...patch });
  try {
    window.localStorage.setItem(LIVE_MOTION_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage failure - the change still applies for this session.
  }
  apply();
  for (const listener of listeners) listener(settings);
}

export function subscribeLiveMotionSettings(listener: (s: LiveMotionSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveMotionSettings(): LiveMotionSettings {
  return useSyncExternalStore(subscribeLiveMotionSettings, getLiveMotionSettings);
}
