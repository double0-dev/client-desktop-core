import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { NodeId } from '@renderer/lib/workspace/layout';

export type PaneRect = { x: number; y: number; width: number; height: number };

type RegisterPane = (paneId: NodeId) => (el: HTMLElement | null) => void;

export type PaneRects = {
  /** Returns a stable ref callback to attach to a pane's content slot. */
  registerPane: RegisterPane;
  /** Latest measured rects, relative to the container element, in whole CSS pixels. */
  rects: Map<NodeId, PaneRect>;
  /** Bumps whenever any rect changes - feed to the terminal layer to reposition. */
  version: number;
  /** Force a re-measure (e.g. after a layout change that moved panes). */
  remeasure: () => void;
};

/**
 * Measures every registered pane content slot relative to `containerRef`, using
 * a single shared ResizeObserver: a resize of the container itself is
 * measured before that frame paints, a slot's coalesced to the next frame.
 *
 * This is the seam between the geometry layer (which owns the slots) and the
 * terminal layer (which positions absolutely-placed terminals over them). Flow
 * is strictly one-way - slot size → rect → terminal position - so it can never
 * feed back into a ResizeObserver loop.
 */
export function usePaneRects(
  containerRef: RefObject<HTMLElement | null>,
  /**
   * The layout's node ids, sorted and comma-joined. Changes whenever the set of
   * panes changes, triggering a synchronous re-measure; its ids are also what
   * cached per-pane state is pruned against when panes leave the layout.
   */
  structuralKey: string,
): PaneRects {
  const rectsRef = useRef<Map<NodeId, PaneRect>>(new Map());
  const slotsRef = useRef<Map<NodeId, HTMLElement>>(new Map());
  const refCbRef = useRef<Map<NodeId, (el: HTMLElement | null) => void>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef(0);
  const [version, setVersion] = useState(0);

  /**
   * `commit: 'now'` renders the new rects before returning (flushSync) - from
   * outside React only (the observer, a frame callback): the terminals then
   * move in the frame the layout changed, not one or two frames after it.
   * Inside React's own commit (the layout effects) a plain update is already
   * synchronous.
   */
  const measure = useCallback(
    (commit: 'now' | 'react' = 'react') => {
      const container = containerRef.current;
      if (!container) return;
      const base = container.getBoundingClientRect();
      // A hidden session's view (display:none - WorkspaceHost keeps inactive
      // sessions mounted) measures 0×0: skip the pass so the last real geometry
      // survives being hidden. Without this, revisiting the session paints its
      // first frame with every terminal at a zeroed rect (a visible blink) until
      // the observer re-measures; re-showing fires the observer again, so any
      // resize that happened while hidden is still caught.
      if (base.width === 0 && base.height === 0) return;
      const next = new Map<NodeId, PaneRect>();
      let changed = slotsRef.current.size !== rectsRef.current.size;
      slotsRef.current.forEach((el, id) => {
        const r = el.getBoundingClientRect();
        // Snap to whole CSS pixels. Split panes are percentage-sized, so every
        // pane after the first lands on a fractional offset - and a terminal's
        // WebGL canvas placed at a fractional position gets resampled by the
        // compositor into visibly blurred text (only the first pane, at x=0,
        // stayed crisp). Snap the EDGES (not x + width independently) so two
        // panes sharing a divider round to the same seam - no overlap, no gap.
        const left = Math.round(r.left - base.left);
        const top = Math.round(r.top - base.top);
        const rect: PaneRect = {
          x: left,
          y: top,
          width: Math.round(r.right - base.left) - left,
          height: Math.round(r.bottom - base.top) - top,
        };
        const prev = rectsRef.current.get(id);
        if (
          !prev ||
          prev.x !== rect.x ||
          prev.y !== rect.y ||
          prev.width !== rect.width ||
          prev.height !== rect.height
        ) {
          next.set(id, rect);
          changed = true;
        } else {
          // Unchanged rects keep their object identity, so consumers keyed on a
          // pane's rect (the memoized terminal slots) skip re-rendering when only
          // some other pane moved.
          next.set(id, prev);
        }
      });
      if (changed) {
        rectsRef.current = next;
        if (commit === 'now') flushSync(() => setVersion((v) => v + 1));
        else setVersion((v) => v + 1);
      }
    },
    [containerRef],
  );

  const scheduleMeasure = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => measure('now'));
  }, [measure]);

  const getObserver = useCallback((): ResizeObserver => {
    if (!observerRef.current) {
      observerRef.current = new ResizeObserver((entries) => {
        // The body itself changed size (a dock or the explorer toggled, the
        // window resized): measure and commit right here, before the browser
        // paints - otherwise that frame (and the next) showed each terminal at
        // its old size, clipped under the panel's edge. The terminal views'
        // own observers sit deeper in the tree, so they still hear the new
        // size in this same frame. Slot-only changes (a divider drag) wait
        // for the next frame, so a drag's flurry is measured once per frame.
        if (entries.some((entry) => entry.target === containerRef.current)) {
          cancelAnimationFrame(rafRef.current);
          measure('now');
        } else {
          scheduleMeasure();
        }
      });
      const container = containerRef.current;
      if (container) observerRef.current.observe(container);
    }
    return observerRef.current;
  }, [containerRef, measure, scheduleMeasure]);

  const registerPane = useCallback<RegisterPane>(
    (paneId) => {
      let cb = refCbRef.current.get(paneId);
      if (!cb) {
        cb = (el: HTMLElement | null) => {
          const observer = getObserver();
          const prev = slotsRef.current.get(paneId);
          // Covers replacement AND detach (el === null): the outgoing element is
          // unobserved, so the observer never accumulates nodes that left the DOM.
          if (prev && prev !== el) observer.unobserve(prev);
          if (el) {
            slotsRef.current.set(paneId, el);
            observer.observe(el);
          } else {
            // Keep the cached callback so its identity stays stable across
            // re-renders (deleting it would make React detach/attach the ref
            // every render - stale entries are pruned off `structuralKey`
            // instead). Just stop tracking the slot.
            slotsRef.current.delete(paneId);
          }
          scheduleMeasure();
        };
        refCbRef.current.set(paneId, cb);
      }
      return cb;
    },
    [getObserver, scheduleMeasure],
  );

  // Runs after mount, when the container ref is set (React assigns child refs
  // before parent refs, so a slot's ref can fire before the container's). Observe
  // the container for window/layout resizes, and measure SYNCHRONOUSLY before
  // paint (useLayoutEffect, not RAF) so the active terminal isn't briefly hidden
  // - which would make the first focus silently fail.
  useLayoutEffect(() => {
    const observer = getObserver();
    const container = containerRef.current;
    if (container) observer.observe(container);
    measure();
    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      observerRef.current = null;
    };
  }, [getObserver, measure, containerRef]);

  // After a structural change (split / collapse), the new pane's slot is in the
  // DOM and react-resizable-panels has applied its flex sizes (descendant layout
  // effects run before this ancestor's). Measure SYNCHRONOUSLY, before paint, so
  // the split-off pane's terminal is sized - never transiently hidden - when the
  // focus effects run. Without this the new terminal is hidden for a frame and
  // focus silently fails (the post-split "can't type").
  useLayoutEffect(() => {
    // Also prune cached ref callbacks for panes that left the layout - the slot's
    // null call keeps them (see registerPane), so without this the map would grow
    // for as long as the session keeps splitting and collapsing panes.
    const live = new Set(structuralKey.split(','));
    refCbRef.current.forEach((_, paneId) => {
      if (!live.has(paneId)) refCbRef.current.delete(paneId);
    });
    measure();
  }, [structuralKey, measure]);

  return { registerPane, rects: rectsRef.current, version, remeasure: scheduleMeasure };
}
