import { useSyncExternalStore } from 'react';
import type { Tab } from '@renderer/lib/workspace/layout';

/**
 * Window-wide registry of which terminal PTYs currently host busy work - an
 * agent mid-turn ('running') or one blocked on the user ('needs-input') - so
 * the close paths can warn before killing a tab or session that's still doing
 * something (see workspace-context's closeTab and confirmSessionDeletion).
 *
 * Fed by the session status observers (session-status.ts), which own the
 * terminal streams. Marker-driven PTYs (Claude) are exact: `setTerminalBusy`
 * applies each lifecycle marker directly. Markerless PTYs (a plain shell, an
 * agent with no adapter) are tracked per PTY by the same fallback heuristics
 * the session-level status uses - output means running until a quiet window
 * passes, a bell means blocked on you - via the `note*` feeders, so a plain
 * `pnpm test` tab reads as busy even while a marker-driven tab owns the
 * session's aggregate status. Per-renderer like the observers themselves.
 *
 * Also the source of the tab strips' live band (live-band.ts): a busy tab is
 * washed with its status colour, so the registry is reactive - subscribe, or
 * use the hooks below.
 */
export type TerminalBusyStatus = 'running' | 'needs-input';

/**
 * What a tab can show beyond busy: 'finished' is the tab-level twin of the
 * session's finished-unseen status - work in this terminal stopped while the
 * user wasn't viewing the tab, and the mark holds until they do
 * (`markTerminalSeen`, driven by WorkspaceBody for each pane's visible tab).
 * A finished tab is NOT busy: closing it warns about nothing.
 */
export type TerminalTabState = TerminalBusyStatus | 'finished';

// Fallback quiet windows - mirror STATUS_IDLE_MS / SETTLE_MS in
// session-status.ts so a tab and its session settle in step.
const IDLE_MS = 8_000;
const SETTLE_MS = 1_000;

// Immutable snapshot, swapped wholesale on every change so useSyncExternalStore
// consumers see a new reference. Per-pty reads return primitives, so a tab
// whose own state didn't change never re-renders.
let snapshot: ReadonlyMap<string, TerminalTabState> = new Map();
const listeners = new Set<() => void>();

/**
 * Every pty this renderer has heard from - a marker, output, a bell, an exit.
 * A pty NOT in here is unknown, not quiet: a window that just loaded (a
 * reload, a tear-off) has seen nothing from a parked agent, and a parked
 * needs-input agent emits nothing until it is answered, so "no news" must not
 * read as idle. The session-level recheck after a tab closes
 * (session/status.ts `aggregateTabStatus`) refuses to call such a terminal
 * quiet. Viewing a tab (`markTerminalSeen`) is not evidence, and a keystroke
 * into an unknown pty says nothing about what runs in it.
 */
const knownPtys = new Set<string>();

/** Fallback bookkeeping for a markerless pty: the verdict its next quiet
 * window settles to ('needs-input' once a bell arrived, else "not busy") and
 * the timer arming it. Module-level so it survives observer re-subscribes
 * (tab changes, cross-window moves) - a still-armed timer firing after its
 * observer unmounted just settles the entry, which is exactly right. */
type FallbackState = {
  settleTo: TerminalBusyStatus | null;
  timer: ReturnType<typeof setTimeout> | null;
};
const fallbackPtys = new Map<string, FallbackState>();

function fallbackFor(ptyId: string): FallbackState {
  let state = fallbackPtys.get(ptyId);
  if (!state) {
    state = { settleTo: null, timer: null };
    fallbackPtys.set(ptyId, state);
  }
  return state;
}

function dropFallback(ptyId: string): void {
  const state = fallbackPtys.get(ptyId);
  if (state?.timer) clearTimeout(state.timer);
  fallbackPtys.delete(ptyId);
}

function setBusy(ptyId: string, status: TerminalTabState | null): void {
  if ((snapshot.get(ptyId) ?? null) === status) return;
  const next = new Map(snapshot);
  if (status) next.set(ptyId, status);
  else next.delete(ptyId);
  snapshot = next;
  listeners.forEach((l) => l());
}

function armSettle(ptyId: string, state: FallbackState): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(
    () => {
      state.timer = null;
      // A running tab going quiet has finished - keep the mark until the user
      // views the tab (the tab-level twin of the session's finished status).
      setBusy(ptyId, state.settleTo ?? (snapshot.get(ptyId) === 'running' ? 'finished' : null));
    },
    state.settleTo ? SETTLE_MS : IDLE_MS,
  );
}

/** This pty's current busy state, or null when it's safe to close silently -
 * a finished mark is not busy, so it reads as null here. */
export function getTerminalBusy(ptyId: string): TerminalBusyStatus | null {
  const state = snapshot.get(ptyId) ?? null;
  return state === 'finished' ? null : state;
}

/** The full tab state, finished mark included - what the strips' band shows. */
export function getTerminalTabState(ptyId: string): TerminalTabState | null {
  return snapshot.get(ptyId) ?? null;
}

/** Whether this renderer has any evidence about the pty at all - see `knownPtys`. */
export function isTerminalKnown(ptyId: string): boolean {
  return knownPtys.has(ptyId);
}

/** Be told whenever any pty's busy state changes. Returns an unsubscribe. */
export function subscribeTerminalBusy(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every marked pty, reactive - for the tab strips, which band each busy tab
 * and wash a finished one until it's viewed. */
export function useTerminalBusyMap(): ReadonlyMap<string, TerminalTabState> {
  return useSyncExternalStore(subscribeTerminalBusy, () => snapshot);
}

/** One pty's state, reactive (null for no pty, or one that's quiet). */
export function useTerminalBusy(ptyId: string | undefined): TerminalTabState | null {
  return useSyncExternalStore(subscribeTerminalBusy, () =>
    ptyId ? (snapshot.get(ptyId) ?? null) : null,
  );
}

/** A lifecycle marker's verdict for a marker-driven pty. Markers are the sole
 * authority for their pty, so any fallback bookkeeping is retired. */
export function setTerminalBusy(ptyId: string, status: TerminalBusyStatus | null): void {
  knownPtys.add(ptyId);
  dropFallback(ptyId);
  setBusy(ptyId, status);
}

/**
 * What main read off a marker-driven pty's stream before this renderer was
 * watching (`terminal:agentStatus`) - the state of a tab in a window that just
 * loaded or adopted it, which no marker will announce while the agent is
 * parked (on a background subagent, at a permission prompt). Older than
 * anything this renderer saw itself, so it only fills a gap: a pty with
 * evidence here keeps it, except a fallback guess (output read as work before
 * main's answer said the pty speaks markers), which it replaces.
 */
export function seedTerminalBusy(ptyId: string, status: TerminalBusyStatus | null): void {
  if (knownPtys.has(ptyId) && !fallbackPtys.has(ptyId)) return;
  knownPtys.add(ptyId);
  dropFallback(ptyId);
  setBusy(ptyId, status);
}

/** The agent in this pty stopped (its 'finished' marker): a tab that was busy
 * keeps the finished mark until the user views it; one that wasn't stays
 * unmarked - a stop the tab never announced has nothing left to announce. */
export function noteTerminalFinished(ptyId: string): void {
  knownPtys.add(ptyId);
  dropFallback(ptyId);
  if (snapshot.get(ptyId)) setBusy(ptyId, 'finished');
}

/** The agent (re)launched - 'ready': retire any stale busy state quietly, but
 * leave a finished mark for the user, exactly like the session status does. */
export function noteTerminalReady(ptyId: string): void {
  knownPtys.add(ptyId);
  dropFallback(ptyId);
  if (snapshot.get(ptyId) !== 'finished') setBusy(ptyId, null);
}

/** The user is looking at this tab (it is the visible tab of a pane in the
 * on-screen session of a focused window): a finished mark is now seen. */
export function markTerminalSeen(ptyId: string): void {
  if (snapshot.get(ptyId) === 'finished') setBusy(ptyId, null);
}

/** Genuine output on a markerless pty: running until the quiet window passes.
 * While a bell verdict is pending, output alone never clears it (a blocked TUI
 * repaints on plenty of non-answers) - it only re-arms the settle. */
export function noteTerminalOutput(ptyId: string): void {
  knownPtys.add(ptyId);
  const state = fallbackFor(ptyId);
  if (state.settleTo !== 'needs-input') setBusy(ptyId, 'running');
  armSettle(ptyId, state);
}

/** A real attention bell on a markerless pty: blocked on you once quiet. */
export function noteTerminalBell(ptyId: string): void {
  knownPtys.add(ptyId);
  const state = fallbackFor(ptyId);
  state.settleTo = 'needs-input';
  armSettle(ptyId, state);
}

/** A commit keystroke (the user answering) lifts needs-input optimistically -
 * for a marker-driven pty the agent's next marker confirms or re-marks; for a
 * markerless one the quiet window re-settles as usual. */
export function noteTerminalCommitKey(ptyId: string, markerDriven: boolean): void {
  if (snapshot.get(ptyId) !== 'needs-input') return;
  setBusy(ptyId, 'running');
  if (markerDriven) {
    dropFallback(ptyId);
    return;
  }
  const state = fallbackFor(ptyId);
  state.settleTo = null;
  armSettle(ptyId, state);
}

/** The user stopped the agent's turn (Esc / Ctrl+C in a marker-driven tab):
 * nothing runs any more and nothing finished - no mark to look at. */
export function noteTerminalInterrupted(ptyId: string): void {
  const status = snapshot.get(ptyId);
  if (status === 'running' || status === 'needs-input') setBusy(ptyId, null);
}

/** The pty's program is gone (shell exited, agent 'ended' back to the prompt,
 * its tab closed): nothing left to warn about - and known to be quiet. */
export function clearTerminalBusy(ptyId: string): void {
  knownPtys.add(ptyId);
  dropFallback(ptyId);
  setBusy(ptyId, null);
}

/** A busy shell tab, as the warning dialogs list them. */
export type BusyTab = { title: string; status: TerminalBusyStatus };

/** The busy shell tabs among `tabs`, in the given order. */
export function busyShellTabs(tabs: Tab[]): BusyTab[] {
  const out: BusyTab[] = [];
  for (const tab of tabs) {
    const status = tab.ptyId ? getTerminalBusy(tab.ptyId) : null;
    if (status) out.push({ title: tab.title, status });
  }
  return out;
}
