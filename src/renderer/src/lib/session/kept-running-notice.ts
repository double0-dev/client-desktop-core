import { useSyncExternalStore } from 'react';
import { getProjectScope } from '@renderer/lib/workspace/project-scope';

/**
 * The once-ever "N sessions kept running while double0 was closed" notice
 * (a private plan › Quit): the first launch after a quit that
 * left terminals to the session daemon tells the user so, with the way to
 * Settings › Sessions where the Keep-running switch lives. Main answers
 * `sessions:launchNotice` exactly once per machine (it flips the flag as it
 * replies), to the main window only; this store asks once per window, words
 * the answer and holds it until dismissed. The banner above the tab strip
 * (`workspace/kept-running-banner.tsx`) reads it - the update banner's pattern.
 */
export type KeptRunningCounts = {
  /** Distinct sessions the kept terminals belong to. */
  sessions: number;
  /** Every kept terminal. */
  terminals: number;
  /** Terminals no session could be found for (a loose shell tab whose layout is gone). */
  unmapped: number;
};

/**
 * The session a terminal id belongs to by its shape - the eager
 * `conversation:<id>` / `setup:<id>` shells and its shells outside the layout
 * (`commands:<id>:<key>`) - or null for a shell tab (a random id).
 */
export function sessionOfTerminalId(id: string): string | null {
  const m = /^(?:conversation|setup|commands):([^:]+)/.exec(id);
  return m ? m[1]! : null;
}

type LayoutRow = { sessionId: string; layout: unknown };

/** Shell-tab pty id → session id, read off the persisted layouts. */
function ptyOwners(layouts: ReadonlyArray<LayoutRow>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const row of layouts) {
    const tabs = (row.layout as { tabs?: unknown } | null)?.tabs;
    if (!tabs || typeof tabs !== 'object') continue;
    for (const tab of Object.values(tabs as Record<string, unknown>)) {
      const ptyId = (tab as { ptyId?: unknown } | null)?.ptyId;
      if (typeof ptyId === 'string' && ptyId) owners.set(ptyId, row.sessionId);
    }
  }
  return owners;
}

/** Count the kept terminals and the sessions they belong to (by id shape, then by layout). */
export function countKeptRunning(
  terminalIds: readonly string[],
  layouts: ReadonlyArray<LayoutRow> = [],
): KeptRunningCounts {
  const owners = ptyOwners(layouts);
  const sessions = new Set<string>();
  let unmapped = 0;
  for (const id of terminalIds) {
    const sessionId = sessionOfTerminalId(id) ?? owners.get(id) ?? null;
    if (sessionId) sessions.add(sessionId);
    else unmapped++;
  }
  return { sessions: sessions.size, terminals: terminalIds.length, unmapped };
}

/**
 * "3 sessions kept running while double0 was closed" - sessions when every
 * terminal maps to one, else the terminals themselves.
 */
export function keptRunningNoticeText(counts: KeptRunningCounts): string {
  if (counts.unmapped === 0 && counts.sessions > 0) {
    return `${counts.sessions} ${counts.sessions === 1 ? 'session' : 'sessions'} kept running while double0 was closed`;
  }
  return `${counts.terminals} ${counts.terminals === 1 ? 'terminal' : 'terminals'} kept running while double0 was closed`;
}

export type KeptRunningNotice = { text: string };

let notice: KeptRunningNotice | null = null;
let asked = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Ask main once per window; only the main window asks (a project window has a scope). */
async function ask(): Promise<void> {
  if (asked) return;
  asked = true;
  if (getProjectScope() != null) return;
  const sessions = window.api?.sessions;
  if (!sessions?.launchNotice) return;
  const answer = await sessions.launchNotice().catch(() => null);
  if (!answer || answer.terminalIds.length === 0) return;
  const layouts = await window.api?.layout?.list?.().catch(() => []);
  notice = { text: keptRunningNoticeText(countKeptRunning(answer.terminalIds, layouts ?? [])) };
  emit();
}

function subscribe(listener: () => void): () => void {
  void ask();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useKeptRunningNotice(): KeptRunningNotice | null {
  return useSyncExternalStore(
    subscribe,
    () => notice,
    () => null,
  );
}

/** Hide it - for good, main already counts it as shown. */
export function dismissKeptRunningNotice(): void {
  if (!notice) return;
  notice = null;
  emit();
}
