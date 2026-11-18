import type { ReactNode } from 'react';
import { Folder, GitBranch, SquareCode } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { editorLook, useInstalledEditors, type InstalledEditor } from '@renderer/lib/editors';
import { currentHostOfPath } from '@renderer/lib/hosts/host-of-path';
import { canOpenInIde } from '@renderer/lib/session/remote-capabilities';

/**
 * "Open in…" IDE launcher. `cwd` is the folder handed to the editor - a session's
 * worktree when it has one (`isWorktree`), else its project folder - so the editor
 * opens a new window on exactly that tree. Two entry points share the menu body:
 * a standalone dropdown (`OpenInEditorMenu`, for the pane tab strip) and a submenu
 * (`OpenInEditorSubmenu`, nested in the session kebab). Both render nothing when
 * there's no folder or no IDE is installed - and for a folder on a remote host
 * (an IDE's remote mode is Phase 3 of a private plan).
 */

/** The label + one row per installed IDE + a footer showing the target folder.
 * Rendered inside either a DropdownMenuContent or a DropdownMenuSubContent. */
function EditorMenuItems({
  editors,
  cwd,
  isWorktree,
}: {
  editors: InstalledEditor[];
  cwd: string;
  isWorktree: boolean;
}) {
  const tail = cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
  const FooterIcon = isWorktree ? GitBranch : Folder;
  return (
    <>
      <DropdownMenuLabel className="font-mono text-[10px] font-semibold tracking-[1px] text-foreground-subtle uppercase">
        {isWorktree ? 'Open worktree in' : 'Open folder in'}
      </DropdownMenuLabel>
      {editors.map((e) => {
        const look = editorLook(e.id);
        const Glyph = look.icon;
        return (
          <DropdownMenuItem
            key={e.id}
            onSelect={() => void window.api?.editors?.open(e.id, cwd)}
            className="gap-2.5"
          >
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-md"
              style={{ backgroundColor: look.tile }}
            >
              <Glyph className="size-3.5" style={{ color: look.fg }} />
            </span>
            <span className="flex-1 truncate font-medium text-foreground">{e.name}</span>
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuSeparator />
      <div className="flex items-center gap-1.5 px-2 py-1 text-foreground-muted">
        <FooterIcon className="size-3 shrink-0 text-foreground-subtle" />
        <span className="truncate font-mono text-[11px]">{tail}</span>
      </div>
    </>
  );
}

/** Standalone launcher: your `trigger` opens a dropdown of installed IDEs. */
export function OpenInEditorMenu({
  cwd,
  isWorktree,
  trigger,
  align = 'end',
}: {
  cwd: string | null;
  isWorktree: boolean;
  trigger: ReactNode;
  align?: 'start' | 'center' | 'end';
}) {
  const editors = useInstalledEditors();
  if (!cwd || editors.length === 0 || !canOpenInIde(currentHostOfPath(cwd))) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        <EditorMenuItems editors={editors} cwd={cwd} isWorktree={isWorktree} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Nested "Open in editor ▸" submenu - drop inside an open DropdownMenuContent
 * (e.g. the session kebab). Renders nothing when there's nothing to open. */
export function OpenInEditorSubmenu({
  cwd,
  isWorktree,
}: {
  cwd: string | null;
  isWorktree: boolean;
}) {
  const editors = useInstalledEditors();
  if (!cwd || editors.length === 0 || !canOpenInIde(currentHostOfPath(cwd))) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2 rounded-sm px-2 py-1.5 text-[length:calc(13px*var(--ui-font-scale,1))]">
        <SquareCode className="size-3.5 text-foreground-muted" />
        Open in editor
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
        <EditorMenuItems editors={editors} cwd={cwd} isWorktree={isWorktree} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
