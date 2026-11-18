import { useCallback, useRef, useState } from 'react';
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { DRAG_THRESHOLD, isOutsideWindow } from '@renderer/lib/workspace/use-tear-drag';

/**
 * Behavior half of a dnd-kit sortable list (the app-wide drag look: neighbours
 * slide apart, a DragOverlay ghost, animated settle). Pairs with the
 * `Sortable` render-prop (components/ui/sortable.tsx); the caller renders its
 * own DndContext/SortableContext/DragOverlay and spreads `handlers` onto the
 * DndContext. Centralised here: the pointer sensor + activation threshold, the
 * ghost-click guard, the drop → insertion-index conversion every persister in
 * the app expects, and (opt-in) outside-the-window tracking for tear-off
 * gestures.
 */

type SortableListOptions = {
  /** The displayed order the drag runs over (top→bottom / reading order). */
  items: string[];
  /**
   * Persist a reorder: place `id` at `targetIndex` (0 = first, list length =
   * last; the index counts the dragged item itself) - the same semantics as
   * `reorderProject` / `reorderSession`.
   */
  onReorder: (id: string, targetIndex: number) => void;
  /**
   * Tear-off half (sessions): the drag tracks whether the cursor is beyond the
   * window, and an outside release calls this instead of reordering.
   */
  onDropOutside?: (id: string) => void;
};

export function useSortableList(options: SortableListOptions) {
  /** The item being dragged; null outside a drag. */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Cursor is beyond the window (only ever true with `onDropOutside`). */
  const [outside, setOutside] = useState(false);
  // Set for the whole drag so the click that follows pointerup (which would
  // activate the item) is swallowed; cleared on a macrotask - the ghost click
  // (if any) fires synchronously after pointerup, before the timeout runs.
  const draggedRef = useRef(false);
  const outsideRef = useRef(false);
  // Read options through a ref so the handlers never close over stale values.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const settle = useCallback((): void => {
    setActiveId(null);
    setOutside(false);
    outsideRef.current = false;
    setTimeout(() => {
      draggedRef.current = false;
    }, 0);
  }, []);

  const onDragStart = useCallback(({ active }: DragStartEvent): void => {
    draggedRef.current = true;
    setActiveId(active.id as string);
  }, []);

  // dnd-kit reports the drag as activator + delta, not a live pointer - derive
  // the cursor and check it against the window for the tear-off affordance.
  const onDragMove = useCallback(({ activatorEvent, delta }: DragMoveEvent): void => {
    if (!optionsRef.current.onDropOutside) return;
    const activator = activatorEvent as PointerEvent;
    if (typeof activator.clientX !== 'number') return;
    const out = isOutsideWindow(activator.clientX + delta.x, activator.clientY + delta.y);
    outsideRef.current = out;
    setOutside(out);
  }, []);

  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent): void => {
      const id = active.id as string;
      const wasOutside = outsideRef.current;
      settle();
      const { items, onReorder, onDropOutside } = optionsRef.current;
      if (wasOutside && onDropOutside) {
        onDropOutside(id);
        return;
      }
      if (!over || over.id === id) return;
      const from = items.indexOf(id);
      const to = items.indexOf(over.id as string);
      if (from === -1 || to === -1) return;
      // dnd-kit gives "landed in this item's slot" (arrayMove semantics); the
      // persisters take an insertion index that counts the dragged item.
      onReorder(id, to > from ? to + 1 : to);
    },
    [settle],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_THRESHOLD } }),
  );

  /** Whether a drag just happened - call from the item's onClick to skip activation. */
  const consumeDragClick = useCallback((): boolean => draggedRef.current, []);

  return {
    sensors,
    activeId,
    outside,
    /** Spread onto the DndContext. */
    handlers: { onDragStart, onDragMove, onDragEnd, onDragCancel: settle },
    consumeDragClick,
  };
}
