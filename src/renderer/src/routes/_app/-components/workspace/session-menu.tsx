import {
  Archive,
  ArchiveRestore,
  ArrowLeftToLine,
  EllipsisVertical,
  ExternalLink,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { isSessionDirty } from '@renderer/lib/session/dirty';
import { OpenInEditorSubmenu } from '@renderer/routes/_app/-components/workspace/open-in-editor-menu';
import { SlotBoundary } from '@renderer/components/slot-boundary';
import { rendererExtension } from '@renderer/lib/extension/registry';
import { MENU_ITEM_CLASS as ITEM_CLASS } from '@renderer/routes/_app/-components/workspace/session-menu-style';

/** The per-session actions, shared by the kebab menu and the row context menu. */
interface SessionMenuProps {
  /** When given, deleting checks the session for unsaved editor changes first. */
  sessionId?: string;
  /** The session is open in a separate window: offer "bring back" instead of "open". */
  released: boolean;
  /** Whether the session is archived - flips the action between Archive/Unarchive. */
  archived: boolean;
  /** This session's folder (worktree or project dir) - the "Open in editor" target. */
  folderPath: string | null;
  /** Whether `folderPath` is a git worktree - only affects the submenu wording. */
  isWorktree: boolean;
  onOpenInWindow: () => void;
  onBringToWindow: () => void;
  /** Open the edit dialog (name, start command, terminal options). */
  onEdit: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
}

const MENU_CLASS = 'w-[210px] rounded-lg border-border-strong bg-surface-elevated p-1.5';
/** The menu items (design: `Menu/Session`), rendered inside either menu's content. */
function SessionMenuItems({
  sessionId,
  released,
  archived,
  folderPath,
  isWorktree,
  onOpenInWindow,
  onBringToWindow,
  onEdit,
  onToggleArchive,
  onDelete,
}: SessionMenuProps) {
  const MoveSessionItems = rendererExtension().hosts?.SessionMenuItems;
  // Deleting a session tears down its editors; if any of them have unsaved
  // changes (per the window-wide dirty registry), confirm the discard first.
  const handleDelete = async (): Promise<void> => {
    if (sessionId && isSessionDirty(sessionId)) {
      const ok = await confirmDialog({
        title: 'Delete session with unsaved changes?',
        description: 'This session has open files with unsaved changes that will be lost.',
        confirmLabel: 'Delete session',
        destructive: true,
      });
      if (!ok) return;
    }
    onDelete();
  };
  return (
    <>
      {released ? (
        <DropdownMenuItem onSelect={onBringToWindow} className={ITEM_CLASS}>
          <ArrowLeftToLine className="size-3.5 text-foreground-muted" />
          Bring to this window
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={onOpenInWindow} className={ITEM_CLASS}>
          <ExternalLink className="size-3.5 text-foreground-muted" />
          Open in separate window
        </DropdownMenuItem>
      )}
      <OpenInEditorSubmenu cwd={folderPath} isWorktree={isWorktree} />
      <DropdownMenuItem onSelect={onEdit} className={ITEM_CLASS}>
        <Pencil className="size-3.5 text-foreground-muted" />
        Edit session
      </DropdownMenuItem>
      {/* "Move to …" - the remote hosts' (Pro, a private plan › M7). */}
      {MoveSessionItems && sessionId && !archived && (
        <SlotBoundary name="session-menu-items">
          <MoveSessionItems sessionId={sessionId} />
        </SlotBoundary>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onToggleArchive} className={ITEM_CLASS}>
        {archived ? (
          <>
            <ArchiveRestore className="size-3.5 text-foreground-muted" />
            Unarchive session
          </>
        ) : (
          <>
            <Archive className="size-3.5 text-foreground-muted" />
            Archive session
          </>
        )}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        onSelect={() => void handleDelete()}
        className={ITEM_CLASS}
      >
        <Trash2 className="size-3.5" />
        Delete session
      </DropdownMenuItem>
    </>
  );
}

/**
 * Per-session kebab menu shown in the workspace sidebar (design: `Menu/Session`
 * + `Button/SessionKebab`). Offers tearing the session into its own window - or,
 * when it's already in one, bringing it back - plus deleting it.
 *
 * The trigger stops its own pointerdown from reaching the row so pressing it
 * never starts a session tear-off drag, and carries `data-row-action` so the
 * row's click handler ignores it (its portaled menu items are ignored too, as
 * they fall outside the row in the DOM).
 */
export function SessionMenu(props: SessionMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Session options"
          data-row-action
          onPointerDown={(e) => e.stopPropagation()}
          className="flex size-[22px] shrink-0 items-center justify-center rounded-sm text-foreground-muted outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted data-[state=open]:bg-muted data-[state=open]:text-foreground"
        >
          <EllipsisVertical className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className={MENU_CLASS}>
        <SessionMenuItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The same session menu, opened by right-clicking a sidebar row and anchored at
 * the pointer: a controlled dropdown whose trigger is an invisible fixed-position
 * point at the click coordinates. Mounted once per sidebar (not per row) - the
 * row's `onContextMenu` supplies the anchor.
 */
export function SessionContextMenu({
  anchor,
  onClose,
  ...actions
}: SessionMenuProps & {
  /** Viewport position to open at, or null while closed. */
  anchor: { x: number; y: number } | null;
  onClose: () => void;
}) {
  return (
    // Non-modal so right-clicking another row while open retargets the menu in
    // one action instead of merely dismissing it (modal blocks outside events).
    // Keyed by the anchor point: the popper measures its anchor only on open,
    // so a retarget must remount to reposition.
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
        className={MENU_CLASS}
      >
        <SessionMenuItems {...actions} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
