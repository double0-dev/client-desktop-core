import { useRef, useState } from 'react';
import { presentImperative } from '@renderer/lib/imperative-root';
import { FolderGit2, GitBranch, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { BusyTabsCard } from '@renderer/components/busy-tabs-dialog';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@renderer/components/ui/dialog';
import type { BusyTab } from '@renderer/lib/terminal/busy';
import { cn } from '@renderer/lib/utils';

/**
 * Imperative confirmation for deleting a session that's backed by a git worktree
 * (design: `Screen/Delete Session Dialog - Worktree`). Warns about the worktree,
 * and lets the user opt out of removing the worktree folder and deleting its
 * branch (both default on: the branch was created for the session, so it goes
 * with it). Resolves with the chosen cleanup, or `null` if the user
 * cancelled/dismissed. Mounts a one-off root like `confirmDialog`.
 *
 *   const choice = await confirmWorktreeSessionDelete({ worktreePath, branch });
 *   if (!choice) return; // cancelled
 */
export type WorktreeDeleteChoice = {
  /** Remove the worktree directory from disk. */
  removeWorktree: boolean;
  /** Also delete the branch the worktree was on (only when the worktree is removed). */
  deleteBranch: boolean;
};

export function confirmWorktreeSessionDelete(opts: {
  worktreePath: string;
  branch: string | null;
  /** Tabs still running an agent/task - listed above the worktree details. */
  busyTabs?: BusyTab[];
}): Promise<WorktreeDeleteChoice | null> {
  return presentImperative<WorktreeDeleteChoice | null>((onDone) => (
    <WorktreeDeleteHost opts={opts} onDone={onDone} />
  ));
}

/** Shorten `<project>/.worktree/<branch>` to `.worktree/<branch>` for display.
 * Shared with the project delete dialog's worktree list. */
export function shortWorktreePath(p: string): string {
  const i = p.indexOf('/.worktree/');
  return i >= 0 ? p.slice(i + 1) : p;
}

// eslint-disable-next-line react-refresh/only-export-components -- one-off root, never hot-reloaded
function WorktreeDeleteHost({
  opts,
  onDone,
}: {
  opts: { worktreePath: string; branch: string | null; busyTabs?: BusyTab[] };
  onDone: (choice: WorktreeDeleteChoice | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const done = useRef(false);
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(true);

  // Git refuses to delete a branch that's still checked out in a worktree, so
  // "delete branch" is only available once the worktree is being removed.
  const branchEnabled = removeWorktree && !!opts.branch;

  const finish = (choice: WorktreeDeleteChoice | null): void => {
    if (done.current) return;
    done.current = true;
    setOpen(false);
    onDone(choice);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && finish(null)}>
      <DialogContent showCloseButton={false} className="gap-4">
        <div className="flex items-start gap-3.5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-warning/15">
            <TriangleAlert className="size-5 text-warning" />
          </div>
          <div className="flex flex-col gap-1.5">
            <DialogTitle className="text-base">Delete session?</DialogTitle>
            <p className="text-[length:calc(13px*var(--ui-font-scale,1))] leading-relaxed text-foreground-muted">
              This session runs in a dedicated git worktree, separate from your main working tree.
            </p>
          </div>
        </div>

        {opts.busyTabs && opts.busyTabs.length > 0 && <BusyTabsCard tabs={opts.busyTabs} />}

        <div className="flex flex-col gap-2.5 rounded-md border border-border bg-muted p-3">
          <div className="flex items-center gap-2">
            <FolderGit2 className="size-3.5 shrink-0 text-foreground-muted" />
            <span
              className="truncate font-mono text-xs font-medium text-foreground"
              title={opts.worktreePath}
            >
              {shortWorktreePath(opts.worktreePath)}
            </span>
          </div>
          {opts.branch && (
            <div className="flex items-center gap-2">
              <GitBranch className="size-3.5 shrink-0 text-primary" />
              <span className="truncate font-mono text-xs font-medium text-foreground-muted">
                {opts.branch}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2.5">
            <Checkbox
              checked={removeWorktree}
              onCheckedChange={setRemoveWorktree}
              className="mt-0.5"
            />
            <div
              className="flex cursor-pointer flex-col gap-0.5"
              onClick={() => setRemoveWorktree((v) => !v)}
            >
              <span className="text-[13px] font-medium text-foreground">
                Remove the worktree folder from disk
              </span>
              <span className="text-xs leading-snug text-foreground-muted">
                Uncommitted changes in the worktree will be lost.
              </span>
            </div>
          </div>

          <div className={cn('flex items-start gap-2.5', !branchEnabled && 'opacity-50')}>
            <Checkbox
              checked={deleteBranch && branchEnabled}
              disabled={!branchEnabled}
              onCheckedChange={setDeleteBranch}
              className="mt-0.5"
            />
            <div
              className={cn('flex flex-col gap-0.5', branchEnabled && 'cursor-pointer')}
              onClick={() => branchEnabled && setDeleteBranch((v) => !v)}
            >
              <span className="text-[13px] font-medium text-foreground">
                Delete the branch{opts.branch ? ` “${opts.branch}”` : ''}
              </span>
              <span className="text-xs leading-snug text-foreground-muted">
                Unmerged commits on the branch will be lost.
              </span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            autoFocus
            onClick={() => finish({ removeWorktree, deleteBranch: deleteBranch && branchEnabled })}
          >
            <Trash2 className="size-3.5" />
            Delete session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
