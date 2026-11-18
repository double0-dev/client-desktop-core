import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EXPLORER_DRAG_MIME, encodeExplorerDrag } from '@renderer/lib/terminal/file-drop';
import {
  Braces,
  ChevronDown,
  Copy,
  ChevronRight,
  File,
  FileCode,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  FolderPlus,
  Loader2,
  Pencil,
  RotateCw,
  SquareTerminal,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { browserPreviewable, previewRoot } from '@renderer/lib/editor/file-preview';
import { useWorkspaceLayout } from '@renderer/lib/workspace/layout-context';
import { useExplorerFontStyle } from '@renderer/lib/settings/ui-font-settings';
import { registerExplorerReveal } from '@renderer/lib/explorer-reveal';
import { REVEAL_IN_OS_LABEL, revealInOs } from '@renderer/lib/reveal-in-os';
import { currentHostOfPath } from '@renderer/lib/hosts/host-of-path';
import { onHostConnected, useHostStatus } from '@renderer/lib/hosts/host-status';
import { canShowInFolder } from '@renderer/lib/session/remote-capabilities';
import { useWatchMode } from '@renderer/lib/workspace/watch-mode';
import { loadExplorerTreeState, saveExplorerTreeState } from '@renderer/lib/explorer-tree-state';
import { useGitOptional } from '@renderer/lib/git/context';
import { letterClass } from '@renderer/lib/git/glyphs';
import { combinedStatusLetter } from '@renderer/lib/git/types';
import { alertDialog, confirmDialog } from '@renderer/components/ui/confirm-dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { cn, fileName, isPathInside, joinPath, parentDir } from '@renderer/lib/utils';
import { isWithin, relativeTo } from '@renderer/lib/path-within';
import { findFocusItem, stepFocusItem } from '@renderer/lib/workspace/focus-regions';
import { isFileDrag } from '@renderer/lib/workspace/explorer-upload';
import { useHosts } from '@renderer/lib/hosts/host-directory';
import { useExplorerUpload } from '@renderer/lib/workspace/use-explorer-upload';
import { UploadFooter } from './explorer-upload';

/** One directory entry, mirroring the shape returned by `window.api.fs.readDir`. */
type DirEntry = { name: string; path: string; isDirectory: boolean };

const CODE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'rb',
  'php',
  'swift',
  'kt',
  'kts',
  'vue',
  'svelte',
  'sh',
  'bash',
  'zsh',
  'sql',
  'css',
  'scss',
  'less',
  'html',
  'xml',
  'yaml',
  'yml',
  'toml',
  'lua',
  'dart',
  'r',
  'scala',
  'ex',
  'exs',
  'elm',
  'clj',
  'graphql',
  'gql',
]);
const DATA_EXT = new Set(['json', 'jsonc', 'lock']);
const DOC_EXT = new Set(['md', 'markdown', 'mdx', 'txt', 'rst', 'log']);

/** Pick a Lucide icon + color class for a file by its extension. */
function fileIcon(name: string): { Icon: LucideIcon; color: string } {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (CODE_EXT.has(ext)) return { Icon: FileCode, color: 'text-[#60a5fa]' };
  if (DATA_EXT.has(ext)) return { Icon: Braces, color: 'text-[#fbbf24]' };
  if (DOC_EXT.has(ext)) return { Icon: FileText, color: 'text-foreground-subtle' };
  return { Icon: File, color: 'text-foreground-subtle' };
}

// Sized in em so rows track the explorer font-size setting (26px at the
// default 12px); the family resolves via `font-mono` so the app-font /
// explorer-font overrides cascade in (see ui-font-settings.ts).
const ROW = 'flex h-[calc(1em_+_14px)] w-full items-center gap-1.5 pr-2 font-mono';
const indent = (depth: number): React.CSSProperties => ({ paddingLeft: 12 + depth * 12 });

/**
 * Lazy, expandable file tree rooted at a session's project directory. Folders
 * load their children on first expand (and can be re-read with the refresh
 * action); clicking a file opens it in an editor tab via the workspace context.
 * New files/folders are created inline - from the header (at the root) or the
 * per-folder hover actions (inside that folder).
 */
export function FileExplorer({
  rootPath,
  onNewSessionAt,
}: {
  rootPath: string;
  /** "New session here" on a folder's context menu - absent hides the item (e.g. detached windows). */
  onNewSessionAt?: (path: string) => void;
}) {
  const { layout, openFile, openBrowser, remapEditorPaths, closeEditorsUnder } =
    useWorkspaceLayout();
  // HTML, SVG, PDF and video open in a browser tab (a private plan),
  // read through `d0-preview://` under the session's folder.
  const openInBrowser = (path: string): void => {
    void window.api?.browser?.previewUrl(previewRoot(path, rootPath), path).then((url) => {
      if (url) openBrowser?.(url, { newTab: true });
    });
  };
  const fontStyle = useExplorerFontStyle();
  // A tree on a remote host (a private plan): nothing on this
  // machine to reveal. Previews work everywhere: `d0-preview://` reads a host
  // file through the host (plan 29 › M6).
  const rootHost = currentHostOfPath(rootPath);
  const revealable = canShowInFolder(rootHost);
  const watchMode = useWatchMode(rootPath);
  const hasBridge = typeof window !== 'undefined' && !!window.api?.fs;
  const hosts = useHosts();
  const hostLabel = rootHost ? (hosts.find((h) => h.id === rootHost)?.label ?? 'the server') : null;
  const rootHostState = useHostStatus(rootHost)?.state;
  // The folder a drag of files from outside the window would land in.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]));
  // Which root the current `expanded`/scroll state describes. Persistence is
  // gated on it matching `rootPath`, so a root switch can never save one
  // project's tree state under another project's key.
  const [hydratedRoot, setHydratedRoot] = useState<string | null>(null);
  const [childrenByPath, setChildrenByPath] = useState<Record<string, DirEntry[]>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [rootError, setRootError] = useState<string | null>(null);
  // Per-directory read failures (non-root), rendered as an inline row in place
  // of that folder's children; cleared by the next successful load.
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  // An inline "new file/folder" input, anchored to the folder it'll be created in.
  const [creating, setCreating] = useState<{ parentPath: string; kind: 'file' | 'folder' } | null>(
    null,
  );
  // An inline rename input, anchored to the entry being renamed.
  const [renaming, setRenaming] = useState<{
    path: string;
    parentPath: string;
    isDirectory: boolean;
    wasOpen: boolean;
  } | null>(null);
  // Brief spin on the refresh icon so a manual refresh visibly responds.
  const [refreshing, setRefreshing] = useState(false);
  // The row the keyboard last landed on - where focus returns when ⇧⌘Arrow
  // re-enters the explorer (falls back to the active file, then the root).
  const [focusedPath, setFocusedPath] = useState<string | null>(null);

  // Fresh view of the loaded directories, read inside the watch subscription
  // (which must not re-subscribe on every load).
  const childrenRef = useRef(childrenByPath);
  childrenRef.current = childrenByPath;

  // The file shown by the active editor tab - highlighted in the tree.
  const activeFilePath = useMemo(() => {
    const pane = layout.nodes[layout.activePaneId];
    const tab = pane?.type === 'pane' ? layout.tabs[pane.activeTabId] : undefined;
    return tab?.kind === 'editor' ? tab.filePath : undefined;
  }, [layout]);

  // Git change indicators (design `pkIH8`): a status letter per changed file
  // plus an aggregated letter on every ancestor folder. Absent outside a
  // GitProvider (detached windows) or a repo. Deleted files aren't on disk so
  // they can't show in the tree, but their folders still carry the mark.
  const git = useGitOptional();
  const gitMarks = useMemo(() => {
    const files = new Map<string, string>();
    const dirs = new Map<string, number>(); // path -> severity rank
    const root = git?.cwd;
    if (!git?.status?.repo || !root) return { files, dirs };
    for (const f of git.status.files) {
      const letter = combinedStatusLetter(f);
      // git's paths are `/`-separated; on Windows the tree's entries are all
      // backslashed (main joins them natively, even under a mixed `C:\x/…`
      // root), or no row ever matched there.
      const joined = joinPath(root, f.path);
      const abs = /^[A-Za-z]:/.test(joined) ? joined.replace(/\//g, '\\') : joined;
      if (letter !== 'D') files.set(abs, letter);
      const rank = letter === '!' ? 3 : letter === 'A' ? 1 : 2;
      let dir = parentDir(abs);
      while (dir.length > root.length) {
        dirs.set(dir, Math.max(dirs.get(dir) ?? 0, rank));
        // A root of `/` would loop: parentDir('/a') is '/a' itself.
        const up = parentDir(dir);
        if (up === dir) break;
        dir = up;
      }
    }
    return { files, dirs };
  }, [git?.status, git?.cwd]);
  const dirMark = (path: string): string | undefined => {
    const rank = gitMarks.dirs.get(path);
    return rank === 3 ? '!' : rank === 2 ? 'M' : rank === 1 ? 'A' : undefined;
  };

  const loadDir = useCallback(
    async (path: string) => {
      if (!hasBridge) return;
      setLoading((prev) => new Set(prev).add(path));
      try {
        const res = await window.api!.fs.readDir(path);
        if (res.entries) {
          const entries = res.entries;
          // A watcher burst re-reads every loaded folder; most come back as
          // they were. Keep the state object then, so the tree doesn't
          // re-render for a folder nothing happened in.
          setChildrenByPath((prev) =>
            prev[path] && sameEntries(prev[path], entries) ? prev : { ...prev, [path]: entries },
          );
          if (path === rootPath) setRootError(null);
          setDirErrors((prev) => {
            if (!(path in prev)) return prev;
            const next = { ...prev };
            delete next[path];
            return next;
          });
        } else {
          const msg = res.error ?? 'Could not read folder';
          if (path === rootPath) setRootError(msg);
          else setDirErrors((prev) => ({ ...prev, [path]: msg }));
        }
      } finally {
        // Always clear the spinner, even if the invoke itself rejected.
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    },
    [hasBridge, rootPath],
  );

  // Manual refresh: re-read every directory currently shown (the root plus every
  // expanded folder), not just the root - so changes anywhere in the open tree
  // show up. The icon spins briefly for feedback.
  const refreshAll = useCallback(async () => {
    const dirs = Object.keys(childrenRef.current);
    const targets = dirs.length ? dirs : [rootPath];
    setRefreshing(true);
    try {
      await Promise.all(targets.map((dir) => loadDir(dir)));
    } finally {
      setRefreshing(false);
    }
  }, [loadDir, rootPath]);

  // Fresh view of the expanded set for the debounced scroll save below, which
  // must not re-arm on every toggle.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Hydrate on mount and whenever the project directory changes: restore this
  // root's saved tree state (expanded folders + scroll) instead of resetting to
  // a bare root, and load every restored folder so the tree renders as it was
  // left. Saved paths are filtered to this root, so a corrupt blob can't leak
  // another project's folders in.
  useEffect(() => {
    const saved = loadExplorerTreeState(rootPath);
    const restored = saved
      ? new Set(saved.expanded.filter((p) => isPathInside(p, rootPath)))
      : new Set([rootPath]);
    setExpanded(restored);
    setHydratedRoot(rootPath);
    setChildrenByPath({});
    setCreating(null);
    setRenaming(null);
    setRootError(null);
    setDirErrors({});
    let cancelled = false;
    void Promise.all([...new Set([rootPath, ...restored])].map((dir) => loadDir(dir))).then(() => {
      if (cancelled || !saved?.scrollTop) return;
      // The rows exist only once React commits the loaded children, which on a
      // cold mount can lag the loads by several frames - retry until the tree
      // is tall enough to take the offset (or give up: the folder shrank).
      const target = saved.scrollTop;
      const deadline = performance.now() + 1000;
      const restoreScroll = (): void => {
        if (cancelled) return;
        const el = scrollRef.current;
        if (el && el.scrollHeight - el.clientHeight >= target) {
          el.scrollTop = target;
          return;
        }
        if (performance.now() < deadline) requestAnimationFrame(restoreScroll);
      };
      requestAnimationFrame(restoreScroll);
    });
    return () => {
      cancelled = true;
    };
  }, [rootPath, loadDir]);

  // Persist the tree state so it survives switching projects/sessions, an LRU
  // eviction of this session's view, and app restarts.
  useEffect(() => {
    if (hydratedRoot !== rootPath) return;
    saveExplorerTreeState(rootPath, {
      expanded: [...expanded],
      scrollTop: scrollRef.current?.scrollTop ?? 0,
    });
  }, [expanded, hydratedRoot, rootPath]);

  // Scroll-only changes don't touch `expanded` - save them separately, debounced
  // so a fling doesn't write on every frame.
  const scrollSaveTimer = useRef<number | undefined>(undefined);
  const onTreeScroll = useCallback(() => {
    if (hydratedRoot !== rootPath) return;
    window.clearTimeout(scrollSaveTimer.current);
    scrollSaveTimer.current = window.setTimeout(() => {
      saveExplorerTreeState(rootPath, {
        expanded: [...expandedRef.current],
        scrollTop: scrollRef.current?.scrollTop ?? 0,
      });
    }, 200);
  }, [hydratedRoot, rootPath]);
  useEffect(() => () => window.clearTimeout(scrollSaveTimer.current), []);

  // "Show in file explorer" (a tab's context menu): expand the folders down to
  // the file and scroll its row into view (the row highlights via the active-tab
  // tracking above - the menu selects the tab before revealing). The row exists
  // only once the expanded folders finish loading - retry for a moment, same as
  // the scroll restore on mount.
  useEffect(
    () =>
      registerExplorerReveal(rootPath, (filePath) => {
        if (!isPathInside(filePath, rootPath) || filePath === rootPath) return;
        const dirs: string[] = [];
        for (let dir = parentDir(filePath); isPathInside(dir, rootPath); dir = parentDir(dir)) {
          dirs.push(dir);
          if (dir === rootPath) break;
        }
        setExpanded((prev) => {
          const next = new Set(prev);
          dirs.forEach((dir) => next.add(dir));
          return next.size === prev.size ? prev : next;
        });
        for (const dir of dirs) if (!childrenRef.current[dir]) void loadDir(dir);
        const deadline = performance.now() + 1500;
        const scrollToRow = (): void => {
          const row = scrollRef.current?.querySelector(`[data-path="${CSS.escape(filePath)}"]`);
          if (row) {
            row.scrollIntoView({ block: 'center' });
            return;
          }
          if (performance.now() < deadline) requestAnimationFrame(scrollToRow);
        };
        requestAnimationFrame(scrollToRow);
      }),
    [rootPath, loadDir],
  );

  // Refresh the tree when the project changes on disk (outside the app). Reloads
  // only the loaded directories whose contents could have changed, so the tree
  // reflects external creates/deletes/renames without a manual refresh.
  useEffect(() => {
    const fs = window.api?.fs;
    if (!fs?.onChanged) return;
    return fs.onChanged((root, paths) => {
      if (root !== rootPath) return;
      const loaded = childrenRef.current;
      const dirs = new Set<string>();
      if (paths.length === 0) {
        // No specific paths (e.g. a coalesced burst) - refresh all loaded dirs.
        for (const dir in loaded) dirs.add(dir);
      } else {
        for (const p of paths) {
          const parent = parentDir(p);
          if (parent in loaded) dirs.add(parent);
          if (p in loaded) dirs.add(p); // the changed path is itself a loaded dir
        }
      }
      dirs.forEach((dir) => void loadDir(dir));
    });
  }, [rootPath, loadDir]);

  // A project on a host that was away (a relaunch whose first connect outlasted
  // main's wait, a drop): what failed meanwhile reads again once the host is
  // connected - the root and every folder the tree shows or had open. Main
  // re-arms the watch on the new connection itself, so later changes arrive
  // as before; this catches up on what changed while it was away.
  useEffect(() => {
    if (!rootHost) return;
    return onHostConnected((hostId) => {
      if (hostId !== rootHost) return;
      const dirs = new Set([rootPath, ...expandedRef.current, ...Object.keys(childrenRef.current)]);
      dirs.forEach((dir) => {
        if (isPathInside(dir, rootPath)) void loadDir(dir);
      });
    });
  }, [rootHost, rootPath, loadDir]);

  // Drop cached children / expansion for a path that no longer exists (after a
  // rename or delete), so stale entries can't linger in the tree.
  const pruneState = useCallback((removedPath: string) => {
    setChildrenByPath((prev) => {
      let changed = false;
      const next: Record<string, DirEntry[]> = {};
      for (const key in prev) {
        if (isPathInside(key, removedPath)) changed = true;
        else next[key] = prev[key];
      }
      return changed ? next : prev;
    });
    setExpanded((prev) => {
      const next = new Set([...prev].filter((p) => !isPathInside(p, removedPath)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  const toggleFolder = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!childrenByPath[path]) void loadDir(path);
        }
        return next;
      });
    },
    [childrenByPath, loadDir],
  );

  const expandAndLoad = useCallback(
    (path: string) => {
      setExpanded((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
      if (!childrenByPath[path]) void loadDir(path);
    },
    [childrenByPath, loadDir],
  );

  // Files dropped from this computer (plan 29 spec › 9.3): copied on this
  // machine for a local root, uploaded for a host's; the folder they landed
  // in opens and re-reads (the watcher would get there too, a moment later).
  const upload = useExplorerUpload(hostLabel, (dir) => {
    if (dir !== rootPath) expandAndLoad(dir);
    void loadDir(dir);
  });
  const dropDirOf = (target: EventTarget | null): string => {
    const el = target instanceof Element ? target.closest<HTMLElement>('[data-drop-dir]') : null;
    return el?.dataset.dropDir ?? rootPath;
  };
  const onTreeDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(e.dataTransfer?.types)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const dir = dropDirOf(e.target);
    setDropTarget((prev) => (prev === dir ? prev : dir));
  };
  const onTreeDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    setDropTarget(null);
  };
  const onTreeDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(e.dataTransfer?.types)) return;
    e.preventDefault();
    const dir = dropDirOf(e.target);
    setDropTarget(null);
    // The renderer never reads the bytes: main copies by path.
    const pathOf = window.api?.files?.pathOf;
    const paths = pathOf
      ? Array.from(e.dataTransfer.files)
          .map((f) => pathOf(f))
          .filter((p) => p.length > 0)
      : [];
    if (paths.length > 0) void upload.drop(paths, dir);
  };

  const collapse = useCallback((path: string) => {
    setExpanded((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  // Tree keyboard navigation (rows are the focusable buttons, marked
  // `data-focus-item`; see lib/workspace/focus-regions.ts): ↑/↓ walk the
  // visible rows, → expands a folder (or steps into an open one), ← collapses
  // an open folder or climbs to the parent. Enter/Space are the rows' own
  // click - open the file, toggle the folder - so walking never opens anything
  // by itself. The inline create/rename inputs keep their keys.
  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.closest('[role="menu"]')) return;
    const item = target.closest<HTMLElement>('[data-focus-item]');
    const step = (delta: 1 | -1): void => {
      const next = stepFocusItem(e.currentTarget, target, delta);
      if (!next) return;
      e.preventDefault();
      next.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
        step(1);
        return;
      case 'ArrowUp':
        step(-1);
        return;
      case 'ArrowRight': {
        const path = item?.dataset.focusKey;
        if (!path || item?.dataset.treeDir !== 'true') return;
        e.preventDefault();
        if (expanded.has(path)) step(1);
        else expandAndLoad(path);
        return;
      }
      case 'ArrowLeft': {
        const path = item?.dataset.focusKey;
        if (!path) return;
        e.preventDefault();
        if (item?.dataset.treeDir === 'true' && expanded.has(path)) {
          collapse(path);
          return;
        }
        if (path !== rootPath) findFocusItem(e.currentTarget, parentDir(path))?.focus();
        return;
      }
    }
  };
  const currentPath = focusedPath ?? activeFilePath ?? rootPath;

  const beginCreate = useCallback(
    (parentPath: string, kind: 'file' | 'folder') => {
      setRenaming(null);
      if (parentPath !== rootPath) expandAndLoad(parentPath);
      setCreating({ parentPath, kind });
    },
    [rootPath, expandAndLoad],
  );

  const beginRename = useCallback(
    (entry: DirEntry, parentPath: string) => {
      setCreating(null);
      setRenaming({
        path: entry.path,
        parentPath,
        isDirectory: entry.isDirectory,
        wasOpen: expanded.has(entry.path),
      });
    },
    [expanded],
  );

  const submitRename = useCallback(
    async (rawName: string) => {
      const r = renaming;
      setRenaming(null);
      const name = rawName.trim();
      if (!r || !name || !hasBridge || name === fileName(r.path)) return;
      const target = joinPath(r.parentPath, name);
      const res = await window.api!.fs.rename(r.path, target);
      if (res.error) {
        void alertDialog({ title: 'Could not rename', description: res.error });
        return;
      }
      // Keep any open editor tabs pointed at the moved file(s).
      remapEditorPaths(r.path, target);
      pruneState(r.path);
      await loadDir(r.parentPath);
      // Re-open a renamed folder that was expanded, so the tree doesn't collapse it.
      if (r.isDirectory && r.wasOpen) expandAndLoad(target);
    },
    [renaming, hasBridge, remapEditorPaths, pruneState, loadDir, expandAndLoad],
  );

  const deleteEntry = useCallback(
    async (entry: DirEntry, parentPath: string) => {
      if (!hasBridge) return;
      const kind = entry.isDirectory ? 'folder' : 'file';
      const ok = await confirmDialog({
        title: `Delete ${kind} “${entry.name}”?`,
        description: 'It will be moved to the Trash.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      const res = await window.api!.fs.delete(entry.path);
      if (res.error) {
        void alertDialog({ title: 'Could not delete', description: res.error });
        return;
      }
      closeEditorsUnder(entry.path);
      pruneState(entry.path);
      await loadDir(parentPath);
    },
    [hasBridge, closeEditorsUnder, pruneState, loadDir],
  );

  const submitCreate = useCallback(
    async (rawName: string) => {
      const c = creating;
      setCreating(null);
      const name = rawName.trim();
      if (!c || !name || !hasBridge) return;
      const target = joinPath(c.parentPath, name);
      const res =
        c.kind === 'file'
          ? await window.api!.fs.createFile(target)
          : await window.api!.fs.createDir(target);
      if (res.error) {
        void alertDialog({
          title: c.kind === 'file' ? 'Could not create file' : 'Could not create folder',
          description: res.error,
        });
        return;
      }
      await loadDir(c.parentPath);
      if (c.kind === 'file') openFile(target);
      else expandAndLoad(target);
    },
    [creating, hasBridge, loadDir, openFile, expandAndLoad],
  );

  // Recursively build the rows for a directory's contents at the given depth,
  // splicing in the inline create-input where it belongs.
  const renderChildren = (path: string, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    if (creating?.parentPath === path) {
      out.push(
        <CreateRow
          key={`__new-${path}`}
          depth={depth}
          kind={creating.kind}
          onCommit={submitCreate}
          onCancel={() => setCreating(null)}
        />,
      );
    }
    // A failed read renders in place of the children (even stale ones), so an
    // errored folder is clearly distinct from an empty one.
    const dirError = dirErrors[path];
    if (dirError) {
      out.push(
        <div
          key={`__error-${path}`}
          title={dirError}
          className={cn(ROW, 'text-destructive')}
          style={indent(depth)}
        >
          <span className="w-[1em] shrink-0" />
          <span className="truncate italic">{dirError}</span>
        </div>,
      );
      return out;
    }
    const entries = childrenByPath[path];
    if (!entries) {
      if (loading.has(path)) {
        out.push(
          <div
            key={`__loading-${path}`}
            className={cn(ROW, 'text-foreground-subtle')}
            style={indent(depth)}
          >
            <Loader2 className="size-[1em] animate-spin" />
            <span>Loading…</span>
          </div>,
        );
      }
      return out;
    }
    if (entries.length === 0 && creating?.parentPath !== path) {
      out.push(
        <div
          key={`__empty-${path}`}
          className={cn(ROW, 'text-foreground-subtle')}
          style={indent(depth)}
        >
          <span className="italic">empty</span>
        </div>,
      );
    }
    for (const entry of entries) {
      if (renaming?.path === entry.path) {
        out.push(
          <RenameRow
            key={entry.path}
            depth={depth}
            entry={entry}
            onCommit={submitRename}
            onCancel={() => setRenaming(null)}
          />,
        );
        continue;
      }
      if (entry.isDirectory) {
        const isOpen = expanded.has(entry.path);
        out.push(
          <EntryMenu
            key={entry.path}
            path={entry.path}
            rootPath={rootPath}
            onNewSession={onNewSessionAt && (() => onNewSessionAt(entry.path))}
            onRename={() => beginRename(entry, path)}
            onDelete={() => deleteEntry(entry, path)}
            onRevealInOs={revealable ? () => void revealInOs(entry.path) : undefined}
          >
            <FolderRow
              entry={entry}
              depth={depth}
              dropping={dropTarget === entry.path}
              isOpen={isOpen}
              isCurrent={entry.path === currentPath}
              mark={dirMark(entry.path)}
              onToggle={() => toggleFolder(entry.path)}
              draggable
              onDragStart={(e) => startPathDrag(e, rootHost, entry.path)}
              onNewFile={() => beginCreate(entry.path, 'file')}
              onNewFolder={() => beginCreate(entry.path, 'folder')}
            />
          </EntryMenu>,
        );
        if (isOpen) out.push(...renderChildren(entry.path, depth + 1));
      } else {
        const { Icon, color } = fileIcon(entry.name);
        const mark = gitMarks.files.get(entry.path);
        out.push(
          <EntryMenu
            key={entry.path}
            path={entry.path}
            rootPath={rootPath}
            onRename={() => beginRename(entry, path)}
            onDelete={() => deleteEntry(entry, path)}
            onRevealInOs={revealable ? () => void revealInOs(entry.path) : undefined}
            onOpenInBrowser={
              // Browser tabs are Pro (a private plan › M5): no menu item without one.
              openBrowser && browserPreviewable(entry.path)
                ? () => openInBrowser(entry.path)
                : undefined
            }
          >
            <button
              type="button"
              title={entry.name}
              data-path={entry.path}
              data-drop-dir={path}
              data-focus-item
              data-focus-key={entry.path}
              data-focus-current={entry.path === currentPath || undefined}
              draggable
              onDragStart={(e) => startPathDrag(e, rootHost, entry.path)}
              onClick={() => openFile(entry.path)}
              className={cn(
                ROW,
                'text-left outline-none transition-colors kbd-focus:ring-1 kbd-focus:ring-inset kbd-focus:ring-primary',
                entry.path === activeFilePath
                  ? 'bg-accent text-foreground'
                  : mark
                    ? 'text-foreground hover:bg-muted/60'
                    : 'text-foreground-muted hover:bg-muted/60 hover:text-foreground',
              )}
              style={indent(depth)}
            >
              <span className="w-[1em] shrink-0" />
              <Icon className={cn('size-[1em] shrink-0', color)} />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {mark && (
                <span
                  className={cn(
                    'shrink-0 text-[length:calc(1em_-_2px)] font-semibold',
                    letterClass(mark),
                  )}
                >
                  {mark}
                </span>
              )}
            </button>
          </EntryMenu>,
        );
      }
    }
    return out;
  };

  const rootName = fileName(rootPath);
  const rootOpen = expanded.has(rootPath);

  return (
    <div
      data-focus-region="explorer"
      className="group/region flex size-full flex-col bg-surface focus-frame"
      style={fontStyle}
    >
      {/* Header - the label tints primary while the tree holds keyboard focus. */}
      <div className="flex items-center justify-between border-b border-border pb-2 pl-3 pr-2.5 pt-2.5">
        <span className="font-mono text-[length:calc(10px*var(--ui-font-scale,1))] font-semibold tracking-[1px] text-foreground-subtle region-kbd-focus:text-primary">
          EXPLORER
        </span>
        <div className="flex items-center gap-1">
          <HeaderButton label="Refresh" onClick={() => void refreshAll()}>
            <RotateCw className={cn('size-3', refreshing && 'animate-spin')} />
          </HeaderButton>
          <HeaderButton label="New file" onClick={() => beginCreate(rootPath, 'file')}>
            <FilePlus className="size-3.5" />
          </HeaderButton>
          <HeaderButton label="New folder" onClick={() => beginCreate(rootPath, 'folder')}>
            <FolderPlus className="size-3.5" />
          </HeaderButton>
        </div>
      </div>

      {/* Tree */}
      <div
        ref={scrollRef}
        onScroll={onTreeScroll}
        onKeyDown={onTreeKeyDown}
        onDragOver={onTreeDragOver}
        onDragLeave={onTreeDragLeave}
        onDrop={onTreeDrop}
        data-testid="explorer-tree"
        onFocusCapture={(e) => {
          const key = (e.target as HTMLElement).closest<HTMLElement>('[data-focus-item]')?.dataset
            .focusKey;
          if (key) setFocusedPath(key);
        }}
        className="min-h-0 flex-1 overflow-y-auto py-1.5"
      >
        {rootError ? (
          <div className="px-3 py-2 font-mono text-foreground-muted">
            {/* Away only because its connect is still running: it reads
                again once connected (onHostConnected above). */}
            {rootError === 'Host is unreachable' &&
            (rootHostState === 'connecting' || rootHostState === 'installing')
              ? `Connecting to ${hostLabel}…`
              : rootError}
          </div>
        ) : (
          <>
            <button
              type="button"
              title={rootPath}
              data-focus-item
              data-focus-key={rootPath}
              data-drop-dir={rootPath}
              data-dropping={dropTarget === rootPath || undefined}
              data-tree-dir="true"
              data-focus-current={rootPath === currentPath || undefined}
              onClick={() => toggleFolder(rootPath)}
              className={cn(
                ROW,
                'text-left font-semibold text-foreground outline-none hover:bg-muted/60 kbd-focus:ring-1 kbd-focus:ring-inset kbd-focus:ring-primary',
                dropTarget === rootPath && 'bg-primary/15 ring-1 ring-inset ring-primary',
              )}
              style={indent(0)}
            >
              {rootOpen ? (
                <ChevronDown className="size-[1em] shrink-0 text-foreground-muted" />
              ) : (
                <ChevronRight className="size-[1em] shrink-0 text-foreground-muted" />
              )}
              <FolderOpen className="size-[1em] shrink-0 text-primary" />
              <span className="truncate">{rootName}</span>
            </button>
            {rootOpen && renderChildren(rootPath, 1)}
          </>
        )}
      </div>
      {upload.run && (
        <UploadFooter run={upload.run} hostLabel={hostLabel} onCancel={upload.cancel} />
      )}
      {watchMode === 'poll' && (
        // A Linux host past its inotify budget polls the tree instead of
        // watching it: changes show up within seconds, not at once.
        <div
          data-testid="explorer-watch-mode"
          className="shrink-0 border-t border-border px-3 py-1 font-mono text-[length:calc(10px*var(--ui-font-scale,1))] text-foreground-subtle"
          title="This folder is too large to watch on the host, so it is checked every few seconds"
        >
          polling (large tree)
        </div>
      )}
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-5 items-center justify-center rounded text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

// forwardRef + prop spread so it can serve as a Radix context-menu `asChild`
// trigger (which injects `onContextMenu`, `ref`, etc. onto its child).
const FolderRow = forwardRef<
  HTMLDivElement,
  {
    entry: DirEntry;
    depth: number;
    isOpen: boolean;
    /** Files dragged from outside the window would land in this folder. */
    dropping?: boolean;
    /** The row keyboard focus returns to when the explorer is re-entered. */
    isCurrent?: boolean;
    /** Aggregated git status letter for the folder's contents. */
    mark?: string;
    onToggle: () => void;
    onNewFile: () => void;
    onNewFolder: () => void;
  } & React.HTMLAttributes<HTMLDivElement>
>(function FolderRow(
  {
    entry,
    depth,
    isOpen,
    dropping,
    isCurrent,
    mark,
    onToggle,
    onNewFile,
    onNewFolder,
    className,
    ...rest
  },
  ref,
) {
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  const FolderIcon = isOpen ? FolderOpen : Folder;
  return (
    <div
      ref={ref}
      {...rest}
      data-drop-dir={entry.path}
      data-dropping={dropping || undefined}
      // The keyboard focus ring sits on the whole row, not just the toggle
      // button (the row also holds the hover actions).
      className={cn(
        ROW,
        'group text-foreground hover:bg-muted/60 kbd-focus-within:ring-1 kbd-focus-within:ring-inset kbd-focus-within:ring-primary',
        dropping && 'bg-primary/15 ring-1 ring-inset ring-primary',
        className,
      )}
      style={indent(depth)}
    >
      <button
        type="button"
        title={entry.name}
        data-focus-item
        data-focus-key={entry.path}
        data-tree-dir="true"
        data-focus-current={isCurrent || undefined}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none"
      >
        <Chevron className="size-[1em] shrink-0 text-foreground-muted" />
        <FolderIcon className="size-[1em] shrink-0 text-[#fbbf24]" />
        <span className="min-w-0 flex-1 truncate font-medium">{entry.name}</span>
        {mark && (
          <span
            className={cn(
              'shrink-0 text-[length:calc(1em_-_2px)] font-semibold',
              letterClass(mark),
            )}
          >
            {mark}
          </span>
        )}
      </button>
      {/* Hover actions: create inside this folder. Also shown while focus is
          anywhere in the row, so they're reachable by keyboard (Tab from the
          folder button reveals them, then reaches them). */}
      <div className="hidden shrink-0 items-center gap-1 group-focus-within:flex group-hover:flex">
        <button
          type="button"
          aria-label={`New file in ${entry.name}`}
          title="New file"
          onClick={onNewFile}
          className="flex size-4 items-center justify-center rounded text-foreground-muted outline-none hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground"
        >
          <FilePlus className="size-3" />
        </button>
        <button
          type="button"
          aria-label={`New folder in ${entry.name}`}
          title="New folder"
          onClick={onNewFolder}
          className="flex size-4 items-center justify-center rounded text-foreground-muted outline-none hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground"
        >
          <FolderPlus className="size-3" />
        </button>
      </div>
    </div>
  );
});

/**
 * A row dragged out of the tree: its path for a terminal (lib/terminal/file-drop.ts,
 * with the machine it lives on) and as plain text for anything else.
 */
function startPathDrag(e: React.DragEvent, hostId: string | null, path: string): void {
  e.dataTransfer.setData(EXPLORER_DRAG_MIME, encodeExplorerDrag({ hostId, paths: [path] }));
  e.dataTransfer.setData('text/plain', path);
  e.dataTransfer.effectAllowed = 'copy';
}

function CreateRow({
  depth,
  kind,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: 'file' | 'folder';
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Guard so committing on Enter doesn't also commit again on the resulting blur.
  const done = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const finish = (commit: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(inputRef.current?.value ?? '');
    else onCancel();
  };
  const Icon = kind === 'folder' ? Folder : File;
  return (
    <div className={cn(ROW, 'text-foreground')} style={indent(depth)}>
      <span className="w-[1em] shrink-0" />
      <Icon className="size-[1em] shrink-0 text-foreground-subtle" />
      <input
        ref={inputRef}
        type="text"
        spellCheck={false}
        placeholder={kind === 'folder' ? 'folder name' : 'file name'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
        className="min-w-0 flex-1 rounded-sm border border-primary/60 bg-input px-1 py-0.5 text-foreground outline-none"
      />
    </div>
  );
}

/** Right-click menu for a tree entry: new session (folders), reveal in the OS
 * file manager, copy its path, rename, delete. */
function EntryMenu({
  path,
  rootPath,
  onNewSession,
  onRevealInOs,
  onOpenInBrowser,
  onRename,
  onDelete,
  children,
}: {
  /** The entry's absolute path (a host path for a remote root). */
  path: string;
  /** The explorer's root - "Copy relative path" is relative to it. */
  rootPath: string;
  /** Open a new session rooted at this folder; only passed for folder rows. */
  onNewSession?: () => void;
  /** Open the file in a browser tab; only for files a browser can show. */
  onOpenInBrowser?: () => void;
  /** Reveal in the OS file manager; absent for a file on a remote host. */
  onRevealInOs?: () => void;
  onRename: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {onNewSession && (
          <ContextMenuItem
            // Defer to the next tick so the context menu finishes closing (and
            // releases Radix's `body { pointer-events: none }` lock) before the
            // New Session dialog opens - opening a modal synchronously here
            // strands that lock and freezes the whole app.
            onSelect={() => setTimeout(onNewSession, 0)}
          >
            <SquareTerminal />
            New session here
          </ContextMenuItem>
        )}
        {onRevealInOs && (
          <ContextMenuItem onSelect={onRevealInOs}>
            <FolderOpen />
            {REVEAL_IN_OS_LABEL}
          </ContextMenuItem>
        )}
        {onOpenInBrowser && (
          <ContextMenuItem onSelect={onOpenInBrowser}>
            <Globe />
            Open in browser tab
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(path)}>
          <Copy />
          Copy path
        </ContextMenuItem>
        {isWithin(path, rootPath) && (
          <ContextMenuItem
            onSelect={() => void navigator.clipboard?.writeText(relativeTo(path, rootPath))}
          >
            <Copy />
            Copy relative path
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onRename}>
          <Pencil />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          // Same deferral as above - deleting opens a confirm dialog.
          onSelect={() => setTimeout(onDelete, 0)}
        >
          <Trash2 />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Inline rename input shown in place of an entry's row. */
function RenameRow({
  depth,
  entry,
  onCommit,
  onCancel,
}: {
  depth: number;
  entry: DirEntry;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Guard so committing on Enter doesn't also commit again on the resulting blur.
  const done = useRef(false);
  // Focus on the next frame so it wins over the context menu's close-focus, then
  // preselect the base name (sans extension) for files.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.focus();
      const dot = entry.name.lastIndexOf('.');
      if (!entry.isDirectory && dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [entry]);
  const finish = (commit: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(inputRef.current?.value ?? '');
    else onCancel();
  };
  const { Icon, color } = entry.isDirectory
    ? { Icon: Folder, color: 'text-[#fbbf24]' }
    : fileIcon(entry.name);
  return (
    <div className={cn(ROW, 'text-foreground')} style={indent(depth)}>
      <span className="w-[1em] shrink-0" />
      <Icon className={cn('size-[1em] shrink-0', color)} />
      <input
        ref={inputRef}
        type="text"
        spellCheck={false}
        defaultValue={entry.name}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
        className="min-w-0 flex-1 rounded-sm border border-primary/60 bg-input px-1 py-0.5 text-foreground outline-none"
      />
    </div>
  );
}

/** Same listing, entry for entry (readDir returns plain data in a stable order). */
function sameEntries(a: DirEntry[], b: DirEntry[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}
