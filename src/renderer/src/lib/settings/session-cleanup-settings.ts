import { useSyncExternalStore } from 'react';

/**
 * Settings → Sessions (design `Screen/Settings - Sessions`): when a quiet
 * session moves to the archive, and when an archived one is deleted for good.
 * The sweeps themselves run in workspace-host.tsx over the pure rules in
 * session/auto-archive.ts.
 *
 * Same localStorage pattern as the other settings stores (module state,
 * `storage` listener fanning changes to other windows, settings-transfer
 * export/import, Reset all settings).
 */

export type DurationUnit = 'hours' | 'days' | 'weeks';

export type SessionDuration = { amount: number; unit: DurationUnit };

export const DURATION_UNITS: DurationUnit[] = ['hours', 'days', 'weeks'];

/** Whole numbers only; the field clamps to this range. */
export const DURATION_MIN = 1;
export const DURATION_MAX = 999;

export type SessionCleanupSettings = {
  /** Archive a session once nothing has happened in it for `archiveAfter`. */
  autoArchive: boolean;
  archiveAfter: SessionDuration;
  /** Delete a session once it has been archived for `deleteAfter`. */
  autoDelete: boolean;
  deleteAfter: SessionDuration;
  /** Remove a deleted session's worktree too - only a clean one; the branch stays. */
  removeWorktree: boolean;
};

export const SESSION_CLEANUP_SETTINGS_KEY = 'double0-session-cleanup';

/** Auto-archive at a week is what the app did before it was a setting; delete
 * ships off - it is the one setting here that loses anything. */
export const SESSION_CLEANUP_DEFAULTS: SessionCleanupSettings = {
  autoArchive: true,
  archiveAfter: { amount: 7, unit: 'days' },
  autoDelete: false,
  deleteAfter: { amount: 30, unit: 'days' },
  removeWorktree: true,
};

const UNIT_MS: Record<DurationUnit, number> = {
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
};

export function durationMs(d: SessionDuration): number {
  return d.amount * UNIT_MS[d.unit];
}

/** `7 days`, `1 week` - for the confirm dialog's copy. */
export function formatDuration(d: SessionDuration): string {
  return `${d.amount} ${d.amount === 1 ? d.unit.slice(0, -1) : d.unit}`;
}

function sanitizeDuration(raw: unknown, fallback: SessionDuration): SessionDuration {
  const r = raw as Record<string, unknown> | null | undefined;
  const unit = DURATION_UNITS.includes(r?.unit as DurationUnit)
    ? (r?.unit as DurationUnit)
    : fallback.unit;
  const n = typeof r?.amount === 'number' && Number.isFinite(r.amount) ? r.amount : NaN;
  const amount = Number.isNaN(n)
    ? fallback.amount
    : Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(n)));
  return { amount, unit };
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

export function sanitizeSessionCleanup(raw: unknown): SessionCleanupSettings {
  const r = raw as Record<string, unknown> | null;
  const d = SESSION_CLEANUP_DEFAULTS;
  return {
    autoArchive: bool(r?.autoArchive, d.autoArchive),
    archiveAfter: sanitizeDuration(r?.archiveAfter, d.archiveAfter),
    autoDelete: bool(r?.autoDelete, d.autoDelete),
    deleteAfter: sanitizeDuration(r?.deleteAfter, d.deleteAfter),
    removeWorktree: bool(r?.removeWorktree, d.removeWorktree),
  };
}

function load(): SessionCleanupSettings {
  if (typeof window === 'undefined') return sanitizeSessionCleanup(null);
  try {
    const raw = window.localStorage.getItem(SESSION_CLEANUP_SETTINGS_KEY);
    return sanitizeSessionCleanup(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeSessionCleanup(null);
  }
}

let settings = load();
const listeners = new Set<(s: SessionCleanupSettings) => void>();

if (typeof window !== 'undefined') {
  // Other windows, a settings import and Reset all settings all arrive here.
  window.addEventListener('storage', (event) => {
    if (event.key !== SESSION_CLEANUP_SETTINGS_KEY) return;
    settings = load();
    for (const listener of listeners) listener(settings);
  });
}

export function getSessionCleanupSettings(): SessionCleanupSettings {
  return settings;
}

export function updateSessionCleanupSettings(patch: Partial<SessionCleanupSettings>): void {
  settings = sanitizeSessionCleanup({ ...settings, ...patch });
  try {
    window.localStorage.setItem(SESSION_CLEANUP_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage failure - the change still applies for this session.
  }
  for (const listener of listeners) listener(settings);
}

export function subscribeSessionCleanupSettings(
  listener: (s: SessionCleanupSettings) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSessionCleanupSettings(): SessionCleanupSettings {
  return useSyncExternalStore(subscribeSessionCleanupSettings, getSessionCleanupSettings);
}
