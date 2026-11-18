import { useSyncExternalStore } from 'react';

/**
 * A single shared clock for relative timestamps ("5m", "2h"). Without this,
 * `relativeShort(date)` is computed once at render and then frozen - a list of
 * ages would go stale until something else triggers a re-render.
 *
 * One module-level interval drives every subscriber (so N rows ≠ N timers); it
 * only runs while something is subscribed. Components call `useNow()` and pass
 * the value to `relativeShort(date, now)` to re-render on each tick.
 */
const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (timer === null) {
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time in ms, refreshed every 30s, shared across all subscribers. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
}
