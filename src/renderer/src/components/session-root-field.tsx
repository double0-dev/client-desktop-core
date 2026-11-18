import { useEffect, useState } from 'react';
import { ChevronDown, Folder, GitBranch } from 'lucide-react';
import { FolderPicker } from '@renderer/components/folder-picker';
import { Label } from '@renderer/components/ui/label';
import { describeRoot } from '@renderer/lib/session/root';
import { cn } from '@renderer/lib/utils';

/**
 * The labeled "where does this run" row shared by the task details dialog
 * ("Working folder") and the New/Edit Session dialogs ("Session root") - design
 * `· Task Details` and `Screen/New Session Dialog`.
 *
 * The row shows the folder as `<project>/` + the part that matters, plus an
 * "own repo" badge when that folder is a git checkout of its own - the signal
 * that a worktree will be cut there rather than at the project root. `Change`
 * opens the folder picker; `locked` renders the row read-only (editing an
 * existing session, whose worktree already exists).
 */
export function SessionRootField({
  label,
  hint,
  projectPath,
  value,
  onChange,
  locked = false,
}: {
  label: string;
  hint: string;
  /** The project's folder - the tree root and the default. */
  projectPath: string | null;
  value: string | null;
  onChange?: (path: string | null) => void;
  locked?: boolean;
}) {
  const { prefix, leaf, isDefault } = describeRoot(value, projectPath);
  const isRepo = useIsRepoRoot(isDefault ? projectPath : value);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Label className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium">
          {label}
        </Label>
        <span className="flex-1" />
        <span className="font-mono text-[length:calc(10.5px*var(--ui-font-scale,1))] text-foreground-subtle">
          {hint}
        </span>
      </div>
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-md border border-border px-2.5 py-1.5',
          locked ? 'bg-surface opacity-75' : 'bg-input',
        )}
      >
        <Folder className="size-3.5 shrink-0 text-[#fbbf24]" />
        <span className="min-w-0 truncate font-mono text-[length:calc(12.5px*var(--ui-font-scale,1))]">
          <span className="text-foreground-subtle">{prefix}</span>
          <span className="font-semibold text-foreground">{leaf}</span>
        </span>
        {isRepo && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[length:calc(9.5px*var(--ui-font-scale,1))] font-semibold text-foreground-muted">
            <GitBranch className="size-2.5" />
            own repo
          </span>
        )}
        <span className="min-w-0 flex-1" />
        {!locked && projectPath && (
          <FolderPicker rootPath={projectPath} value={value} onChange={onChange ?? (() => {})}>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-border-strong px-2 py-1 text-[length:calc(12px*var(--ui-font-scale,1))] font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              Change
              <ChevronDown className="size-3 text-foreground-muted" />
            </button>
          </FolderPicker>
        )}
      </div>
    </div>
  );
}

/**
 * Whether `path` is the root of a git repository (rather than merely sitting
 * inside one) - that distinction is what the "own repo" badge reports, since
 * only a repo root gets its own worktree and branch.
 */
function useIsRepoRoot(path: string | null): boolean {
  const [isRepo, setIsRepo] = useState(false);
  useEffect(() => {
    if (!path) {
      setIsRepo(false);
      return;
    }
    let live = true;
    void window.api?.git?.repoRoot?.(path).then((res) => {
      // Trailing slashes differ between a picked path and git's output.
      if (live) setIsRepo(res?.root?.replace(/\/+$/, '') === path.replace(/\/+$/, ''));
    });
    return () => {
      live = false;
    };
  }, [path]);
  return isRepo;
}
