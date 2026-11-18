import type { ProjectSessionMeta } from '@renderer/lib/session/counts';
import type { TerminalBusyStatus, TerminalTabState } from '@renderer/lib/terminal/busy';

/**
 * The live row band - the row-sized companion of the status dot (`.live-band`
 * in globals.css): a row that hosts running or blocked work is washed with the
 * status colour at 12% and breathes on the dot's own 2.4s cycle. The same two
 * states light every level, and each level rolls up from the one below it:
 *   - a TAB, when its terminal is busy (terminal-busy.ts);
 *   - a SESSION row, when any of its tabs is - that is what its status already
 *     aggregates (session-status.ts);
 *   - a PROJECT row, when any of its sessions is (projectSessionMeta).
 * So a busy tab is visible from the tab, from the sidebar, and from the
 * Projects panel without anything new being tracked. Pure, for tests.
 */
export type LiveBand = TerminalBusyStatus;

/**
 * A session's band from its status: working → running, blocked on the user →
 * needs-input. Idle, finished, done and archived rows sit unwashed - the same
 * line the breathing dot draws (`isLiveSessionStatus`): a finished-unseen
 * session wants a glance, and its static blue dot is enough to earn one.
 */
export function sessionLiveBand(status: string): LiveBand | null {
  if (status === 'active') return 'running';
  if (status === 'needs-input') return 'needs-input';
  return null;
}

/**
 * A project's band from its session roll-up. Needs-input wins over running:
 * a session blocked on you is the one thing in the project you have to act
 * on, the same call the header badge and the rail count make. The project
 * row's dot uses this precedence too, so the dot and the band on one row
 * never tell different stories.
 */
export function projectLiveBand(meta: ProjectSessionMeta | undefined): LiveBand | null {
  if (!meta) return null;
  if (meta.needsInput) return 'needs-input';
  if (meta.active) return 'running';
  return null;
}

/**
 * The classes that paint a band; undefined when there is none to paint. Tabs
 * pass the full tab state: a 'finished' tab wears the info wash - static,
 * unlike the two live bands, because nothing is happening any more - until the
 * user views the tab (terminal/busy's `markTerminalSeen`). Session and project
 * rows never carry it: theirs is the static blue dot.
 */
export function liveBandClass(band: TerminalTabState | null | undefined): string | undefined {
  if (!band) return undefined;
  if (band === 'running') return 'live-band live-band-running';
  if (band === 'needs-input') return 'live-band live-band-needs-input';
  return 'live-band live-band-finished';
}
