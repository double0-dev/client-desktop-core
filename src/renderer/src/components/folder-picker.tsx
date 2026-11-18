import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  Search,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { cn, joinPath } from '@renderer/lib/utils';
import { isWithin, relativeTo } from '@renderer/lib/path-within';

/** Mirrors the shape `window.api.fs.readDir` returns (see src/main/fs.ts). */
type DirEntry = { name: string; path: string; isDirectory: boolean; isRepo?: boolean };

/** One rendered line of the flattened tree. */
type Row = { path: string; name: string; depth: number; isRepo: boolean; isRoot: boolean };

/**
 * Folder-only tree in a popover (design `· Task Details · Folder Picker`), for
 * choosing the folder a session runs in.
 *
 * Folders that are their own git checkout carry a branch marker: a project can
 * hold several independent repos, and picking one of those is what makes the
 * session branch - and report its changes - against that repo rather than the
 * project's. Picking the root row means "just use the project", stored as null.
 *
 * Listings are lazy (one `fs:readDir` per expanded folder) and cached for as
 * long as the popover stays open, so re-collapsing costs nothing.
 */
export function FolderPicker({
  rootPath,
  value,
  onChange,
  align = 'end',
  children,
}: {
  /** The project folder - the tree's root and the "default" choice. */
  rootPath: string;
  /** Currently chosen folder; null = the project root. */
  value: string | null;
  onChange: (path: string | null) => void;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [query, setQuery] = useState('');

  const load = useCallback(async (path: string) => {
    const res = await window.api?.fs?.readDir(path, { dirsOnly: true, markRepos: true });
    // An unreadable folder caches as empty rather than retrying forever - the
    // row simply stops offering to expand.
    setEntries((prev) => ({ ...prev, [path]: res?.entries ?? [] }));
  }, []);

  // Opening starts from the project root and reveals the current selection, so
  // a session already rooted three folders deep doesn't open onto a collapsed
  // tree the user has to re-navigate.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const chain = [rootPath];
    if (value && isWithin(value, rootPath)) {
      const parts = relativeTo(value, rootPath).split(/[\\/]/).filter(Boolean);
      // Every ancestor of the selection, but not the selection itself - that one
      // only needs to be visible, not opened.
      let at = rootPath;
      for (const part of parts.slice(0, -1)) {
        at = joinPath(at, part);
        chain.push(at);
      }
    }
    setExpanded(chain);
    for (const path of chain) void load(path);
  }, [open, rootPath, value, load]);

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      if (prev.includes(path)) return prev.filter((p) => p !== path);
      if (!entries[path]) void load(path);
      return [...prev, path];
    });
  };

  const flatten = (path: string, depth: number): Row[] =>
    (entries[path] ?? []).flatMap((entry) => [
      {
        path: entry.path,
        name: entry.name,
        depth,
        isRepo: entry.isRepo === true,
        isRoot: false,
      },
      ...(expanded.includes(entry.path) ? flatten(entry.path, depth + 1) : []),
    ]);

  const rootRow: Row = {
    path: rootPath,
    name: rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath,
    depth: 0,
    isRepo: false,
    isRoot: true,
  };
  const all = [rootRow, ...flatten(rootPath, 1)];
  // The filter matches what has been loaded - it narrows the visible tree, it
  // doesn't crawl the disk. Indentation is dropped while filtering because the
  // matches no longer form a contiguous tree.
  const q = query.trim().toLowerCase();
  const rows = q
    ? all.filter((row) => row.name.toLowerCase().includes(q)).map((row) => ({ ...row, depth: 0 }))
    : all;

  const selected = value ?? rootPath;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        sideOffset={6}
        className="w-[360px] rounded-lg border-border-strong bg-surface-elevated p-0"
      >
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Search className="size-3 shrink-0 text-foreground-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // The menu's typeahead would swallow typing - keep every key local
            // except Escape, which should still close the popover.
            onKeyDown={(e) => {
              if (e.key === 'Escape') return;
              e.stopPropagation();
            }}
            placeholder="Filter folders…"
            spellCheck={false}
            autoFocus
            className="min-w-0 flex-1 bg-transparent font-mono text-[length:calc(11.5px*var(--ui-font-scale,1))] text-foreground outline-none placeholder:text-foreground-subtle"
          />
        </div>
        <div className="h-px bg-border" />
        <div className="max-h-[260px] overflow-y-auto p-1.5">
          {rows.length === 0 && (
            <p className="px-2 py-3 text-center font-mono text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
              No folders match.
            </p>
          )}
          {rows.map((row) => {
            const isSelected = row.path === selected;
            const isOpen = expanded.includes(row.path);
            // Before a folder is expanded we can't know whether it has any
            // subfolders, so it keeps its chevron; once loaded and empty, the
            // chevron gives way to a spacer.
            const canExpand = !entries[row.path] || entries[row.path].length > 0;
            const FolderIcon = isOpen ? FolderOpen : Folder;
            return (
              <div
                key={row.path}
                className={cn(
                  'flex items-center gap-1.5 rounded-sm py-1 pr-2',
                  isSelected ? 'bg-accent' : 'hover:bg-muted',
                )}
                style={{ paddingLeft: 6 + row.depth * 14 }}
              >
                {canExpand && !q ? (
                  <button
                    type="button"
                    aria-label={isOpen ? `Collapse ${row.name}` : `Expand ${row.name}`}
                    aria-expanded={isOpen}
                    onClick={() => toggle(row.path)}
                    className="flex size-[14px] shrink-0 items-center justify-center rounded-sm text-foreground-subtle outline-none transition-colors hover:text-foreground"
                  >
                    {isOpen ? (
                      <ChevronDown className="size-[11px]" />
                    ) : (
                      <ChevronRight className="size-[11px]" />
                    )}
                  </button>
                ) : (
                  <span className="size-[14px] shrink-0" />
                )}
                <button
                  type="button"
                  aria-pressed={isSelected}
                  // The root row means "no explicit folder", so it stores null -
                  // a session then follows the project even if the project is
                  // later pointed at a different path.
                  onClick={() => {
                    onChange(row.isRoot ? null : row.path);
                    setOpen(false);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
                >
                  <FolderIcon className="size-3 shrink-0 text-[#fbbf24]" />
                  <span
                    className={cn(
                      'min-w-0 truncate font-mono text-[length:calc(11.5px*var(--ui-font-scale,1))]',
                      isSelected ? 'font-semibold text-primary' : 'text-foreground',
                    )}
                  >
                    {row.name}
                  </span>
                  {row.isRoot && (
                    <span className="shrink-0 font-mono text-[length:calc(10px*var(--ui-font-scale,1))] text-foreground-subtle">
                      project root
                    </span>
                  )}
                  <span className="min-w-0 flex-1" />
                  {row.isRepo && (
                    <GitBranch
                      aria-label="Has its own git repository"
                      className={cn(
                        'size-[11px] shrink-0',
                        isSelected ? 'text-primary' : 'text-foreground-subtle',
                      )}
                    />
                  )}
                  {isSelected && <Check className="size-3 shrink-0 text-primary" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="h-px bg-border" />
        <div className="flex items-center gap-1.5 px-3 py-2">
          <GitBranch className="size-2.5 shrink-0 text-foreground-subtle" />
          <span className="font-mono text-[length:calc(9.5px*var(--ui-font-scale,1))] text-foreground-subtle">
            has its own git repo - the session branches from there
          </span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
