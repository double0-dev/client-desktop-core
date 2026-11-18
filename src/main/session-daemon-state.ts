import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The "Keep sessions running after quit" switch (Settings › Sessions),
 * persisted at `<userData>/session-daemon.json` so the quit sequence knows the
 * user's choice before any window has said anything (a private plan).
 * The renderer's store is the user-facing source of truth and mirrors into
 * this file on boot and on every change - the same arrangement as the
 * crash-reports switch (crash-report-state.ts). Pure node, tested against a
 * tmpdir; writes are best-effort.
 */
export type SessionDaemonState = {
  /** Quit leaves the daemon's terminals running (default); off = quit stops them. */
  keepRunning: boolean;
  /**
   * The "N sessions kept running while double0 was closed" notice has been
   * shown once on this machine (a private plan › Quit). It
   * exists for discoverability of the Keep-running switch, so once is enough
   * - machine-local, never part of the settings export.
   */
  launchNoticeShown: boolean;
};

export const SESSION_DAEMON_STATE_FILE = 'session-daemon.json';

export const SESSION_DAEMON_DEFAULTS: SessionDaemonState = {
  keepRunning: true,
  launchNoticeShown: false,
};

/**
 * Whether this launch shows the kept-running notice: terminals outlived the
 * last run (the daemon listed them at boot) and the notice was never shown.
 */
export function launchNoticeDue(state: SessionDaemonState, discoveredTerminals: number): boolean {
  return !state.launchNoticeShown && discoveredTerminals > 0;
}

/**
 * Whether a closing window kills the terminals it still owns. Quit closes
 * every window BEFORE `will-quit` decides about the shells, so a quit that
 * keeps sessions must spare them here too - otherwise the windows' 'closed'
 * cleanup has killed them all by the time the daemon is told to keep them.
 * Outside a quit, closing a window still ends its terminals.
 */
export function windowCloseKillsTerminals(o: {
  quitting: boolean;
  keepRunning: boolean;
  /** "Quit and Stop All Sessions" was chosen. */
  stopRequested: boolean;
}): boolean {
  return !(o.quitting && o.keepRunning && !o.stopRequested);
}

/** Decode the file's content; `rewrite` says it must be written back (missing, corrupt). */
export function parseSessionDaemonState(raw: string | null | undefined): {
  state: SessionDaemonState;
  rewrite: boolean;
} {
  let parsed: unknown = null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const record =
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const ok = typeof record.keepRunning === 'boolean';
  return {
    state: {
      keepRunning: ok ? (record.keepRunning as boolean) : SESSION_DAEMON_DEFAULTS.keepRunning,
      // Added after the first release of the file: a file without it is fine
      // as it is (the flag is written the day it flips), so no rewrite for it.
      launchNoticeShown: record.launchNoticeShown === true,
    },
    rewrite: !ok,
  };
}

export function writeSessionDaemonState(path: string, state: SessionDaemonState): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** The persisted state, created with the defaults when missing or unreadable. */
export function loadSessionDaemonState(path: string): SessionDaemonState {
  let raw: string | null;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    raw = null;
  }
  const { state, rewrite } = parseSessionDaemonState(raw);
  if (rewrite) writeSessionDaemonState(path, state);
  return state;
}
