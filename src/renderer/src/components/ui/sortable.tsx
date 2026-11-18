import type { CSSProperties, ReactNode, Ref } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * Render-prop wrapper around dnd-kit's `useSortable`, so a list can make its
 * existing item markup sortable without extracting a component per item type.
 * Apply `ref` + `style` to the item's root element and spread `handleProps`
 * on whatever should start the drag (usually the same root).
 *
 * Spread `handleProps` BEFORE your own attributes: dnd-kit's include their own
 * `role`/`tabIndex`/`aria-pressed`, and yours must win where they overlap.
 * `isDragging` marks the source item - dim it to a ghost while the
 * `DragOverlay` copy rides the cursor.
 */
export function Sortable({
  id,
  disabled,
  children,
}: {
  id: string;
  /** Not draggable and not a drop target (still renders, never shifts). */
  disabled?: boolean;
  children: (item: {
    ref: Ref<HTMLElement | null>;
    style: CSSProperties;
    handleProps: Record<string, unknown>;
    isDragging: boolean;
  }) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  return children({
    ref: setNodeRef,
    style: { transform: CSS.Transform.toString(transform), transition },
    handleProps: { ...attributes, ...listeners },
    isDragging,
  });
}
