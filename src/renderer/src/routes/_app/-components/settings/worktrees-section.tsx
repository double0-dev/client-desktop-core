import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { ChevronRight, File, FileX, Folder, RotateCw, TriangleAlert } from 'lucide-react';
import { projectsCollection, type Project } from '@renderer/lib/collections';
import { initialsOf, projectIconStyle } from '@renderer/lib/format';
import { sortProjects } from '@renderer/lib/project-order';
import {
  describeWorktreeSetup,
  filesOnly,
  formatBytes,
  missingPaths,
  setupCommandOf,
  togglePath,
  type IgnoredEntry,
} from '@renderer/lib/worktrees/setup';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Input } from '@renderer/components/ui/input';
import { cn } from '@renderer/lib/utils';
import { useSettingsHeader } from '@renderer/routes/_app/-components/settings/settings-header';

const SECTION_LABEL =
  'text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle';
const HELP = 'text-xs leading-relaxed text-foreground-subtle';
const TABLE_LABEL =
  'text-[length:calc(10.5px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle';

/**
 * Settings → Worktrees (design `Screen/Settings - Worktrees` and
 * `· production-pipeline`, plus the `Label/Settings · Worktree setup` boards):
 * what a new session's git worktree gets before the agent starts. Nothing is
 * global - the section is a list of projects, and a project's own screen holds
 * the two things `launchSession` reads at launch: which of the checkout's
 * git-ignored files and folders to copy into the fresh worktree, and the
 * command its setup tab runs once afterwards. Both live on the project row.
 */
export function WorktreesSettingsSection() {
  const { data: projects } = useLiveQuery((q) => q.from({ project: projectsCollection }));
  // Only a folder-backed project can have worktrees; the list keeps the rail's order.
  const ordered = useMemo(() => sortProjects(projects ?? []).filter((p) => p.path), [projects]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = ordered.find((p) => p.id === selectedId) ?? null;
  if (selected) return <ProjectSetup project={selected} onBack={() => setSelectedId(null)} />;
  return <ProjectList projects={ordered} onOpen={setSelectedId} />;
}

type Scan = { root: string | null; entries: IgnoredEntry[] };

/**
 * Everything git ignores in the checkout at `path`, read live through the git
 * bridge; `sizes` adds folder sizes (a du per folder - the project list asks
 * without, the project's own screen with). `scan` is null until the first
 * answer; `root: null` means the folder isn't a git repository.
 */
function useIgnoredScan(
  path: string | null,
  sizes: boolean,
): { scan: Scan | null; error: string | null; loading: boolean; rescan: () => void } {
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) {
      setScan(null);
      return;
    }
    let live = true;
    setLoading(true);
    // Chained through the call too: without a git bridge (tests, a renderer
    // preview) there is nothing to scan and the list simply stays empty.
    const pending = window.api?.git?.ignoredEntries?.(path, { sizes });
    if (!pending) {
      setLoading(false);
      return;
    }
    void pending.then((res) => {
      if (!live) return;
      setLoading(false);
      if (res?.error) {
        setError(res.error);
        setScan(null);
      } else {
        setError(null);
        setScan({ root: res?.root ?? null, entries: res?.entries ?? [] });
      }
    });
    return () => {
      live = false;
    };
  }, [path, sizes, tick]);
  return { scan, error, loading, rescan: () => setTick((t) => t + 1) };
}

function ProjectList({
  projects,
  onOpen,
}: {
  projects: Project[];
  onOpen: (projectId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-[18px]">
      <section className="flex flex-col gap-3">
        <h3 className={SECTION_LABEL}>PROJECTS</h3>
        <p className={HELP}>
          Each project decides what its new worktrees get. Pick one to choose the ignored files to
          copy in and the command that sets the worktree up.
        </p>
        {projects.length === 0 ? (
          <p className={HELP}>No projects with a folder yet - add one from the Projects panel.</p>
        ) : (
          <div className="flex flex-col overflow-hidden rounded-md border border-border">
            <div className="flex items-center gap-2.5 bg-muted px-3 py-2">
              <span className={cn('flex-1', TABLE_LABEL)}>PROJECT</span>
              <span className={cn('shrink-0', TABLE_LABEL)}>WORKTREE SETUP</span>
            </div>
            {projects.map((p, i) => (
              <ProjectRow key={p.id} project={p} first={i === 0} onOpen={() => onOpen(p.id)} />
            ))}
          </div>
        )}
      </section>
      <p className={HELP}>
        Applies to new worktrees only - an existing session’s folder isn’t touched. A project whose
        folder isn’t a git repository can’t have worktrees.
      </p>
    </div>
  );
}

function ProjectRow({
  project,
  first,
  onOpen,
}: {
  project: Project;
  first: boolean;
  onOpen: () => void;
}) {
  const { scan } = useIgnoredScan(project.path, false);
  const notRepo = scan != null && scan.root === null;
  const summary = notRepo
    ? { text: 'Not a git repository - no worktrees here', muted: true }
    : describeWorktreeSetup(project, scan ? scan.entries.length : null);
  return (
    <button
      type="button"
      disabled={notRepo}
      onClick={onOpen}
      className={cn(
        'flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
        !first && 'border-t border-border',
        notRepo ? 'opacity-60' : 'hover:bg-muted',
      )}
    >
      <span
        className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] font-mono text-[9px] font-bold"
        style={projectIconStyle(project.color)}
      >
        {initialsOf(project.name)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground">
            {project.name}
          </span>
          <span className="truncate font-mono text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
            {project.path}
          </span>
        </span>
        <span
          className={cn(
            'truncate font-mono text-[length:calc(11px*var(--ui-font-scale,1))]',
            summary.muted ? 'text-foreground-subtle' : 'text-foreground-muted',
          )}
        >
          {summary.text}
        </span>
      </span>
      {!notRepo && <ChevronRight className="size-3.5 shrink-0 text-foreground-subtle" />}
    </button>
  );
}

function ProjectSetup({ project, onBack }: { project: Project; onBack: () => void }) {
  const header = useMemo(
    () => ({
      title: project.name,
      description: `${project.path} - new worktrees land in .worktree/ beside the checkout, on their own branch.`,
      back: { label: 'Worktrees', onClick: onBack },
    }),
    [project.name, project.path, onBack],
  );
  useSettingsHeader(header);

  const { scan, error, loading, rescan } = useIgnoredScan(project.path, true);
  const entries = useMemo(() => scan?.entries ?? [], [scan]);
  const order = useMemo(() => entries.map((e) => e.path), [entries]);
  const ticked = project.worktreeCopyPaths;
  const missing = missingPaths(project, entries);
  const setPaths = (paths: string[]): void => {
    projectsCollection.update(project.id, (draft) => {
      draft.worktreeCopyPaths = paths;
    });
  };

  // The command is saved on blur / Enter rather than per keystroke - each save
  // is a row update every window sees.
  const stored = setupCommandOf(project);
  const [command, setCommand] = useState(stored);
  useEffect(() => setCommand(stored), [project.id, stored]);
  const saveCommand = (): void => {
    const next = command.trim();
    if (next === stored) return;
    projectsCollection.update(project.id, (draft) => {
      draft.worktreeSetupCommand = next || null;
    });
  };

  const empty = !loading && entries.length === 0 && missing.length === 0;
  return (
    <div className="flex flex-col gap-[18px]">
      <section className="flex flex-col gap-3">
        <h3 className={SECTION_LABEL}>COPY INTO NEW WORKTREES</h3>
        <p className={HELP}>
          Everything git ignores in this checkout, read from its .gitignore files. Ticked entries
          are copied into each new worktree at the same path - folders whole, as a copy-on-write
          clone where the disk allows.
        </p>
        <div className="flex flex-col overflow-hidden rounded-md border border-border bg-surface">
          <div className="flex items-center gap-2.5 bg-muted px-3 py-1.5">
            <span className={cn('flex-1', TABLE_LABEL)}>
              IGNORED IN THIS CHECKOUT · {entries.length}
            </span>
            <button
              type="button"
              onClick={() => setPaths(filesOnly(entries))}
              className="text-[length:calc(11px*var(--ui-font-scale,1))] font-medium text-primary outline-none hover:underline focus-visible:underline"
            >
              Files only
            </button>
            <button
              type="button"
              onClick={() => setPaths([])}
              className="text-[length:calc(11px*var(--ui-font-scale,1))] font-medium text-primary outline-none hover:underline focus-visible:underline"
            >
              None
            </button>
            <button
              type="button"
              onClick={rescan}
              className="flex items-center gap-1 text-[length:calc(11px*var(--ui-font-scale,1))] font-medium text-foreground-muted outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
            >
              <RotateCw className={cn('size-3', loading && 'animate-spin')} />
              Rescan
            </button>
          </div>
          <div className="flex flex-col py-1">
            {error ? (
              <p className="px-3 py-3 text-xs text-destructive">{error}</p>
            ) : empty ? (
              <div className="flex items-center justify-center gap-2 px-3 py-3.5 text-xs text-foreground-subtle">
                <FileX className="size-3.5 shrink-0" />
                {scan?.root === null
                  ? 'Not a git repository - this project can’t have worktrees.'
                  : 'Nothing is ignored in this checkout - add patterns to .gitignore and rescan.'}
              </div>
            ) : (
              <>
                {entries.map((entry) => (
                  <EntryRow
                    key={entry.path}
                    entry={entry}
                    checked={ticked.includes(entry.path)}
                    onChange={(on) => setPaths(togglePath(ticked, entry.path, on, order))}
                  />
                ))}
                {missing.map((path) => (
                  <EntryRow
                    key={path}
                    entry={{ path, kind: path.endsWith('/') ? 'dir' : 'file' }}
                    checked
                    missing
                    onChange={(on) => setPaths(togglePath(ticked, path, on, order))}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </section>

      <div className="h-px w-full bg-border" />

      <section className="flex flex-col gap-3">
        <h3 className={SECTION_LABEL}>SETUP COMMAND</h3>
        <p className={HELP}>
          Runs once in its own tab after the copy, inside the new worktree - install dependencies,
          generate code, migrate a database. The New session dialog starts from this.
        </p>
        <Input
          aria-label="Setup command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onBlur={saveCommand}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveCommand();
            }
          }}
          placeholder="pnpm install"
          className="font-mono"
        />
      </section>

      <p className={HELP}>
        Applies to new worktrees only - an existing session’s folder isn’t touched.
      </p>
    </div>
  );
}

/**
 * One ignored entry (design `Label/Settings · Worktree setup` 01): checkbox,
 * file/folder glyph, path, and a right-hand note - a folder's size, why a
 * locked one can't be copied, or that a ticked path is no longer in the
 * checkout (kept, skipped at copy time).
 */
function EntryRow({
  entry,
  checked,
  missing = false,
  onChange,
}: {
  entry: IgnoredEntry;
  checked: boolean;
  missing?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const locked = entry.locked != null;
  const Icon = missing ? TriangleAlert : entry.kind === 'dir' ? Folder : File;
  const meta =
    entry.locked ??
    (missing ? 'not in checkout' : entry.bytes != null ? formatBytes(entry.bytes) : null);
  return (
    <label
      className={cn(
        'flex items-center gap-2 px-3 py-[3px]',
        locked ? 'cursor-default' : 'cursor-pointer hover:bg-accent',
      )}
    >
      <Checkbox
        checked={checked}
        disabled={locked}
        onCheckedChange={onChange}
        aria-label={`Copy ${entry.path} into new worktrees`}
        className={cn('size-4', locked && 'border-border bg-muted')}
      />
      <Icon
        className={cn(
          'size-3 shrink-0',
          missing
            ? 'text-warning'
            : entry.kind === 'dir'
              ? 'text-warning'
              : 'text-foreground-muted',
        )}
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-xs',
          locked || missing
            ? 'text-foreground-subtle'
            : checked
              ? 'font-medium text-foreground'
              : 'text-foreground',
        )}
      >
        {entry.path}
      </span>
      {meta && (
        <span className="shrink-0 font-mono text-[length:calc(10.5px*var(--ui-font-scale,1))] text-foreground-subtle">
          {meta}
        </span>
      )}
    </label>
  );
}
