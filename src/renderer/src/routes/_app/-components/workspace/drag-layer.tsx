import { SquareTerminal } from 'lucide-react';
import { TearChip } from '@renderer/routes/_app/-components/workspace/tear-chip';
import type { DragState, DropTarget } from '@renderer/lib/workspace/use-tab-drag';
import type { PaneRect } from '@renderer/lib/workspace/use-pane-rects';
import type { Edge } from '@renderer/lib/workspace/layout';

/** The half of a pane a split would occupy, for the highlight. */
function splitBox(rect: PaneRect, edge: Edge): PaneRect {
  switch (edge) {
    case 'left':
      return { x: rect.x, y: rect.y, width: rect.width / 2, height: rect.height };
    case 'right':
      return { x: rect.x + rect.width / 2, y: rect.y, width: rect.width / 2, height: rect.height };
    case 'top':
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height / 2 };
    case 'bottom':
      return { x: rect.x, y: rect.y + rect.height / 2, width: rect.width, height: rect.height / 2 };
  }
}

/**
 * The drop indicator alone - a highlighted split half, a whole-pane highlight, or
 * a tab-strip insertion caret - positioned in the workspace body's coordinate
 * space. Used both by the local DragLayer and, on its own, by the destination of
 * a cross-window tab drag (which renders only the placeholder, no cursor chip).
 */
export function DropIndicator({ target }: { target: DropTarget | null }) {
  if (target?.kind === 'split' || target?.kind === 'pane') {
    const box = target.kind === 'split' ? splitBox(target.rect, target.edge) : target.rect;
    return (
      <div
        className="pointer-events-none absolute z-30 rounded-sm border-2 border-primary bg-primary/15 transition-all duration-75"
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      />
    );
  }
  if (target?.kind === 'strip') {
    return (
      <div
        className="pointer-events-none absolute z-30 bg-primary"
        style={{ left: target.caret.x - 1, top: target.caret.y, width: 2, height: target.caret.h }}
      />
    );
  }
  return null;
}

/**
 * Renders the live drag affordances: a drop indicator (a highlighted split half,
 * a whole-pane highlight, or a tab-strip insertion caret) positioned in the
 * workspace body's coordinate space, plus the floating tab chip that follows
 * the cursor (`TearChip`).
 */
export function DragLayer({ dragState }: { dragState: DragState | null }) {
  if (!dragState) return null;
  const { target, pointer, title, outside, overWindow } = dragState;

  return (
    <>
      {/* Marks a drag in progress: browser pages stop taking the pointer
          (globals.css), or the drag would freeze over them. */}
      <span data-tab-dragging hidden />
      {/* Strip targets show as the strip's own slide-apart gap (see
        pane-tab-strip.tsx), not a caret - the caret remains only for the
        cross-window preview, which renders DropIndicator directly. */}
      <DropIndicator target={target?.kind === 'strip' ? null : target} />
      <TearChip
        pointer={pointer}
        outside={outside}
        icon={<SquareTerminal className="size-3.5 text-primary" />}
        label={title}
        hint={overWindow ? 'move to window' : 'new window'}
      />
    </>
  );
}
