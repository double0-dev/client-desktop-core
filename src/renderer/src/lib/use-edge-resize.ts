import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

/**
 * Hand-rolled horizontal drag-resize for a sidebar's right edge (a pixel width -
 * the convention for sidebars, vs. the percentage panes inside them). Tracks the
 * pointer on `window` so the drag keeps working outside the thin handle, and
 * suppresses text selection / pins the col-resize cursor for the gesture.
 *
 * Unlike the inline versions it replaces, the gesture's teardown also runs on
 * unmount: a component removed mid-drag (session switch, layout change) can't
 * leak its window listeners or leave `document.body`'s userSelect/cursor stuck.
 */
export function useEdgeResize({
  min,
  max,
  invert = false,
  onResize,
}: {
  min: number;
  max: number;
  /** The handle sits on the element's LEFT edge (a right-anchored panel) -
   * dragging left grows it, so the pointer delta flips sign. */
  invert?: boolean;
  /** Called with the clamped width (px) on every pointer move. */
  onResize: (width: number) => void;
}): {
  /** Whether a drag is in progress (for highlighting the handle). */
  resizing: boolean;
  /** Wire to the handle's onPointerDown; `startWidth` is the width right now. */
  startResize: (e: ReactPointerEvent, startWidth: number) => void;
} {
  const [resizing, setResizing] = useState(false);

  // Fresh refs so a long-lived gesture never reads stale props.
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const boundsRef = useRef({ min, max, invert });
  boundsRef.current = { min, max, invert };

  // The active gesture's teardown - run on pointerup, a restarted gesture, or
  // unmount mid-drag.
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const startResize = useCallback((e: ReactPointerEvent, startWidth: number) => {
    e.preventDefault();
    cleanupRef.current?.();
    const startX = e.clientX;
    const onMove = (ev: globalThis.PointerEvent): void => {
      const bounds = boundsRef.current;
      const delta = bounds.invert ? startX - ev.clientX : ev.clientX - startX;
      onResizeRef.current(Math.min(bounds.max, Math.max(bounds.min, startWidth + delta)));
    };
    const cleanup = (): void => {
      cleanupRef.current = null;
      setResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
    };
    cleanupRef.current = cleanup;
    setResizing(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
  }, []);

  return { resizing, startResize };
}
