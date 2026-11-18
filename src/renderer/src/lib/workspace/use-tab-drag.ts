import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject } from 'react';
import {
  getPane,
  isTearable,
  type Edge,
  type NodeId,
  type TabId,
  type WorkspaceLayout,
} from '@renderer/lib/workspace/layout';
import type { WorkspaceAction } from '@renderer/lib/workspace/reducer';
import type { PaneRect } from '@renderer/lib/workspace/use-pane-rects';
import type { TabDescriptor } from '@renderer/lib/transfer';
import { useTearDrag } from '@renderer/lib/workspace/use-tear-drag';
import { focusPooledTerminal } from '@renderer/lib/terminal/pool';

/**
 * A resolved drop location, carrying the geometry the drag layer needs to draw
 * its indicator (all coordinates are relative to the workspace body element).
 */
export type DropTarget =
  | { kind: 'split'; paneId: NodeId; edge: Edge; rect: PaneRect }
  | { kind: 'pane'; paneId: NodeId; rect: PaneRect }
  | { kind: 'strip'; paneId: NodeId; index: number; caret: { x: number; y: number; h: number } };

export type DragState = {
  tabId: TabId;
  title: string;
  /** The dragged tab's pre-drag width - the size of the gap the strips open. */
  tabWidth: number;
  /** Client (viewport) coords of the cursor - for the floating preview. */
  pointer: { x: number; y: number };
  target: DropTarget | null;
  /** Cursor is beyond this window → releasing tears the tab into its own window. */
  outside: boolean;
  /**
   * While tearing off, whether the cursor is over ANOTHER window (a merge, where
   * that window now shows a live drop preview) vs empty space (a new window).
   * Reported by main via `onDragOverAck`; drives the floating chip's wording.
   */
  overWindow: boolean;
};

/**
 * Fraction of the pane, per axis, that counts as an edge (split) zone: the outer
 * 30% of the width splits left/right, the outer 30% of the height top/bottom,
 * the middle 40% × 40% drops into the pane. Sized per axis, never capped - a
 * band taken from the shorter side and capped at 80px left a wide pane's right
 * split reachable only in its last 80px, right next to where the drag tears off.
 */
const EDGE_FRACTION = 0.3;
const EDGE_MIN = 24;

/**
 * Pure geometry hit-test: given a workspace body element, its measured pane
 * rects, and a window-client point, resolve the drop target (tab-strip caret,
 * whole pane, or split half) in the body's own coordinate space.
 *
 * Shared by the local drag controller (cursor inside this window) and the
 * cross-window drop preview (a point forwarded by main from another window that
 * is tearing a tab toward this one), so both compute an identical indicator.
 */
export function computeDropTarget(
  container: HTMLElement | null,
  rects: Map<NodeId, PaneRect>,
  cx: number,
  cy: number,
  /**
   * Per-gesture cache of each strip's tab rects, captured the first time the
   * gesture hit-tests that strip. A local drag slides the strip's tabs apart
   * (transforms) to preview the gap - hit-testing live rects would feed that
   * gap back into the index. The cross-window preview path passes nothing (its
   * strips never transform) and keeps using live rects.
   */
  stripRects?: Map<string, DOMRect[]>,
): DropTarget | null {
  if (!container) return null;
  const base = container.getBoundingClientRect();

  // 1) Tab strips take priority (reorder / move into pane).
  const strips = container.querySelectorAll<HTMLElement>('[data-strip-pane]');
  for (const strip of strips) {
    const sr = strip.getBoundingClientRect();
    if (sr.width === 0 || sr.height === 0) continue;
    if (cx >= sr.left && cx <= sr.right && cy >= sr.top && cy <= sr.bottom) {
      const paneId = strip.getAttribute('data-strip-pane')!;
      const tabEls = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]'));
      let tabRects = stripRects?.get(paneId);
      if (!tabRects) {
        tabRects = tabEls.map((el) => el.getBoundingClientRect());
        stripRects?.set(paneId, tabRects);
      }
      // Reading-order insertion index, row-aware: tabs on a row above the cursor
      // count as "before"; tabs on a row below stop the scan; within the cursor's
      // own row, the midpoint decides. Works for single- and multi-row strips.
      let index = 0;
      for (const r of tabRects) {
        if (r.bottom <= cy) {
          index++; // row entirely above the cursor
          continue;
        }
        if (r.top >= cy) break; // row entirely below the cursor
        if (cx >= r.left + r.width / 2)
          index++; // same row, cursor past the midpoint
        else break;
      }
      // Place the caret on the cursor's row where possible (the boundary tab, or
      // the trailing edge of the previous one), so it tracks the right row.
      const onCursorRow = (r: DOMRect): boolean => cy >= r.top && cy <= r.bottom;
      let caretX: number;
      let caretY: number;
      let caretH: number;
      const atRect = index < tabRects.length ? tabRects[index] : null;
      const prevRect = index > 0 ? tabRects[index - 1] : null;
      if (atRect && (onCursorRow(atRect) || !prevRect)) {
        caretX = atRect.left - base.left;
        caretY = atRect.top - base.top;
        caretH = atRect.height;
      } else if (prevRect) {
        caretX = prevRect.right - base.left;
        caretY = prevRect.top - base.top;
        caretH = prevRect.height;
      } else {
        // No tabs at all - caret at the strip's leading edge, one row tall.
        caretX = sr.left - base.left;
        caretY = sr.top - base.top;
        caretH = Math.min(sr.height, 36);
      }
      return { kind: 'strip', paneId, index, caret: { x: caretX, y: caretY, h: caretH } };
    }
  }

  // 2) Pane bodies: 5-zone split / move-into-pane.
  const bx = cx - base.left;
  const by = cy - base.top;
  for (const [paneId, rect] of rects) {
    if (bx < rect.x || bx > rect.x + rect.width || by < rect.y || by > rect.y + rect.height)
      continue;
    const lx = bx - rect.x;
    const ly = by - rect.y;
    const bandX = Math.max(rect.width * EDGE_FRACTION, EDGE_MIN);
    const bandY = Math.max(rect.height * EDGE_FRACTION, EDGE_MIN);
    // Each distance in units of its own axis' band (< 1 = inside that band), so
    // the nearest edge in a corner is judged proportionally on a non-square pane.
    const dLeft = lx / bandX;
    const dRight = (rect.width - lx) / bandX;
    const dTop = ly / bandY;
    const dBottom = (rect.height - ly) / bandY;
    const min = Math.min(dLeft, dRight, dTop, dBottom);
    if (min >= 1) return { kind: 'pane', paneId, rect };
    let edge: Edge;
    if (min === dLeft) edge = 'left';
    else if (min === dRight) edge = 'right';
    else if (min === dTop) edge = 'top';
    else edge = 'bottom';
    return { kind: 'split', paneId, edge, rect };
  }
  return null;
}

/** Per-gesture state carried through the shared tear-drag scaffolding. */
type TabDragData = {
  tabId: TabId;
  title: string;
  /** The tab element's width at gesture start - the gap the strips open. */
  tabWidth: number;
  /** Whether this tab may be torn off into another window (only terminals can). */
  tearable: boolean;
  /** Was the cursor outside this window on the previous move? (edge transitions) */
  wasOutside: boolean;
};

/**
 * Pointer-based tab drag controller. Hit-testing is pure geometry against the
 * measured pane rects + the strip DOM (scoped to this session's container), so
 * it never depends on `elementFromPoint` (which would land on the terminal
 * overlay). Returns a `pointerdown` handler for tabs and the live drag state for
 * the drag layer to render. Built on `useTearDrag`, which owns the threshold /
 * listener lifecycle (including unmount-mid-drag cleanup).
 */
export function useTabDrag({
  containerRef,
  rects,
  layout,
  dispatch,
  cwd,
}: {
  containerRef: RefObject<HTMLElement | null>;
  rects: Map<NodeId, PaneRect>;
  layout: WorkspaceLayout;
  dispatch: Dispatch<WorkspaceAction>;
  /** Working dir to seed a torn-off terminal's new window (Phase B). */
  cwd?: string | null;
}) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  /** Latest "cursor is over another window" flag from main, for the chip wording. */
  const overWindowRef = useRef(false);

  // Fresh refs so the gesture listeners never read stale geometry.
  const rectsRef = useRef(rects);
  rectsRef.current = rects;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  // Gesture-start strip geometry (see computeDropTarget's stripRects param);
  // reset when a new gesture begins.
  const stripRectsRef = useRef(new Map<string, DOMRect[]>());
  const computeTarget = useCallback(
    (cx: number, cy: number): DropTarget | null =>
      computeDropTarget(containerRef.current, rectsRef.current, cx, cy, stripRectsRef.current),
    [containerRef],
  );

  // `tab:dragOver` pings main on every move while outside the window; coalesce
  // them to at most one IPC per animation frame (latest descriptor wins). Any
  // pending ping is cancelled on drop/abort/re-entry so a stale dragOver can
  // never fire after the matching dragEnd and resurrect the remote preview.
  const dragOverRafRef = useRef(0);
  const pendingDragOverRef = useRef<TabDescriptor | null>(null);
  const scheduleDragOver = useCallback((descriptor: TabDescriptor) => {
    pendingDragOverRef.current = descriptor;
    if (dragOverRafRef.current) return;
    dragOverRafRef.current = requestAnimationFrame(() => {
      dragOverRafRef.current = 0;
      const pending = pendingDragOverRef.current;
      pendingDragOverRef.current = null;
      if (pending) window.api?.tab?.dragOver(pending);
    });
  }, []);
  const cancelPendingDragOver = useCallback(() => {
    cancelAnimationFrame(dragOverRafRef.current);
    dragOverRafRef.current = 0;
    pendingDragOverRef.current = null;
  }, []);

  /** Clear the floating chip and any cross-window preview the gesture created. */
  const clearGestureEffects = useCallback(
    (d: TabDragData) => {
      setDragState(null);
      cancelPendingDragOver();
      // Tear down any cross-window preview the destination may be showing.
      if (d.wasOutside) window.api?.tab?.dragEnd();
      overWindowRef.current = false;
    },
    [cancelPendingDragOver],
  );

  const { begin } = useTearDrag<TabDragData>({
    onDragMove: (e, d, rawOutside) => {
      // Only tearable tabs tear off, so only they show the cross-window affordance
      // (the conversation tab and editor tabs stay put when dragged past the edge).
      const outside = d.tearable && rawOutside;
      // While over ANOTHER window, ask main to draw a live drop preview there (the
      // same indicator a split shows, but rendered in the destination). Main reads
      // the cursor's screen point itself - we only ping with the descriptor - and
      // acks whether we're over a window so the chip can say "move" vs "new window".
      if (d.tearable) {
        if (outside) {
          const tab = layoutRef.current.tabs[d.tabId];
          if (tab?.ptyId) {
            scheduleDragOver({
              kind: 'terminal',
              termId: tab.ptyId,
              title: tab.title,
              cwd: cwdRef.current ?? null,
            });
          }
        } else if (d.wasOutside) {
          // Re-entered our own window → clear the other window's stale preview.
          cancelPendingDragOver();
          window.api?.tab?.dragEnd();
          overWindowRef.current = false;
        }
        d.wasOutside = outside;
      }
      setDragState({
        tabId: d.tabId,
        title: d.title,
        tabWidth: d.tabWidth,
        pointer: { x: e.clientX, y: e.clientY },
        target: outside ? null : computeTarget(e.clientX, e.clientY),
        outside,
        overWindow: outside ? overWindowRef.current : false,
      });
    },
    onDrop: (e, d, rawOutside) => {
      clearGestureEffects(d);

      // Released beyond this window → tear the tab off. Main hit-tests the screen
      // point: over another window it merges in, over the desktop it opens a new
      // window. We keep the tab until main replies `tab:removed` (which keeps the
      // shell alive). The conversation tab is pinned to its session - never torn.
      if (d.tearable && rawOutside) {
        const tab = layoutRef.current.tabs[d.tabId];
        if (tab?.ptyId) {
          window.api?.tab?.dropExternal({
            kind: 'terminal',
            termId: tab.ptyId,
            title: tab.title,
            cwd: cwdRef.current ?? null,
          });
        }
        return;
      }

      const target = computeTarget(e.clientX, e.clientY);
      if (!target) return;
      if (target.kind === 'split') {
        // Node ids are minted here, dispatch-side, to keep the reducer pure.
        dispatch({
          type: 'split',
          targetPaneId: target.paneId,
          edge: target.edge,
          tabId: d.tabId,
          newPaneId: crypto.randomUUID(),
          splitId: crypto.randomUUID(),
        });
      } else if (target.kind === 'strip') {
        dispatch({ type: 'moveTab', tabId: d.tabId, toPaneId: target.paneId, index: target.index });
      } else {
        const length = getPane(layoutRef.current, target.paneId)?.tabs.length ?? 0;
        dispatch({ type: 'moveTab', tabId: d.tabId, toPaneId: target.paneId, index: length });
      }
      // Grabbing the tab blurred the terminal, and after a reorder/move the
      // active flag often doesn't change, so TerminalView's focus effect won't
      // re-run. Put the caret back explicitly once the drop has committed.
      const ptyId = layoutRef.current.tabs[d.tabId]?.ptyId;
      if (ptyId) requestAnimationFrame(() => focusPooledTerminal(ptyId));
    },
    // pointercancel (e.g. the OS hijacked the gesture) or unmount mid-drag must
    // not commit a drop - just clear the chip and any cross-window preview.
    onAbort: (d) => clearGestureEffects(d),
  });

  const onTabPointerDown = useCallback(
    (e: React.PointerEvent, tabId: TabId) => {
      const tab = layoutRef.current.tabs[tabId];
      if (!tab) return;
      overWindowRef.current = false;
      stripRectsRef.current = new Map();
      // The tab's width now, before the drag collapses it - sizes the gap the
      // hovered strip opens.
      const tabWidth =
        containerRef.current
          ?.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`)
          ?.getBoundingClientRect().width ?? 120;
      begin(e, { tabId, title: tab.title, tabWidth, tearable: isTearable(tab), wasOutside: false });
    },
    [begin, containerRef],
  );

  // Main acks every drag-over with whether the cursor is over another window, so
  // the floating chip reads "move here" vs "new window" mid-tear-off.
  useEffect(
    () =>
      window.api?.tab?.onDragOverAck((overWindow) => {
        overWindowRef.current = overWindow;
        setDragState((s) => (s ? { ...s, overWindow } : s));
      }),
    [],
  );

  return { onTabPointerDown, dragState };
}
