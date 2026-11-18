import { useSyncExternalStore } from 'react';
import { disposePooledTerminal, getPooledTerminal } from '@renderer/lib/terminal/pool';

/**
 * Remote terminals whose host cannot be reached right now
 * (a private plan › 9.4), fed by main's
 * `terminal:unreachable` / `terminal:reachable`. The tab keeps its xterm (the
 * last screen) under an overlay - a shell on a host is never shown as exited
 * because the network went.
 *
 * When the host is back, the tab's xterm missed everything in between: each
 * terminal's re-attach generation is bumped, and the TerminalView mounted for
 * it rebuilds its xterm, whose next create replays the host's ring. A terminal
 * with no view mounted just loses its pooled xterm, so its next mount starts
 * fresh and replays the same way. Local terminals never get these events.
 *
 * The same rebuild serves a local terminal main moved off an older build's
 * session daemon (`terminal:relaunch`, src/main/daemon-migrate.ts): its shell
 * is gone, so the next create finds nothing to adopt and starts it fresh on
 * this build's daemon, where the agent resumes its conversation.
 */
export type Unreachable = { hostId: string; since: number };

let away: Record<string, Unreachable> = {};
let generations: Record<string, number> = {};
const listeners = new Set<() => void>();
/** How many TerminalViews show each pty right now. */
const mounted = new Map<string, number>();

function emit(): void {
  for (const l of listeners) l();
}

export function markUnreachable(id: string, hostId: string, since: number): void {
  if (away[id]?.hostId === hostId) return;
  away = { ...away, [id]: { hostId, since } };
  emit();
}

export function markReachable(id: string): void {
  const { [id]: _gone, ...rest } = away;
  void _gone;
  away = rest;
  generations = { ...generations, [id]: (generations[id] ?? 0) + 1 };
  // Nobody shows it: drop the stale xterm so the next mount replays.
  if (!mounted.get(id) && getPooledTerminal(id)) disposePooledTerminal(id, false);
  emit();
}

/** Main ended `id` on an older daemon: its tab starts it again (see the file comment). */
export function markRelaunched(id: string): void {
  generations = { ...generations, [id]: (generations[id] ?? 0) + 1 };
  if (!mounted.get(id) && getPooledTerminal(id)) disposePooledTerminal(id, false);
  emit();
}

/** A TerminalView showing `id` mounted; returns the unmount. */
export function noteTerminalViewMounted(id: string): () => void {
  mounted.set(id, (mounted.get(id) ?? 0) + 1);
  return () => {
    const n = (mounted.get(id) ?? 1) - 1;
    if (n <= 0) mounted.delete(id);
    else mounted.set(id, n);
  };
}

let started = false;
/** Subscribe to main once per window (idempotent). */
export function startUnreachableFeed(): void {
  if (started || typeof window === 'undefined' || !window.api?.terminal?.onUnreachable) return;
  started = true;
  window.api.terminal.onUnreachable(({ id, hostId, since }) => markUnreachable(id, hostId, since));
  window.api.terminal.onReachable((id) => markReachable(id));
  window.api.terminal.onRelaunch?.((id) => markRelaunched(id));
}

function subscribe(listener: () => void): () => void {
  startUnreachableFeed();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUnreachable(id: string): Unreachable | null {
  return away[id] ?? null;
}

export function getReattachGeneration(id: string): number {
  return generations[id] ?? 0;
}

export function useTerminalUnreachable(id: string): Unreachable | null {
  return useSyncExternalStore(subscribe, () => away[id] ?? null);
}

export function useReattachGeneration(id: string): number {
  return useSyncExternalStore(subscribe, () => generations[id] ?? 0);
}

/** Every unreachable terminal, for the banner. */
export function useUnreachableTerminals(): Record<string, Unreachable> {
  return useSyncExternalStore(subscribe, () => away);
}

/** Tests. */
export function resetUnreachableForTest(): void {
  away = {};
  generations = {};
  mounted.clear();
  started = false;
  listeners.clear();
}
