import { useCallback, useEffect, useRef } from 'react';

/**
 * Shared scaffolding for pointer-based tear-off drags (tab drag, session drag):
 * the threshold → move → outside-window → drop state machine, window listener
 * lifecycle, and unmount cleanup. The callers layer their own semantics on top -
 * in-window drop targeting for tabs, the click guard for session entries - via
 * the handler callbacks, which always see the gesture's mutable `data` object
 * (so they can carry per-gesture state like "was outside last move").
 */

/** Pointer travel (px) below which a press stays a click, not a drag. */
export const DRAG_THRESHOLD = 4;

/** Whether a viewport point falls beyond this window (a tear-off release). */
export function isOutsideWindow(cx: number, cy: number): boolean {
  return cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight;
}

type TearDragHandlers<T> = {
  /** Every pointermove once the threshold is crossed. `outside` is the raw window test. */
  onDragMove: (e: PointerEvent, data: T, outside: boolean) => void;
  /** Pointer released after a real drag (never fired for a plain click). */
  onDrop: (e: PointerEvent, data: T, outside: boolean) => void;
  /**
   * The gesture ended without a drop - `pointercancel` (the OS hijacked it) or
   * the hook unmounted mid-drag. Clear any preview state / cross-window IPC here;
   * `started` is false when the press never crossed the threshold.
   */
  onAbort?: (data: T, started: boolean) => void;
};

/**
 * Returns a `begin(event, data)` to call from the draggable element's
 * `pointerdown`. Listeners are attached per-gesture and are guaranteed to come
 * off again on pointerup, pointercancel, AND unmount - a component that unmounts
 * mid-drag leaves nothing behind on `window`.
 */
export function useTearDrag<T>(handlers: TearDragHandlers<T>): {
  begin: (e: React.PointerEvent, data: T) => void;
} {
  // Handlers are read through a ref so `begin` stays referentially stable and
  // per-gesture listeners never close over stale callbacks.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const gestureRef = useRef<{ data: T; startX: number; startY: number; started: boolean } | null>(
    null,
  );
  /** Removes the active gesture's window listeners; null when no gesture is live. */
  const teardownRef = useRef<(() => void) | null>(null);

  const begin = useCallback((e: React.PointerEvent, data: T) => {
    if (e.button !== 0) return;
    // A pointerdown while a gesture is somehow still live replaces it cleanly.
    teardownRef.current?.();
    gestureRef.current = { data, startX: e.clientX, startY: e.clientY, started: false };

    const onMove = (ev: PointerEvent): void => {
      const g = gestureRef.current;
      if (!g) return;
      if (!g.started) {
        if (Math.hypot(ev.clientX - g.startX, ev.clientY - g.startY) < DRAG_THRESHOLD) return;
        g.started = true;
      }
      handlersRef.current.onDragMove(ev, g.data, isOutsideWindow(ev.clientX, ev.clientY));
    };
    const onUp = (ev: PointerEvent): void => {
      teardownRef.current?.();
      const g = gestureRef.current;
      gestureRef.current = null;
      if (!g) return;
      if (ev.type === 'pointercancel') {
        handlersRef.current.onAbort?.(g.data, g.started);
        return;
      }
      if (!g.started) return; // a click, not a drag - nothing to drop
      handlersRef.current.onDrop(ev, g.data, isOutsideWindow(ev.clientX, ev.clientY));
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    teardownRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      teardownRef.current = null;
    };
  }, []);

  // Unmount mid-gesture: drop the window listeners and let the caller clean up
  // its own state (floating chip, cross-window preview) via onAbort.
  useEffect(
    () => () => {
      if (!teardownRef.current) return;
      teardownRef.current();
      const g = gestureRef.current;
      gestureRef.current = null;
      if (g) handlersRef.current.onAbort?.(g.data, g.started);
    },
    [],
  );

  return { begin };
}
