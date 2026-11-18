import { useSyncExternalStore } from 'react';

/**
 * Settings › Sessions › After quit (a private plan): whether
 * quitting the app leaves the session daemon's terminals - shells and agents
 * - running, to be picked up again on the next launch. On by default; off
 * means quit stops them as it did before the daemon.
 *
 * Same localStorage pattern as the other settings stores (module state,
 * `storage` listener fanning changes to other windows, settings-transfer
 * export/import, Reset all settings), mirrored into main - which owns the
 * quit sequence and the persisted copy - on boot and on every change, like
 * the crash-reports switch.
 */
export type SessionDaemonSettings = {
  /** Quit leaves running sessions alive for the next launch. */
  keepRunning: boolean;
};

export const SESSION_DAEMON_SETTINGS_KEY = 'double0-session-daemon';

export const SESSION_DAEMON_DEFAULTS: SessionDaemonSettings = { keepRunning: true };

export function sanitizeSessionDaemon(raw: unknown): SessionDaemonSettings {
  const r = raw as Record<string, unknown> | null;
  return {
    keepRunning:
      typeof r?.keepRunning === 'boolean' ? r.keepRunning : SESSION_DAEMON_DEFAULTS.keepRunning,
  };
}

function load(): SessionDaemonSettings {
  if (typeof window === 'undefined') return sanitizeSessionDaemon(null);
  try {
    const raw = window.localStorage.getItem(SESSION_DAEMON_SETTINGS_KEY);
    return sanitizeSessionDaemon(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeSessionDaemon(null);
  }
}

let settings = load();
const listeners = new Set<(s: SessionDaemonSettings) => void>();

function pushToMain(): void {
  void window.api?.sessions?.setKeepRunning?.(settings.keepRunning);
}

if (typeof window !== 'undefined') {
  // Other windows, a settings import and Reset all settings all arrive here.
  window.addEventListener('storage', (event) => {
    if (event.key !== SESSION_DAEMON_SETTINGS_KEY) return;
    settings = load();
    pushToMain();
    for (const listener of listeners) listener(settings);
  });
  // Main starts from its own persisted copy; tell it this window's truth as
  // soon as it boots (a single window is enough - main keeps one flag).
  pushToMain();
}

export function getSessionDaemonSettings(): SessionDaemonSettings {
  return settings;
}

export function updateSessionDaemonSettings(patch: Partial<SessionDaemonSettings>): void {
  settings = sanitizeSessionDaemon({ ...settings, ...patch });
  try {
    window.localStorage.setItem(SESSION_DAEMON_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage failure - the change still applies for this session and reaches main.
  }
  pushToMain();
  for (const listener of listeners) listener(settings);
}

export function subscribeSessionDaemonSettings(
  listener: (s: SessionDaemonSettings) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSessionDaemonSettings(): SessionDaemonSettings {
  return useSyncExternalStore(subscribeSessionDaemonSettings, getSessionDaemonSettings);
}
