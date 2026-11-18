import { ipcMain, shell, type WebContents } from 'electron';
import { type FSWatcher } from 'node:fs';

import nodePath from 'node:path';
import { isTrustedSender } from './ipc-util';
import {
  localRuntime,
  pathFor,
  runtimeFor,
  runtimeOfHost,
  runtimeReady,
  type HostWatcher,
} from './host-runtime';
import { linuxHasFileManager } from './file-manager';
import { runUpload, type ClashChoice } from './upload';

/**
 * Filesystem bridge for the workspace file explorer + editor. The renderer reads
 * directories/files and creates new files/folders rooted at a session's project
 * directory. This is a local developer tool whose terminals already grant full
 * shell (hence full filesystem) access, so these handlers don't sandbox paths -
 * they only validate shapes and surface errors instead of throwing across IPC.
 */

const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export type DirEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  /** Directory holding a `.git` - only set when the caller asks (`markRepos`).
   * The folder picker uses it to flag folders whose sessions branch on their
   * own repo rather than the project's. */
  isRepo?: boolean;
};

/** Above this many directory children, `markRepos` gives up rather than firing
 * a stat per entry - a folder that wide is never a hand-curated repo parent, and
 * the picker degrades to plain (unmarked) rows. */
const MAX_REPO_MARK_ENTRIES = 400;

// Error results carry a stable machine `code` alongside the human `error`
// message - Node's errno code where available ('ENOENT', 'EACCES', 'EEXIST'…)
// plus the app-level 'TOO_LARGE' | 'BINARY' | 'CONFLICT' - so the renderer can
// branch without matching message substrings.
type ErrResult = { error: string; code?: string };

/** Shape a caught fs error for the renderer (message + errno code if present). */
function errResult(err: unknown, fallback: string): ErrResult {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return {
    error: err instanceof Error ? err.message : fallback,
    ...(typeof code === 'string' ? { code } : {}),
  };
}

const INVALID_PATH: ErrResult = { error: 'Invalid path', code: 'EINVAL' };
const UNTRUSTED: ErrResult = { error: 'Untrusted sender', code: 'EACCES' };

// Path grammar by the machine the path is on (host-runtime.ts › pathFor): a
// remote host's paths stay POSIX on a Windows client.
const join = (first: string, ...rest: string[]): string => pathFor(first).join(first, ...rest);
const dirname = (p: string): string => pathFor(p).dirname(p);
const basename = (p: string): string => pathFor(p).basename(p);
const isAbsolute = (p: string): boolean => pathFor(p).isAbsolute(p);

/** The files of the machine `path` lives on (host-runtime.ts). */
const hostFs = (path: string) => runtimeFor(path).fs;

/** lstat-based existence check - sees broken symlinks too, unlike stat. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await hostFs(p).lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Files/dirs never worth showing in the tree (heavy, noisy, or never edited).
 * Exported so the cross-project search index (src/main/search.ts) ignores the
 * exact same set - search results then match what the explorer shows. */
export const HIDDEN = new Set(['.DS_Store', '.git', 'node_modules', '.svn', '.hg']);

/** A max file size we'll open in the editor (8 MB) - refuse larger to stay responsive. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** A separate, larger cap for raw reads (32 MB) - images are viewed, not edited,
 * so the editor's responsiveness concerns don't apply; this only bounds IPC. */
const MAX_BINARY_BYTES = 32 * 1024 * 1024;

const CHANNELS = [
  'fs:readDir',
  'fs:readFile',
  'fs:readFileOnHost',
  'fs:readFileBinary',
  'fs:writeFile',
  'fs:createFile',
  'fs:createDir',
  'fs:rename',
  'fs:delete',
  'fs:showInFolder',
  'fs:watch',
  'fs:unwatch',
  'fs:upload',
  'fs:uploadCancel',
] as const;

// --- Copies from this computer (the explorer's drop) ---------------------------
// a private plan › 9.3: dropped files and folders
// copied into a folder of the tree - on this machine for a local root, over
// the bridge for a host's (hosts/upload.ts holds the rules).

/** At most this many dropped top-level entries per call. */
export const MAX_UPLOAD_ENTRIES = 1000;
const UPLOAD_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const CLASH_CHOICES = new Set(['ask', 'replace', 'skip', 'keep-both']);

type Upload = { wcId: number; controller: AbortController };
const uploads = new Map<string, Upload>();

// --- Directory watching -----------------------------------------------------
// A recursive watcher per (window, root), ref-counted so several explorers in one
// window share one OS watcher. Change bursts are debounced and the affected
// absolute paths forwarded to the renderer, which refreshes the tree and any open
// editor tabs. Churny machine-managed dirs are ignored to keep volume sane.

type Watch = {
  watcher: FSWatcher;
  sender: WebContents;
  wcId: number;
  root: string;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
  paths: Set<string>;
  /** Folders this window read under the root (a polling remote watch reads them). */
  read: Set<string>;
};

const watchers = new Map<string, Watch>();
const watchKey = (wcId: number, root: string): string => `${wcId}::${root}`;
const IGNORED_SEGMENT = /(^|[/\\])(node_modules|\.git|\.DS_Store)([/\\]|$)/;

function closeWatch(entry: Watch): void {
  if (entry.timer) clearTimeout(entry.timer);
  try {
    entry.watcher.close();
  } catch {
    // already closed
  }
}

/** A remote watch's strategy for the `fs:watch` answer ({} for a local one). */
function modeOf(watcher: FSWatcher): { mode?: 'native' | 'poll' } {
  const mode = (watcher as unknown as Partial<HostWatcher>).mode;
  return mode ? { mode } : {};
}

/**
 * A window read folder `path`: a polling watch of that window covering it
 * reads it from now on (spec 11.2 `watchHint`). Local watches ignore it.
 */
function noteDirRead(wcId: number, path: string): void {
  for (const entry of watchers.values()) {
    if (entry.wcId !== wcId) continue;
    const w = entry.watcher as unknown as Partial<HostWatcher>;
    if (!w.hint) continue;
    if (path !== entry.root && !path.startsWith(`${entry.root}/`)) continue;
    entry.read.add(path);
    // The newest reads count: a long session's folders do not pile up forever.
    if (entry.read.size > 500) entry.read.delete(entry.read.values().next().value as string);
    w.hint([...entry.read]);
  }
}

/** Close every watcher owned by a window (called when that window is destroyed). */
export function disposeFsWatchersForWindow(wcId: number): void {
  // Its uploads stop too: nobody is left to see them through.
  for (const upload of uploads.values()) {
    if (upload.wcId === wcId) upload.controller.abort();
  }
  for (const [key, entry] of watchers) {
    if (entry.wcId === wcId) {
      closeWatch(entry);
      watchers.delete(key);
    }
  }
}

export function registerFsIpc(): () => void {
  // List a directory's immediate children: directories first, then files, each
  // alphabetical. Symlinks and unreadable entries are skipped rather than fatal.
  //
  // `dirsOnly` drops files (the folder picker only ever offers directories), and
  // `markRepos` flags the directories that are a git checkout of their own.
  ipcMain.handle(
    'fs:readDir',
    async (e, payload: { path?: unknown; dirsOnly?: unknown; markRepos?: unknown }) => {
      if (!isTrustedSender(e)) return UNTRUSTED;
      await runtimeReady();
      if (!isNonEmptyStr(payload?.path)) return INVALID_PATH;
      const dirsOnly = payload?.dirsOnly === true;
      try {
        const dirents = await hostFs(payload.path).readdir(payload.path, { withFileTypes: true });
        const entries: DirEntry[] = [];
        for (const d of dirents) {
          if (HIDDEN.has(d.name)) continue;
          let isDirectory = d.isDirectory();
          // Resolve symlinks so linked directories still expand.
          if (d.isSymbolicLink()) {
            try {
              isDirectory = (
                await hostFs(payload.path).stat(join(payload.path, d.name))
              ).isDirectory();
            } catch {
              continue; // dangling symlink
            }
          }
          if (dirsOnly && !isDirectory) continue;
          entries.push({ name: d.name, path: join(payload.path, d.name), isDirectory });
        }
        entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        // A `.git` entry is a directory in a normal checkout and a FILE inside a
        // linked worktree, so this tests existence rather than directory-ness.
        if (payload?.markRepos === true) {
          const dirs = entries.filter((entry) => entry.isDirectory);
          if (dirs.length <= MAX_REPO_MARK_ENTRIES) {
            await Promise.all(
              dirs.map(async (entry) => {
                if (await pathExists(join(entry.path, '.git'))) entry.isRepo = true;
              }),
            );
          }
        }
        // A remote tree watched by polling reads the folders the explorer
        // has open - and the explorer reads a folder as it expands it.
        noteDirRead(e.sender.id, payload.path);
        // A remote host cut a huge folder's listing: said, never silent.
        const truncated = (dirents as unknown as { truncated?: boolean }).truncated === true;
        return truncated ? { entries, truncated: true } : { entries };
      } catch (err) {
        return errResult(err, 'Could not read directory');
      }
    },
  );

  // Read a UTF-8 file for the editor. Refuse oversized files and (best-effort)
  // binary content, which CodeMirror can't meaningfully display.
  ipcMain.handle('fs:readFile', async (e, payload: { path?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    await runtimeReady();
    if (!isNonEmptyStr(payload?.path)) return INVALID_PATH;
    try {
      const fs = hostFs(payload.path);
      const info = await fs.stat(payload.path);
      if (info.isDirectory()) return { error: 'Path is a directory', code: 'EISDIR' };
      if (info.size > MAX_FILE_BYTES) {
        return { error: 'File is too large to open', code: 'TOO_LARGE' };
      }
      const buf = await fs.readFile(payload.path);
      // A NUL byte in the first chunk is a reliable binary heuristic.
      if (buf.subarray(0, 8000).includes(0)) return { error: 'binary', code: 'BINARY' };
      // Stat AFTER the read so the reported mtime can't predate the content -
      // it's the editor's conflict baseline for a later save.
      const after = await fs.stat(payload.path);
      return { content: buf.toString('utf8'), mtimeMs: after.mtimeMs };
    } catch (err) {
      return errResult(err, 'Could not read file');
    }
  });

  // A file on a named host, wherever it lies there (plan 29 spec › 12, 14): a
  // language server's go-to-definition into the host's `site-packages`, which
  // no project root covers - by path alone it would resolve to THIS machine.
  // Text only, the editor's cap; the renderer opens it read-only.
  ipcMain.handle('fs:readFileOnHost', async (e, payload: { hostId?: unknown; path?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    const hostId = payload?.hostId;
    const path = payload?.path;
    if (typeof hostId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(hostId)) {
      return { error: 'Invalid host', code: 'EINVAL' };
    }
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.includes('\0') ||
      path.length > 4096
    ) {
      return INVALID_PATH;
    }
    const runtime = runtimeOfHost(hostId);
    if (!runtime) return { error: 'Unknown host', code: 'EINVAL' };
    try {
      const info = await runtime.fs.stat(path);
      if (info.isDirectory()) return { error: 'Path is a directory', code: 'EISDIR' };
      if (info.size > MAX_FILE_BYTES) {
        return { error: 'File is too large to open', code: 'TOO_LARGE' };
      }
      const buf = await runtime.fs.readFile(path);
      if (buf.subarray(0, 8000).includes(0)) return { error: 'binary', code: 'BINARY' };
      return { content: buf.toString('utf8'), mtimeMs: info.mtimeMs };
    } catch (err) {
      return errResult(err, 'Could not read file');
    }
  });

  // Read a file's raw bytes - for content the renderer displays natively (the
  // image viewer) rather than as text, so no UTF-8/binary checks apply.
  ipcMain.handle('fs:readFileBinary', async (e, payload: { path?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    await runtimeReady();
    if (!isNonEmptyStr(payload?.path)) return INVALID_PATH;
    try {
      const fs = hostFs(payload.path);
      const info = await fs.stat(payload.path);
      if (info.isDirectory()) return { error: 'Path is a directory', code: 'EISDIR' };
      if (info.size > MAX_BINARY_BYTES) {
        return { error: 'File is too large to open', code: 'TOO_LARGE' };
      }
      return { bytes: await fs.readFile(payload.path) };
    } catch (err) {
      return errResult(err, 'Could not read file');
    }
  });

  // Overwrite a file with new contents (the editor's Save). If the editor passes
  // the mtime it read (`expectedMtimeMs`), refuse with code 'CONFLICT' when the
  // file changed - or vanished - on disk since, instead of clobbering it.
  ipcMain.handle(
    'fs:writeFile',
    async (e, payload: { path?: unknown; content?: unknown; expectedMtimeMs?: unknown }) => {
      if (!isTrustedSender(e)) return UNTRUSTED;
      await runtimeReady();
      if (!isNonEmptyStr(payload?.path) || typeof payload?.content !== 'string') {
        return { error: 'Invalid arguments', code: 'EINVAL' };
      }
      const target = payload.path;
      const fs = hostFs(target);
      if (typeof payload.expectedMtimeMs === 'number') {
        try {
          if ((await fs.stat(target)).mtimeMs !== payload.expectedMtimeMs) {
            return { error: 'File changed on disk', code: 'CONFLICT' };
          }
        } catch {
          return { error: 'File changed on disk', code: 'CONFLICT' };
        }
      }
      // Write-then-rename so a crash mid-save can't leave a truncated file; the
      // temp file lives in the same directory so the rename is atomic (same fs).
      const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
      try {
        await fs.writeFile(tmp, payload.content, 'utf8');
        await fs.rename(tmp, target);
        const after = await fs.stat(target);
        return { ok: true, mtimeMs: after.mtimeMs };
      } catch (err) {
        await fs.unlink(tmp).catch(() => {}); // best-effort temp cleanup
        return errResult(err, 'Could not save file');
      }
    },
  );

  // Create a new empty file; fails if something already exists at that path.
  ipcMain.handle('fs:createFile', async (e, payload: { path?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    await runtimeReady();
    if (!isNonEmptyStr(payload?.path)) return INVALID_PATH;
    if (await pathExists(payload.path)) {
      return { error: `"${basename(payload.path)}" already exists`, code: 'EEXIST' };
    }
    try {
      await hostFs(payload.path).writeFile(payload.path, '', { encoding: 'utf8', flag: 'wx' });
      return { ok: true, path: payload.path };
    } catch (err) {
      return errResult(err, 'Could not create file');
    }
  });

  // Create a new directory; fails if something already exists at that path.
  ipcMain.handle('fs:createDir', async (e, payload: { path?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    await runtimeReady();
    if (!isNonEmptyStr(payload?.path)) return INVALID_PATH;
    if (await pathExists(payload.path)) {
      return { error: `"${basename(payload.path)}" already exists`, code: 'EEXIST' };
    }
    try {
      await hostFs(payload.path).mkdir(payload.path, { recursive: false });
      return { ok: true, path: payload.path };
    } catch (err) {
      return errResult(err, 'Could not create folder');
    }
  });

  // Rename/move a file or folder. Refuses to clobber an existing target.
  ipcMain.handle('fs:rename', async (e, payload: { from?: unknown; to?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    await runtimeReady();
    if (!isNonEmptyStr(payload?.from) || !isNonEmptyStr(payload?.to)) {
      return INVALID_PATH;
    }
    if (payload.from === payload.to) return { ok: true, path: payload.to };
    if (await pathExists(payload.to)) {
      return { error: `"${basename(payload.to)}" already exists`, code: 'EEXIST' };
    }
    try {
      await hostFs(payload.from).rename(payload.from, payload.to);
      return { ok: true, path: payload.to };
    } catch (err) {
      return errResult(err, 'Could not rename');
    }
  });

  // Delete a file or folder by moving it to the OS trash - recoverable, unlike a
  // hard unlink, which suits a one-click action on the user's own files.
  // On a remote host the OS bin is out of reach: the host's own trash folder
  // (`~/.double0/trash`, emptied after a week - spec 7.5).
  ipcMain.handle('fs:delete', async (e, payload: { path?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    await runtimeReady();
    if (!isNonEmptyStr(payload?.path)) return INVALID_PATH;
    try {
      const rt = runtimeFor(payload.path);
      if (rt.trash) await rt.trash(payload.path);
      else await shell.trashItem(payload.path);
      return { ok: true };
    } catch (err) {
      return errResult(err, 'Could not delete');
    }
  });

  // Open the OS file manager (Finder / File Explorer / the Linux file manager)
  // on the folder holding `path`, with the item selected. Absolute paths only:
  // a relative one would resolve against main's cwd, not the project.
  ipcMain.handle('fs:showInFolder', async (e, payload: { path?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    await runtimeReady();
    if (!isNonEmptyStr(payload?.path) || !isAbsolute(payload.path)) return INVALID_PATH;
    // A file on a remote host has no folder on this machine to show (spec 19).
    if (runtimeFor(payload.path).remote) {
      return { error: 'That file is on a remote host', code: 'EREMOTE' };
    }
    if (!(await pathExists(payload.path))) {
      return { error: `"${basename(payload.path)}" no longer exists`, code: 'ENOENT' };
    }
    if (process.platform === 'linux' && !(await linuxHasFileManager())) {
      return { error: 'No file manager is installed to show it in', code: 'ENOTSUP' };
    }
    shell.showItemInFolder(payload.path);
    return { ok: true };
  });

  // Start (or ref-count) a recursive watch on a directory. Fires `fs:changed`
  // (debounced) at the calling window with the absolute paths that changed.
  ipcMain.handle('fs:watch', async (event, payload: { root?: unknown }) => {
    if (!isTrustedSender(event)) return UNTRUSTED;
    await runtimeReady();
    if (!isNonEmptyStr(payload?.root)) return INVALID_PATH;
    const root = payload.root;
    const sender = event.sender;
    const key = watchKey(sender.id, root);
    const existing = watchers.get(key);
    if (existing) {
      existing.refs++;
      // A remote watch still arming answers its mode once it is known.
      await (existing.watcher as unknown as Partial<HostWatcher>).ready?.catch(() => undefined);
      return { ok: true, ...modeOf(existing.watcher) };
    }
    let watcher: FSWatcher;
    try {
      // Recursive is supported on macOS + Windows (the app's targets); a platform
      // without it (e.g. Linux) simply won't live-refresh - handled, not fatal.
      // A remote host picks its own plan (spec 11.2: per-folder, or polling).
      watcher = runtimeFor(root).watch(root, { recursive: true, kind: 'tree' });
    } catch (err) {
      return errResult(err, 'Could not watch directory');
    }
    const entry: Watch = {
      watcher,
      sender,
      wcId: sender.id,
      root,
      refs: 1,
      timer: null,
      paths: new Set(),
      read: new Set(),
    };
    watchers.set(key, entry);
    watcher.on('error', () => {
      // The watched dir may have been removed/renamed - drop the watcher quietly.
      closeWatch(entry);
      watchers.delete(key);
    });
    watcher.on('change', (_eventType, filename) => {
      if (filename != null) {
        const rel = typeof filename === 'string' ? filename : filename.toString();
        if (IGNORED_SEGMENT.test(rel)) return; // skip node_modules/.git churn
        entry.paths.add(join(root, rel));
      }
      if (entry.timer) return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        const paths = [...entry.paths];
        entry.paths.clear();
        if (!entry.sender.isDestroyed()) {
          entry.sender.send('fs:changed', { root: entry.root, paths });
        }
      }, 150);
    });
    // A remote host switching this watch to polling later (native watching
    // ran out): the window hears it with the next change notice.
    watcher.on('mode', (mode: 'native' | 'poll') => {
      if (!entry.sender.isDestroyed()) {
        entry.sender.send('fs:changed', { root: entry.root, paths: [], mode });
      }
    });
    // A remote watch answers its mode once the host armed it - or why not: a
    // refused watch is an error, never a quiet `native` that never fires.
    const ready = (watcher as unknown as Partial<HostWatcher>).ready;
    if (ready) {
      try {
        return { ok: true, mode: await ready };
      } catch (err) {
        // The host is away (not a refusal): the watch stays - the remote
        // runtime arms it on the next connection and its first change notice
        // makes the window re-read. Closed here, nothing re-armed it and the
        // explorer of a project restored before its host connected never
        // live-refreshed again.
        if ((err as { code?: unknown }).code === 'EHOSTDOWN' && watchers.get(key) === entry) {
          return { ok: true, pending: true };
        }
        closeWatch(entry);
        if (watchers.get(key) === entry) watchers.delete(key);
        return errResult(err, 'Could not watch directory');
      }
    }
    return { ok: true };
  });

  // Drop a ref on a watch; the OS watcher closes when the last ref goes.
  ipcMain.handle('fs:unwatch', (event, payload: { root?: unknown }) => {
    if (!isTrustedSender(event)) return UNTRUSTED;
    if (!isNonEmptyStr(payload?.root)) return { ok: true };
    const key = watchKey(event.sender.id, payload.root);
    const entry = watchers.get(key);
    if (!entry) return { ok: true };
    entry.refs--;
    if (entry.refs <= 0) {
      closeWatch(entry);
      watchers.delete(key);
    }
    return { ok: true };
  });

  // Copy dropped files / folders (local paths, absolute - what the preload's
  // `files.pathOf` read off the drop) into `destDir`, local or on a host.
  // Answers `{ clash }` without writing when `onClash` is 'ask' and a name is
  // taken - the renderer asks once and calls again with the choice.
  ipcMain.handle(
    'fs:upload',
    async (
      e,
      payload: { uploadId?: unknown; paths?: unknown; destDir?: unknown; onClash?: unknown },
    ) => {
      if (!isTrustedSender(e)) return UNTRUSTED;
      await runtimeReady();
      const uploadId = payload?.uploadId;
      const destDir = payload?.destDir;
      const onClash = payload?.onClash ?? 'ask';
      if (typeof uploadId !== 'string' || !UPLOAD_ID.test(uploadId)) {
        return { error: 'Invalid upload id', code: 'EINVAL' };
      }
      if (typeof onClash !== 'string' || !CLASH_CHOICES.has(onClash)) {
        return { error: 'Invalid choice', code: 'EINVAL' };
      }
      if (!isNonEmptyStr(destDir) || !isAbsolute(destDir) || destDir.includes('\0')) {
        return INVALID_PATH;
      }
      const raw = payload?.paths;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_UPLOAD_ENTRIES) {
        return INVALID_PATH;
      }
      // The dropped paths are THIS computer's, whatever the destination: an
      // absolute local path each (never option-shaped, never relative).
      const local = nodePath;
      const paths: string[] = [];
      for (const p of raw) {
        if (!isNonEmptyStr(p) || !local.isAbsolute(p) || p.includes('\0')) return INVALID_PATH;
        paths.push(local.normalize(p));
      }
      // Copying a folder into itself would never end.
      if (!runtimeFor(destDir).remote) {
        const into = local.resolve(destDir);
        if (paths.some((p) => into === p || into.startsWith(p + local.sep))) {
          return { error: 'A folder cannot be copied into itself', code: 'EINVAL' };
        }
      }
      // The id is taken before the first await: two calls never share it.
      if (uploads.has(uploadId)) return { error: 'Upload already running', code: 'EBUSY' };
      const controller = new AbortController();
      uploads.set(uploadId, { wcId: e.sender.id, controller });
      try {
        try {
          const st = await hostFs(destDir).stat(destDir);
          if (!st.isDirectory()) return { error: 'Not a folder', code: 'ENOTDIR' };
        } catch (err) {
          return errResult(err, 'Could not read the folder');
        }
        const result = await runUpload({
          id: uploadId,
          source: { fs: localRuntime.fs, path: local },
          dest: { fs: hostFs(destDir), path: pathFor(destDir) },
          destDir,
          items: paths.map((p) => ({ localPath: p, rel: local.basename(p) })),
          onClash: onClash as 'ask' | ClashChoice,
          signal: controller.signal,
          onProgress: (progress) => {
            if (!e.sender.isDestroyed())
              e.sender.send('fs:uploadProgress', { uploadId, ...progress });
          },
        });
        if ('clash' in result) return { clash: result.clash };
        if ('refused' in result) return { error: result.refused, code: 'ETOOMANY' };
        if (result.unreachable) {
          return { ...result, error: 'Host is unreachable', code: 'EHOSTDOWN' };
        }
        return result;
      } catch (err) {
        return errResult(err, 'Could not copy the files');
      } finally {
        uploads.delete(uploadId);
      }
    },
  );

  // Stop an upload this window started: the files in flight stop after their
  // current chunk and their temp files go; files already in place stay.
  ipcMain.handle('fs:uploadCancel', (e, payload: { uploadId?: unknown }) => {
    if (!isTrustedSender(e)) return UNTRUSTED;
    const uploadId = payload?.uploadId;
    if (typeof uploadId !== 'string' || !UPLOAD_ID.test(uploadId)) {
      return { error: 'Invalid upload id', code: 'EINVAL' };
    }
    const upload = uploads.get(uploadId);
    if (!upload || upload.wcId !== e.sender.id) return { ok: false };
    upload.controller.abort();
    return { ok: true };
  });

  return () => {
    for (const upload of uploads.values()) upload.controller.abort();
    uploads.clear();
    for (const entry of watchers.values()) closeWatch(entry);
    watchers.clear();
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}
