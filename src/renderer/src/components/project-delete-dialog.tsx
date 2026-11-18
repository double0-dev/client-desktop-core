import { useRef, useState } from 'react';
import { presentImperative } from '@renderer/lib/imperative-root';
import { FolderGit2, SquareTerminal, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { BusyStatusPill } from '@renderer/components/busy-tabs-dialog';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@renderer/components/ui/dialog';
import { shortWorktreePath } from '@renderer/components/worktree-delete-dialog';
import { AGENT_ICONS } from '@renderer/lib/session/agent-icon';
import { agentIconKind } from '@renderer/lib/session/templates';
import type { TerminalBusyStatus } from '@renderer/lib/terminal/busy';
import { cn } from '@renderer/lib/utils';

/**
 * Imperative confirmation for deleting a project, whose DB cascade takes every
 * session with it (design: `Screen/Delete Project Dialog`). Lists the sessions
 * being deleted (with their busy state) and, when any are backed by a git
 * worktree, lets the user opt out of removing the worktree folders and deleting
 * their branches (both default on) - the same cleanup semantics as deleting a
 * single worktree session. Resolves with the chosen cleanup, or `null` if the
 * user cancelled/dismissed. Mounts a one-off root like `confirmDialog`.
 */
export type ProjectDeleteChoice = {
  /** Remove the sessions' worktree directories from disk. */
  removeWorktrees: boolean;
  /** Also delete the branches the worktrees were on (only when they are removed). */
  deleteBranches: boolean;
};

export type ProjectDeleteSessionRow = {
  label: string;
  /** The session's agent label ('Claude Code', 'Terminal', …) - picks the row icon. */
  agent: string;
  worktreePath: string | null;
  busy: TerminalBusyStatus | null;
};

export function confirmProjectDelete(opts: {
  projectName: string;
  sessions: ProjectDeleteSessionRow[];
  /** A sentence after the description (what is NOT deleted). */
  note?: string | null;
}): Promise<ProjectDeleteChoice | null> {
  return presentImperative<ProjectDeleteChoice | null>((onDone) => (
    <ProjectDeleteHost opts={opts} onDone={onDone} />
  ));
}

// eslint-disable-next-line react-refresh/only-export-components -- one-off root, never hot-reloaded
function SessionRow({ row }: { row: ProjectDeleteSessionRow }) {
  const kind = agentIconKind(row.agent);
  const AgentIcon = kind ? AGENT_ICONS[kind] : undefined;
  return (
    <div className="flex items-center gap-2">
      {AgentIcon ? (
        <AgentIcon className="size-3.5 shrink-0 text-primary" />
      ) : (
        <SquareTerminal className="size-3.5 shrink-0 text-foreground-muted" />
      )}
      <span className="flex-1 truncate text-[13px] font-medium text-foreground">{row.label}</span>
      {row.busy && <BusyStatusPill status={row.busy} />}
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- one-off root, never hot-reloaded
function ProjectDeleteHost({
  opts,
  onDone,
}: {
  opts: { projectName: string; sessions: ProjectDeleteSessionRow[]; note?: string | null };
  onDone: (choice: ProjectDeleteChoice | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const done = useRef(false);
  const [removeWorktrees, setRemoveWorktrees] = useState(true);
  const [deleteBranches, setDeleteBranches] = useState(true);

  const { projectName, sessions } = opts;
  const worktrees = sessions.filter((s) => s.worktreePath);
  const busyCount = sessions.filter((s) => s.busy).length;
  const many = worktrees.length > 1;

  // Git refuses to delete a branch that's still checked out in a worktree, so
  // "delete branches" is only available once the worktrees are being removed.
  const branchEnabled = removeWorktrees && worktrees.length > 0;

  const description =
    `Deleting “${projectName}” also deletes its ` +
    `${sessions.length} session${sessions.length === 1 ? '' : 's'}.` +
    (worktrees.length > 0
      ? many
        ? ` ${worktrees.length} run in dedicated git worktrees, separate from your main working tree.`
        : ' One runs in a dedicated git worktree, separate from your main working tree.'
      : '') +
    (opts.note ? ` ${opts.note}` : '');

  const finish = (choice: ProjectDeleteChoice | null): void => {
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
            <DialogTitle className="text-base">Delete project?</DialogTitle>
            <p className="text-[length:calc(13px*var(--ui-font-scale,1))] leading-relaxed text-foreground-muted">
              {description}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 rounded-md border border-border bg-muted p-3">
          <span className="text-[11px] font-semibold text-foreground-muted">
            {sessions.length === 1 ? '1 session' : `${sessions.length} sessions`} will be deleted
            {busyCount > 0 && ` - ${busyCount} ${busyCount === 1 ? 'is' : 'are'} still busy`}
          </span>
          <div className="h-px bg-border" />
          {sessions.map((row, i) => (
            <SessionRow key={i} row={row} />
          ))}
        </div>

        {worktrees.length > 0 && (
          <div className="flex flex-col gap-2.5 rounded-md border border-border bg-muted p-3">
            {worktrees.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <FolderGit2 className="size-3.5 shrink-0 text-foreground-muted" />
                <span
                  className="truncate font-mono text-xs font-medium text-foreground"
                  title={s.worktreePath ?? undefined}
                >
                  {shortWorktreePath(s.worktreePath ?? '')}
                </span>
              </div>
            ))}
          </div>
        )}

        {worktrees.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5">
              <Checkbox
                checked={removeWorktrees}
                onCheckedChange={setRemoveWorktrees}
                className="mt-0.5"
              />
              <div
                className="flex cursor-pointer flex-col gap-0.5"
                onClick={() => setRemoveWorktrees((v) => !v)}
              >
                <span className="text-[13px] font-medium text-foreground">
                  Remove the worktree {many ? 'folders' : 'folder'} from disk
                </span>
                <span className="text-xs leading-snug text-foreground-muted">
                  Uncommitted changes in the {many ? 'worktrees' : 'worktree'} will be lost.
                </span>
              </div>
            </div>

            <div className={cn('flex items-start gap-2.5', !branchEnabled && 'opacity-50')}>
              <Checkbox
                checked={deleteBranches && branchEnabled}
                disabled={!branchEnabled}
                onCheckedChange={setDeleteBranches}
                className="mt-0.5"
              />
              <div
                className={cn('flex flex-col gap-0.5', branchEnabled && 'cursor-pointer')}
                onClick={() => branchEnabled && setDeleteBranches((v) => !v)}
              >
                <span className="text-[13px] font-medium text-foreground">
                  Delete {many ? 'their branches' : 'its branch'}
                </span>
                <span className="text-xs leading-snug text-foreground-muted">
                  Unmerged commits on the {many ? 'branches' : 'branch'} will be lost.
                </span>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            autoFocus
            onClick={() =>
              finish({
                removeWorktrees: removeWorktrees && worktrees.length > 0,
                deleteBranches: deleteBranches && branchEnabled,
              })
            }
          >
            <Trash2 className="size-3.5" />
            Delete project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
