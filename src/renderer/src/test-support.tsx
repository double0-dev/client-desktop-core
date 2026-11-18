import type { SessionViewSlot, HostsSlot, RendererExtension } from '@renderer/lib/extension/types';
import { vi } from 'vitest';
import type { ReactNode } from 'react';
import {
  WorkspaceLayoutContext,
  type WorkspaceLayoutContextValue,
} from '@renderer/lib/workspace/layout-context';
import { initialLayout } from '@renderer/lib/workspace/layout';

/**
 * Shared scaffolding for component tests.
 *
 * Route components sit on two things jsdom cannot provide: the preload bridge
 * (`window.api`) and the workspace contexts. Rather than each test inventing
 * its own stubs, they compose these - so a bridge signature change breaks in
 * one place instead of a dozen.
 *
 * Excluded from coverage (see vitest.config.ts); it is test scaffolding, not
 * shipped code.
 */

// --- an in-memory filesystem behind window.api.fs -----------------------------

export type FsTree = { [name: string]: FsTree | string };

type DirEntry = { name: string; path: string; isDirectory: boolean; isRepo?: boolean };

/** Walk a slash-separated path into the tree, or null when it is not there. */
function at(tree: FsTree, root: string, path: string): FsTree | string | null {
  if (path === root) return tree;
  if (!path.startsWith(`${root}/`)) return null;
  let node: FsTree | string = tree;
  for (const part of path.slice(root.length + 1).split('/')) {
    if (typeof node === 'string' || !(part in node)) return null;
    node = node[part];
  }
  return node;
}

/**
 * A `window.api.fs` backed by a plain object: `{ 'src': { 'a.ts': 'code' } }`.
 * Directories are objects, files are their string contents. Every call records
 * on the returned spies so tests can assert on what was asked for.
 */
export function fakeFs(root: string, tree: FsTree) {
  const state: FsTree = structuredClone(tree);
  const watchers = new Set<(payload: unknown) => void>();

  const readDir = vi.fn(
    async (path: string, opts?: { dirsOnly?: boolean; markRepos?: boolean }) => {
      const node = at(state, root, path);
      if (node === null) return { error: `ENOENT: ${path}`, code: 'ENOENT' };
      if (typeof node === 'string') return { error: 'Not a directory', code: 'ENOTDIR' };
      const entries: DirEntry[] = Object.entries(node)
        .map(([name, value]) => {
          const isDirectory = typeof value !== 'string';
          // A folder is a repo when it holds a `.git` - same rule as the real
          // bridge, so a tree can express the folder-of-repos case.
          const isRepo = isDirectory && '.git' in (value as FsTree);
          return {
            name,
            path: `${path}/${name}`,
            isDirectory,
            ...(opts?.markRepos && isRepo ? { isRepo: true } : {}),
          };
        })
        .filter((entry) => entry.name !== '.git' && (!opts?.dirsOnly || entry.isDirectory))
        // Directories first, then alphabetical - what the real bridge returns.
        .sort((a, b) =>
          a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
        );
      return { entries };
    },
  );

  const readFile = vi.fn(async (path: string) => {
    const node = at(state, root, path);
    if (typeof node !== 'string') return { error: `ENOENT: ${path}`, code: 'ENOENT' };
    return { content: node };
  });

  const parentOf = (path: string): { dir: FsTree | null; name: string } => {
    const cut = path.lastIndexOf('/');
    const dir = at(state, root, path.slice(0, cut));
    return { dir: typeof dir === 'object' && dir !== null ? dir : null, name: path.slice(cut + 1) };
  };

  const createFile = vi.fn(async (path: string) => {
    const { dir, name } = parentOf(path);
    if (!dir) return { error: 'ENOENT', code: 'ENOENT' };
    dir[name] = '';
    return { ok: true as const };
  });

  const createDir = vi.fn(async (path: string) => {
    const { dir, name } = parentOf(path);
    if (!dir) return { error: 'ENOENT', code: 'ENOENT' };
    dir[name] = {};
    return { ok: true as const };
  });

  const rename = vi.fn(async (from: string, to: string) => {
    const src = parentOf(from);
    const dst = parentOf(to);
    if (!src.dir || !dst.dir || !(src.name in src.dir)) return { error: 'ENOENT', code: 'ENOENT' };
    dst.dir[dst.name] = src.dir[src.name];
    delete src.dir[src.name];
    return { ok: true as const };
  });

  const remove = vi.fn(async (path: string) => {
    const { dir, name } = parentOf(path);
    if (!dir || !(name in dir)) return { error: 'ENOENT', code: 'ENOENT' };
    delete dir[name];
    return { ok: true as const };
  });

  const writeFile = vi.fn(async (path: string, content: string) => {
    const { dir, name } = parentOf(path);
    if (!dir) return { error: 'ENOENT', code: 'ENOENT' };
    dir[name] = content;
    return { ok: true as const };
  });

  // The explorer's drop (main's `fs:upload`, plan 29 spec › 9.3), simulated
  // over the tree: each dropped path lands as a file named after it, holding
  // `dropped:<path>`; a taken name answers `{ clash }` while `onClash` is 'ask'.
  const progressListeners = new Set<(p: unknown) => void>();
  const upload = vi.fn(
    async (args: {
      uploadId: string;
      paths: string[];
      destDir: string;
      onClash: 'ask' | 'replace' | 'skip' | 'keep-both';
    }): Promise<Record<string, unknown>> => {
      const dir = at(state, root, args.destDir);
      if (!dir || typeof dir === 'string') return { error: 'Not a folder', code: 'ENOTDIR' };
      const names = args.paths.map((p) => p.slice(p.lastIndexOf('/') + 1));
      const taken = names.filter((n) => n in dir);
      if (args.onClash === 'ask' && taken.length > 0) {
        return { clash: { name: taken[0], count: taken.length } };
      }
      const copied: string[] = [];
      const skipped: { path: string; reason: string }[] = [];
      names.forEach((name, i) => {
        let target = name;
        if (name in dir) {
          if (args.onClash === 'skip') {
            skipped.push({ path: name, reason: 'already there' });
            return;
          }
          if (args.onClash === 'keep-both') {
            for (let n = 2; target in dir; n++) target = `${name} (${n})`;
          }
        }
        dir[target] = `dropped:${args.paths[i]}`;
        copied.push(target);
      });
      return { ok: true, copied, skipped, errors: [] };
    },
  );

  const api = {
    readDir,
    readFile,
    upload,
    uploadCancel: vi.fn(async () => ({ ok: true })),
    onUploadProgress: vi.fn((cb: (p: unknown) => void) => {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    }),
    readFileBinary: vi.fn(async () => ({ bytes: new Uint8Array() })),
    writeFile,
    createFile,
    createDir,
    rename,
    delete: remove,
    showInFolder: vi.fn(async (path: string) =>
      parentOf(path).dir && parentOf(path).name in parentOf(path).dir!
        ? { ok: true as const }
        : { error: 'ENOENT', code: 'ENOENT' },
    ),
    watch: vi.fn(async () => ({ ok: true as const })),
    unwatch: vi.fn(async () => ({ ok: true as const })),
    onChanged: vi.fn((cb: (payload: unknown) => void) => {
      watchers.add(cb);
      return () => watchers.delete(cb);
    }),
  };

  return {
    api,
    state,
    notifyChanged: (payload: unknown) => watchers.forEach((cb) => cb(payload)),
    /** Push an `fs:uploadProgress` as main would. */
    uploadProgress: (payload: unknown) => progressListeners.forEach((cb) => cb(payload)),
  };
}

// --- an in-memory database behind window.api.db -------------------------------

export type DbRow = Record<string, unknown> & { id: string };
export type DbChange =
  | { table: string; type: 'insert' | 'update'; row: unknown }
  | { table: string; type: 'delete'; id: string };

/**
 * A `window.api.db` backed by per-table Maps. It broadcasts `db:change` BEFORE
 * resolving each call, exactly like src/main/db/ipc.ts - which is what the
 * TanStack DB collections rely on to confirm an optimistic write.
 *
 * Returns the api plus the `tables` map, so a test can assert on stored rows
 * (`tables.get('tasks')`) or seed them before rendering.
 */
const fakeDbListeners = new Set<(change: DbChange) => void>();
export function fakeDb() {
  const tables = new Map<string, Map<string, DbRow>>();
  const listeners = fakeDbListeners;
  const table = (name: string): Map<string, DbRow> => {
    const existing = tables.get(name);
    if (existing) return existing;
    const created = new Map<string, DbRow>();
    tables.set(name, created);
    return created;
  };
  const broadcast = (change: DbChange): void => {
    for (const cb of listeners) cb(change);
  };

  const api = {
    list: vi.fn(async (name: string) => [...table(name).values()]),
    insert: vi.fn(async (name: string, row: DbRow) => {
      table(name).set(row.id, row);
      broadcast({ table: name, type: 'insert', row });
      return row;
    }),
    update: vi.fn(async (name: string, id: string, patch: Record<string, unknown>) => {
      const row = { ...(table(name).get(id) as DbRow), ...patch, id };
      table(name).set(id, row);
      broadcast({ table: name, type: 'update', row });
      return row;
    }),
    remove: vi.fn(async (name: string, id: string) => {
      table(name).delete(id);
      broadcast({ table: name, type: 'delete', id });
      return { ok: true as const };
    }),
    onChange: vi.fn((cb: (change: DbChange) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
  };

  return { api, tables, rows: (name: string): DbRow[] => [...table(name).values()] };
}

// --- the preload bridge -------------------------------------------------------

/**
 * Install a `window.api` with inert defaults, merged with whatever the test
 * cares about. Returns the installed object so calls can be asserted.
 */
export function stubApi<T extends Record<string, unknown>>(overrides: T = {} as T) {
  const api = {
    fs: fakeFs('/repo', {}).api,
    db: {
      list: vi.fn(async () => []),
      insert: vi.fn(async (_t: string, row: unknown) => row),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => null),
      onChange: vi.fn(() => () => {}),
    },
    layout: { list: vi.fn(async () => []), save: vi.fn(async () => ({ ok: true })) },
    terminal: {
      write: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      onActivity: vi.fn(() => () => {}),
      onActivityExit: vi.fn(() => () => {}),
      markerDriven: vi.fn(async () => []),
      agentStatus: vi.fn(async () => []),
    },
    git: {},
    integrations: {
      getAll: vi.fn(async () => ({ states: null })),
      onChanged: vi.fn(() => () => {}),
    },
    app: { getVersion: vi.fn(async () => '0.1.0') },
    dialog: { openDirectory: vi.fn(), openFile: vi.fn(), saveFile: vi.fn() },
    // Settings › General › Open-source licences: a build with no notices file.
    notices: {
      list: vi.fn(async () => ({ ok: false, code: 'ENOENT' })),
      openPlatform: vi.fn(async () => false),
    },
    ...overrides,
  };
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api });
  return api;
}

// --- the workspace layout context ---------------------------------------------

/** Every callback on the layout context, as spies. */
export function fakeLayoutContext(
  sessionId = 'session-1',
  overrides: Partial<WorkspaceLayoutContextValue> = {},
): WorkspaceLayoutContextValue {
  return {
    layout: initialLayout(sessionId),
    dispatch: vi.fn(),
    addTerminal: vi.fn(),
    addTemplateTerminal: vi.fn(),
    splitWithNewTerminal: vi.fn(),
    openFile: vi.fn(),
    openBrowser: vi.fn(),
    closeTab: vi.fn(),
    closeTabs: vi.fn(),
    reopenClosedTab: vi.fn(() => false),
    dirtyTabs: new Set(),
    setTabDirty: vi.fn(),
    remapEditorPaths: vi.fn(),
    closeEditorsUnder: vi.fn(),
    ...overrides,
  } as WorkspaceLayoutContextValue;
}

/** Wrap a component in the workspace layout context. */
export function withLayout(
  ctx: WorkspaceLayoutContextValue,
): (props: { children: ReactNode }) => React.JSX.Element {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <WorkspaceLayoutContext value={ctx}>{children}</WorkspaceLayoutContext>;
  };
}

/**
 * The session-view and hosts slots as an extension fills them - each reading
 * its bridge off `window.api` (`sessionView`, `hosts`) - for tests that fake
 * those bridges there. Core
 * reads a bridge only through the slot (lib/session/view-bridge.ts,
 * lib/hosts/host-status.ts); merge into an extension a test installs anyway.
 * After `vi.resetModules()`, install it through the registry the module under
 * test will import (a dynamic import after the reset).
 */
export function bridgeSlots(base: Partial<RendererExtension> = {}): RendererExtension {
  const api = (): Record<string, unknown> | undefined =>
    (window as unknown as { api?: Record<string, unknown> }).api;
  return {
    edition: 'pro',
    railTools: [],
    ...base,
    sessionView: { ...base.sessionView, bridge: () => api()?.sessionView } as SessionViewSlot,
    hosts: { ...base.hosts, statusFeed: () => api()?.hosts } as HostsSlot,
  } as RendererExtension;
}
