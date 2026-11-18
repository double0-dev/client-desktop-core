/**
 * Moving sessions off an older build's session daemon (pure; terminal.ts acts).
 *
 * After an update (and on every dev rebuild) a new daemon starts beside the
 * old one. The old one keeps serving its terminals, refuses new ones and exits
 * once it is empty - so nothing breaks, but a long-lived session can run on
 * old daemon code for days, out of every fix since. Killing old daemons on
 * install would cut working agents off mid-turn (user decision 2026-11-05:
 * move, never kill). A terminal moves by ending its shell there; its tab
 * starts fresh on this build's daemon and the agent resumes its conversation
 * (`--resume`, agent-resume.ts).
 *
 * Automatically only what loses nothing: an agent idle at its prompt for
 * AUTO_MOVE_IDLE_MS, in a terminal no window shows, whose conversation the
 * fresh start resumes - the tab has a Claude or OpenCode record (`resumable`).
 * Codex has no continuity yet, and an agent typed by hand into a shell has no
 * record and no start command: moved, either would simply be gone (review
 * 2026-11-05). Idle is not enough on its own - an idle Claude may still run a
 * background shell (a dev server), which ends with it - hence the wait. Never a setup shell (a fresh one re-runs the
 * setup command) or a Commands shell (its finished output is what you read).
 * Settings › Sessions › Move now takes every terminal of a daemon, and asks
 * first when some are busy.
 */
import type { AgentStatus } from './terminal-modes';
import type { DaemonInfo } from './terminal-backend';
import { isSessionShell } from './session-shells';

/** How often main looks for terminals to move. */
export const MOVE_CHECK_MS = 60_000;
/** How long an agent must sit idle at its prompt before it moves by itself. */
export const AUTO_MOVE_IDLE_MS = 10 * 60_000;

/** The ids held by daemons of an older build - none while this build has no daemon. */
export function olderBuildIds(daemons: readonly DaemonInfo[]): string[] {
  if (!daemons.some((d) => d.current)) return [];
  return daemons.filter((d) => !d.current).flatMap((d) => d.ids);
}

/** Ids a fresh start would harm: their command would run again, or their output go. */
export function neverMovesByItself(id: string): boolean {
  return id.startsWith('setup:') || isSessionShell(id) || id.startsWith('host-signin:');
}

/** What main knows about one terminal when deciding. */
export type MoveProbe = {
  id: string;
  /** Speaks the status markers (an agent with our hooks). */
  marker: boolean;
  /** The agent's status, for a marker-driven terminal. */
  status: AgentStatus | null;
  /** A program other than the shell runs in the foreground (plain shells). */
  foregroundBusy: boolean;
  /** The tab's fresh start resumes its agent's conversation (a resume record exists). */
  resumable: boolean;
};

/** An agent at its prompt whose conversation a fresh start would NOT bring back. */
export function wouldLoseConversation(p: MoveProbe): boolean {
  return p.marker && p.status === 'idle' && !p.resumable;
}

/** Busy = an agent working or waiting on you, or a plain shell running a program. */
export function isBusy(p: MoveProbe): boolean {
  if (p.marker) return p.status !== 'idle';
  return p.foregroundBusy;
}

/**
 * Remember since when each marker-driven terminal has been idle. A terminal
 * seen busy (or no longer probed) starts over. Returns the new map.
 */
export function trackIdle(
  previous: ReadonlyMap<string, number>,
  probes: readonly MoveProbe[],
  now: number,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const p of probes) {
    if (!p.marker || p.status !== 'idle') continue;
    next.set(p.id, previous.get(p.id) ?? now);
  }
  return next;
}

/** The ids that move by themselves now (see the file comment). */
export function autoMovable(
  probes: readonly MoveProbe[],
  idleSince: ReadonlyMap<string, number>,
  now: number,
): string[] {
  return probes
    .filter((p) => !neverMovesByItself(p.id) && p.marker && p.status === 'idle' && p.resumable)
    .filter((p) => {
      const since = idleSince.get(p.id);
      return since !== undefined && now - since >= AUTO_MOVE_IDLE_MS;
    })
    .map((p) => p.id);
}

/** One daemon as Settings lists it. */
export type DaemonRow = {
  socketPath: string;
  buildId: string;
  current: boolean;
  /** Terminals it holds, and how many of them are busy right now. */
  terminals: number;
  busy: number;
};

export function daemonRows(
  daemons: readonly DaemonInfo[],
  probes: readonly MoveProbe[],
): DaemonRow[] {
  const busy = new Set(probes.filter(isBusy).map((p) => p.id));
  return daemons
    .map((d) => ({
      socketPath: d.socketPath,
      buildId: d.buildId,
      current: d.current,
      terminals: d.ids.length,
      busy: d.ids.filter((id) => busy.has(id)).length,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current));
}
