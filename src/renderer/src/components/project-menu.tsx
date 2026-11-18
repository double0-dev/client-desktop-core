import { ArrowLeftToLine, ExternalLink, SquarePen, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';

/**
 * The per-project menu (design: `Menu/Project`) on the Projects tool-window
 * row (right-click). Its first item uses the session menu's vocabulary: **Open in separate window**, or **Bring to this window** while
 * the project lives in a window of its own (a private plan).
 */

export const PROJECT_MENU_CLASS = 'w-52 rounded-lg border-border-strong bg-surface-elevated p-1.5';
export const PROJECT_MENU_ITEM_CLASS =
  'gap-2 rounded-sm px-2 py-1.5 text-[length:calc(13px*var(--ui-font-scale,1))]';

/** The first item alone: Open in separate window, or Bring to this window. */
export function ProjectWindowMenuItem({
  external,
  onOpenInWindow,
  onBringToWindow,
}: {
  /** The project is open in a separate window: offer "bring back" instead of "open". */
  external: boolean;
  onOpenInWindow: () => void;
  onBringToWindow: () => void;
}) {
  return external ? (
    <DropdownMenuItem onSelect={onBringToWindow} className={PROJECT_MENU_ITEM_CLASS}>
      <ArrowLeftToLine className="size-3.5 text-foreground-muted" />
      Bring to this window
    </DropdownMenuItem>
  ) : (
    <DropdownMenuItem onSelect={onOpenInWindow} className={PROJECT_MENU_ITEM_CLASS}>
      <ExternalLink className="size-3.5 text-foreground-muted" />
      Open in separate window
    </DropdownMenuItem>
  );
}

interface ProjectMenuProps {
  external: boolean;
  onOpenInWindow: () => void;
  onBringToWindow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** The full `Menu/Project`: the window item, Edit project, Delete project. */
export function ProjectMenuItems({
  external,
  onOpenInWindow,
  onBringToWindow,
  onEdit,
  onDelete,
}: ProjectMenuProps) {
  return (
    <>
      <ProjectWindowMenuItem
        external={external}
        onOpenInWindow={onOpenInWindow}
        onBringToWindow={onBringToWindow}
      />
      <DropdownMenuItem onSelect={onEdit} className={PROJECT_MENU_ITEM_CLASS}>
        <SquarePen className="size-3.5 text-foreground-muted" />
        Edit project
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        onSelect={onDelete}
        className={PROJECT_MENU_ITEM_CLASS}
      >
        <Trash2 className="size-3.5" />
        Delete project
      </DropdownMenuItem>
    </>
  );
}

/**
 * `Menu/Project` opened by right-clicking a Projects-panel row, anchored at the
 * pointer: a controlled dropdown whose trigger is an invisible fixed-position
 * point at the click coordinates (the session rows' context menu, mirrored).
 * Mounted once per panel - the row's `onContextMenu` supplies the anchor.
 */
export function ProjectContextMenu({
  anchor,
  onClose,
  ...actions
}: ProjectMenuProps & {
  /** Viewport position to open at, or null while closed. */
  anchor: { x: number; y: number } | null;
  onClose: () => void;
}) {
  return (
    // Non-modal so right-clicking another row while open retargets the menu in
    // one action instead of merely dismissing it. Keyed by the anchor point: the
    // popper measures its anchor only on open, so a retarget must remount.
    <DropdownMenu
      key={anchor ? `${anchor.x}:${anchor.y}` : 'closed'}
      modal={false}
      open={anchor != null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed size-0"
          style={{ left: anchor?.x ?? 0, top: anchor?.y ?? 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        // The anchor point can't take focus - leave focus where the user is.
        onCloseAutoFocus={(e) => e.preventDefault()}
        className={PROJECT_MENU_CLASS}
      >
        <ProjectMenuItems {...actions} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
