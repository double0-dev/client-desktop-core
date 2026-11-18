import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Bot, FolderTree, LayoutGrid, Play, Rows3, type LucideIcon } from 'lucide-react';
import { railTool, rendererExtension } from '@renderer/lib/extension/registry';
import { moveRailTab, useRailOrder, type RailSection } from '@renderer/lib/rail-order';
import {
  isExtensionRailTool,
  railTabAvailable,
  railToolAvailabilityHook,
  type DockStackPanelId,
  type RailTabId,
} from '@renderer/lib/workspace/dock-state';
import { useVerticalTabs } from '@renderer/lib/workspace/vertical-tabs';
import { cn } from '@renderer/lib/utils';

/**
 * The workspace's left icon rail. The dock panel ids/rules live in
 * lib/dock-state.ts: `tabs` (the vertical open-tabs panel) only shows while
 * the vertical-tabs setting is on; `files` toggles the file-explorer sidebar
 * in the editor content area (not the dock); an extension's tools are the
 * exclusive overlays (dock panel + content takeover) - one may show only for
 * some projects (`RendererExtension.useRailToolAvailability`).
 *
 * Render order (and the top/bottom cluster split) is the user's
 * (lib/rail-order.ts): drag an icon to reorder it, or drop it past the spacer
 * into the bottom cluster next to the Commands toggle. The drag is dnd-kit
 * sortable - neighbours slide apart to open the gap, a floating copy of the
 * icon follows the cursor, and the drop animates it into its slot.
 */

// The catalog - icon + label for every core tool the rail can toggle. An
// extension's tool brings its own through the renderer extension, and has no
// icon where it is absent.
type RailTabMeta = { icon: LucideIcon; label: string };
const RAIL_TABS: Record<DockStackPanelId | 'files', RailTabMeta> = {
  projects: { icon: LayoutGrid, label: 'Projects' },
  sessions: { icon: Bot, label: 'Sessions' },
  tabs: { icon: Rows3, label: 'Tabs' },
  files: { icon: FolderTree, label: 'Files' },
};

function railTabMeta(id: RailTabId): RailTabMeta | null {
  const tool = railTool(id);
  if (tool) return { icon: tool.icon, label: tool.label };
  return isExtensionRailTool(id) ? null : RAIL_TABS[id as DockStackPanelId | 'files'];
}

/**
 * The count bubble a rail tab hangs off the top-right of its icon (design:
 * `count` on the rail items). Zero renders nothing - a tab with nothing
 * pending stays a bare icon. Always the one-digit bubble's circle (user
 * decision 2026-09-25): a longer number shrinks its text instead of
 * stretching the bubble into a pill.
 */
export function RailCountBadge({
  count,
  label,
  tone = 'primary',
}: {
  count: number;
  label: string;
  /** `warning` = something waits on you (sessions needing input, say). */
  tone?: 'primary' | 'warning';
}) {
  if (count === 0) return null;
  const text = railCountText(count);
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        'absolute left-[18px] top-[2px] flex size-4 items-center justify-center rounded-full font-mono font-bold leading-none tracking-tighter',
        tone === 'warning' ? 'bg-warning text-black' : 'bg-primary text-primary-foreground',
        text.length === 1
          ? 'text-[length:calc(9px*var(--ui-font-scale,1))]'
          : text.length === 2
            ? 'text-[length:calc(8px*var(--ui-font-scale,1))]'
            : 'text-[length:calc(6px*var(--ui-font-scale,1))]',
      )}
    >
      {text}
    </span>
  );
}

/** What the count bubble prints: the number, capped at `99+`. */
function railCountText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * Running-agent count bubble on the rail's Sessions tab: how many of this
 * project's sessions are working right now ('active'). Sessions parked on a
 * question ('needs-input') are not counted - they get the OS notification and
 * the sidebar's amber dot instead; this bubble answers "how much is in
 * flight", which is what the tab is worth opening for.
 */
function SessionsRailBadge({ count }: { count: number }) {
  return (
    <RailCountBadge count={count} label={`${count} running session${count === 1 ? '' : 's'}`} />
  );
}

/**
 * One sortable rail icon. Three looks: accent = the focused exclusive tool,
 * background tile = a tool that's on but sitting behind an overlay, plain =
 * closed. While one icon is dragged, dnd-kit slides the others apart via the
 * transform; the source slot keeps a faint ghost.
 */
function RailIcon({
  id,
  section,
  on,
  suppressed,
  runningSessions,
  onActivate,
}: {
  id: RailTabId;
  section: RailSection;
  on: boolean;
  suppressed: boolean;
  runningSessions: number;
  onActivate: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  // The rail lists only available tools (railTabAvailable), so a Pro tool
  // with no registration never gets here - this is belt and braces.
  const meta = railTabMeta(id);
  if (!meta) return null;
  const { icon: Icon, label } = meta;
  const RailToolBadge = railTool(id)?.Badge;
  return (
    <button
      ref={setNodeRef}
      type="button"
      // dnd-kit's sortable attributes first - the real props (aria-pressed =
      // the tool's on state, not "being dragged") must win the spread.
      {...attributes}
      {...listeners}
      title={label}
      aria-label={label}
      aria-pressed={on}
      data-rail-reorder={id}
      data-rail-section={section}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={onActivate}
      className={cn(
        'relative flex size-9 items-center justify-center rounded-md transition-colors',
        suppressed
          ? 'bg-background text-foreground-muted hover:text-foreground'
          : on
            ? 'bg-accent text-primary'
            : 'text-foreground-muted hover:bg-muted hover:text-foreground',
        isDragging && 'opacity-30',
      )}
    >
      <Icon className="size-5" />
      {RailToolBadge && <RailToolBadge />}
      {id === 'sessions' && <SessionsRailBadge count={runningSessions} />}
    </button>
  );
}

/**
 * One cluster of sortable icons. The wrapper is itself a drop target so an
 * emptied cluster still accepts icons - min-h keeps a hit zone open (for the
 * bottom cluster: right above the Commands toggle).
 */
function RailCluster({
  section,
  ids,
  render,
}: {
  section: RailSection;
  ids: RailTabId[];
  render: (id: RailTabId, section: RailSection) => ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: section });
  return (
    <SortableContext id={section} items={ids} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className="flex min-h-9 w-full flex-col items-center gap-1">
        {ids.map((id) => render(id, section))}
      </div>
    </SortableContext>
  );
}

export function RailNav({
  dockPanels,
  openOverlay,
  explorerOpen,
  bottomPanelOpen,
  runningSessions,
  projectId,
  onToggleDock,
  onToggleBottomPanel,
}: {
  dockPanels: DockStackPanelId[];
  /** The extension tool whose overlay is up, if any. */
  openOverlay: string | null;
  explorerOpen: boolean;
  bottomPanelOpen: boolean;
  /** Sessions working right now in this project - the Sessions tab's bubble. */
  runningSessions: number;
  /** The project on screen - it decides which of the extension's tools exist. */
  projectId: string | null;
  onToggleDock: (id: RailTabId) => void;
  onToggleBottomPanel: () => void;
}) {
  const railOrder = useRailOrder();
  const verticalTabs = useVerticalTabs();
  const useRailToolAvailability = railToolAvailabilityHook();
  const availability = useRailToolAvailability(projectId);
  const overlayOpen = openOverlay !== null;

  // Live cluster contents (visible tools only) while a drag is in flight -
  // cross-cluster moves land here first so dnd-kit can animate the gap; null
  // outside a drag, where the store (filtered) is the source of truth.
  const [preview, setPreview] = useState<{ top: RailTabId[]; bottom: RailTabId[] } | null>(null);
  const [activeId, setActiveId] = useState<RailTabId | null>(null);
  // A real drag just happened - swallow the click that follows pointerup so
  // the drop doesn't also toggle the tool. Cleared on a macrotask: the ghost
  // click (if any) fires synchronously after pointerup, before the timeout.
  const draggedRef = useRef(false);

  const visible = (id: RailTabId): boolean => railTabAvailable(id, { verticalTabs, availability });
  const clusters = preview ?? {
    top: railOrder.top.filter(visible),
    bottom: railOrder.bottom.filter(visible),
  };
  /** Which cluster an id lives in - container ids ('top'/'bottom') are their own. */
  const sectionOf = (id: RailTabId | RailSection, c: typeof clusters): RailSection =>
    id === 'top' || id === 'bottom'
      ? (id as RailSection)
      : c.bottom.includes(id)
        ? 'bottom'
        : 'top';

  // 4px activation distance (the app-wide DRAG_THRESHOLD): a plain press
  // never starts a drag, so it stays a click → toggle.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragStart = ({ active }: DragStartEvent): void => {
    draggedRef.current = true;
    setActiveId(active.id as RailTabId);
    setPreview({ top: [...clusters.top], bottom: [...clusters.bottom] });
  };

  // Crossing the spacer: move the icon into the other cluster (before the icon
  // under the cursor, else at the end) so the gap opens over there. Same-
  // cluster sorting needs no state - dnd-kit previews it with transforms.
  const onDragOver = ({ active, over }: DragOverEvent): void => {
    if (!over) return;
    const id = active.id as RailTabId;
    const overId = over.id as RailTabId | RailSection;
    setPreview((prev) => {
      if (!prev) return prev;
      const from = sectionOf(id, prev);
      const to = sectionOf(overId, prev);
      if (from === to) return prev;
      const source = prev[from].filter((t) => t !== id);
      const target = [...prev[to]];
      const at = target.indexOf(overId as RailTabId);
      target.splice(at === -1 ? target.length : at, 0, id);
      return from === 'top' ? { top: source, bottom: target } : { top: target, bottom: source };
    });
  };

  const settle = (): void => {
    setActiveId(null);
    setPreview(null);
    setTimeout(() => {
      draggedRef.current = false;
    }, 0);
  };

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    const id = active.id as RailTabId;
    const p = preview;
    settle();
    if (!p) return;
    const section = sectionOf(id, p);
    let list = section === 'top' ? p.top : p.bottom;
    const overId = over?.id as RailTabId | RailSection | undefined;
    // A same-cluster drop lands in another icon's slot - mirror dnd-kit's
    // transform preview before reading off the committed position.
    if (overId && overId !== id && list.includes(overId as RailTabId)) {
      list = arrayMove(list, list.indexOf(id), list.indexOf(overId as RailTabId));
    }
    const at = list.indexOf(id);
    // Commit as "before this visible neighbour" so tools hidden by settings
    // or by the project (Tabs, an extension's gated tool) keep their stored slots.
    moveRailTab(id, section, at < list.length - 1 ? list[at + 1] : null);
  };

  const renderIcon = (id: RailTabId, section: RailSection): ReactNode => {
    const isOpenOverlay = id === openOverlay;
    const on = isExtensionRailTool(id)
      ? isOpenOverlay
      : id === 'files'
        ? explorerOpen
        : dockPanels.includes(id as DockStackPanelId);
    return (
      <RailIcon
        key={id}
        id={id}
        section={section}
        on={on}
        suppressed={on && overlayOpen && !isOpenOverlay}
        runningSessions={runningSessions}
        onActivate={() => {
          if (draggedRef.current) return;
          onToggleDock(id);
        }}
      />
    );
  };

  const ActiveIcon = activeId ? (railTabMeta(activeId)?.icon ?? null) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={settle}
    >
      <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2">
        <RailCluster section="top" ids={clusters.top} render={renderIcon} />
        <div className="min-h-0 flex-1" data-rail-spacer />
        <RailCluster section="bottom" ids={clusters.bottom} render={renderIcon} />
        {/* The bottom panel's toggle (the extension's). Below the spacer so it
          sits apart from the tool tabs, bottom-left; none without a panel. */}
        {rendererExtension().bottomPanel && (
          <button
            type="button"
            title="Commands"
            aria-label="Commands"
            aria-pressed={bottomPanelOpen}
            onClick={onToggleBottomPanel}
            className={cn(
              'flex size-9 items-center justify-center rounded-md transition-colors',
              bottomPanelOpen
                ? 'bg-accent text-primary'
                : 'text-foreground-muted hover:bg-muted hover:text-foreground',
            )}
          >
            <Play className="size-5" />
          </button>
        )}
      </nav>
      {/* The floating copy of the dragged icon; portalled so nothing clips it.
        dnd-kit animates it into the drop slot on release. */}
      {createPortal(
        <DragOverlay>
          {ActiveIcon && (
            <div className="flex size-9 scale-110 cursor-grabbing items-center justify-center rounded-md border border-border-strong bg-surface text-primary shadow-lg">
              <ActiveIcon className="size-5" />
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
