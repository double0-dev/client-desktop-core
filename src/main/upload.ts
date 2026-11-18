import type { HostFs } from './host-runtime';

/**
 * Files from this computer copied into a folder (a private plan
 * › 9.1): the explorer's drop (`fs:upload`, onto a local root as onto a host's)
 * and a copy into a remote worktree (`git:seedFromLocal`). Pure over two
 * `HostFs` - the source is always this computer's, the destination is
 * `runtimeFor(destDir)` - so one walk, one set of caps and one write path
 * serve a local copy and an upload alike; a host's `writeFile` turns a large
 * body into a chunked transfer the daemon checks (remote-runtime.ts).
 *
 * Rules:
 * - The walk takes regular files and folders only; links, sockets, devices
 *   and files past the per-file cap are skipped and listed. The batch caps
 *   (files, bytes) refuse the whole batch before anything is written.
 * - A clash is a top-level name that already exists in the destination,
 *   found before anything is written: `ask` answers it (the caller asks the
 *   user once and calls again with the choice), `replace` overwrites files
 *   (a folder is merged, never deleted), `skip` leaves the item out,
 *   `keep-both` lands it under the first free `name (2).ext`.
 * - Every file is written to `<name>.double0-upload-<id>` first and renamed
 *   into place: a cancelled or failed upload never leaves half a file under
 *   the real name, and its temp file is removed (a host that went away keeps
 *   it until someone removes it - nothing can be done there).
 * - At most two files are in flight; progress at most every 100 ms.
 */

export const UPLOAD_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const UPLOAD_MAX_BATCH_BYTES = 512 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 5000;
export const UPLOAD_IN_FLIGHT = 2;
export const UPLOAD_PROGRESS_MS = 100;
/** What a file in flight is called until it is renamed into place. */
export const UPLOAD_TEMP_TAG = '.double0-upload-';

export type ClashChoice = 'replace' | 'skip' | 'keep-both';

/** The path functions a side needs - `pathFor(destDir)` for the destination. */
export type UploadPath = {
  join: (...parts: string[]) => string;
  dirname: (p: string) => string;
  basename: (p: string) => string;
};

export type UploadSide = { fs: HostFs; path: UploadPath };

/** One thing to copy: a path on this computer and where it lands, relative to `destDir`. */
export type UploadItem = { localPath: string; rel: string };

export type UploadLimits = { maxFileBytes: number; maxBatchBytes: number; maxFiles: number };

export type UploadProgress = { done: number; total: number; bytes: number; totalBytes: number };

export type UploadRequest = {
  /** Names the temp files (`[A-Za-z0-9_-]`). */
  id: string;
  source: UploadSide;
  dest: UploadSide;
  destDir: string;
  items: UploadItem[];
  onClash: 'ask' | ClashChoice;
  /** Every file written with this mode (the seed's 0600); else the destination's umask. */
  mode?: number;
  /** Why the walk must not copy `rel` (folders with a trailing slash), or null. */
  refuse?: (rel: string) => string | null;
  limits?: Partial<UploadLimits>;
  signal?: AbortSignal;
  onProgress?: (p: UploadProgress) => void;
  now?: () => number;
};

export type UploadSkip = { path: string; reason: string };
export type UploadError = { path: string; message: string };

export type UploadResult =
  /** `onClash: 'ask'` met an existing name - nothing was written. */
  | { clash: { name: string; count: number } }
  /** A batch cap - nothing was written. */
  | { refused: string }
  | {
      ok: boolean;
      /** Destination paths written, relative to `destDir`. */
      copied: string[];
      skipped: UploadSkip[];
      errors: UploadError[];
      cancelled?: true;
      /** The destination went away mid-batch (`EHOSTDOWN`). */
      unreachable?: true;
    };

type PlannedFile = { src: string; rel: string; bytes: number; top: number };
type PlannedTop = { item: UploadItem; kind: 'file' | 'dir' };
type Plan = {
  tops: PlannedTop[];
  files: PlannedFile[];
  /** Folders to create (relative), the empty ones included. */
  dirs: { rel: string; top: number }[];
  skipped: UploadSkip[];
  totalBytes: number;
};

const MB = 1024 * 1024;
const mb = (bytes: number): string => `${Math.max(1, Math.round(bytes / MB))} MB`;

const errCode = (err: unknown): string | undefined =>
  (err as NodeJS.ErrnoException | null)?.code ?? undefined;
const isAbort = (err: unknown): boolean =>
  (err as Error | null)?.name === 'AbortError' || errCode(err) === 'ABORT_ERR';
const isGone = (err: unknown): boolean =>
  errCode(err) === 'EHOSTDOWN' || errCode(err) === 'EOUTCOMEUNKNOWN';
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `name (2).ext` - a leading dot is a name, not an extension (`.env (2)`). */
export function keepBothName(name: string, n: number, isDir: boolean): string {
  const dot = name.lastIndexOf('.');
  if (isDir || dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/** `rel` with its first segment replaced (a keep-both top-level name). */
function reTop(rel: string, from: string, to: string): string {
  return rel === from ? to : `${to}${rel.slice(from.length)}`;
}

/**
 * Walk the selection on this computer. Stops as soon as a batch cap is
 * passed (a dropped `node_modules` is never walked to the end).
 */
async function walk(req: UploadRequest, limits: UploadLimits): Promise<Plan | { refused: string }> {
  const { fs, path } = req.source;
  const plan: Plan = { tops: [], files: [], dirs: [], skipped: [], totalBytes: 0 };
  const refusal = (): { refused: string } | null => {
    if (plan.files.length > limits.maxFiles) {
      return {
        refused: `More than ${limits.maxFiles.toLocaleString('en-US')} files - copy fewer at once.`,
      };
    }
    if (plan.totalBytes > limits.maxBatchBytes) {
      return { refused: `More than ${mb(limits.maxBatchBytes)} - copy less at once.` };
    }
    return null;
  };
  const addFile = (src: string, rel: string, bytes: number, top: number): void => {
    if (bytes > limits.maxFileBytes) {
      plan.skipped.push({
        path: rel,
        reason: `too large (${mb(bytes)} - the limit is ${mb(limits.maxFileBytes)})`,
      });
      return;
    }
    plan.files.push({ src, rel, bytes, top });
    plan.totalBytes += bytes;
  };
  const walkDir = async (
    dir: string,
    rel: string,
    top: number,
  ): Promise<{ refused: string } | null> => {
    plan.dirs.push({ rel, top });
    let names: string[];
    try {
      names = ((await fs.readdir(dir)) as string[]).slice().sort();
    } catch (err) {
      plan.skipped.push({ path: `${rel}/`, reason: message(err) });
      return null;
    }
    for (const name of names) {
      const src = path.join(dir, name);
      const childRel = `${rel}/${name}`;
      const st = await fs.lstat(src).catch(() => null);
      if (!st) continue; // gone since the listing
      if (st.isDirectory()) {
        const why = req.refuse?.(`${childRel}/`);
        if (why) {
          plan.skipped.push({ path: `${childRel}/`, reason: why });
          continue;
        }
        const stop = await walkDir(src, childRel, top);
        if (stop) return stop;
      } else if (st.isFile()) {
        const why = req.refuse?.(childRel);
        if (why) plan.skipped.push({ path: childRel, reason: why });
        else addFile(src, childRel, Number(st.size), top);
        const stop = refusal();
        if (stop) return stop;
      } else {
        plan.skipped.push({
          path: childRel,
          reason: st.isSymbolicLink() ? 'a link - not copied' : 'not a regular file',
        });
      }
    }
    return null;
  };
  const seenTops = new Set<string>();
  for (const item of req.items) {
    if (seenTops.has(item.rel)) {
      plan.skipped.push({ path: item.rel, reason: 'another item has the same name' });
      continue;
    }
    seenTops.add(item.rel);
    const st = await fs.lstat(item.localPath).catch(() => null);
    if (!st) {
      plan.skipped.push({ path: item.rel, reason: 'not found' });
      continue;
    }
    if (st.isDirectory()) {
      const why = req.refuse?.(`${item.rel}/`);
      if (why) {
        plan.skipped.push({ path: `${item.rel}/`, reason: why });
        continue;
      }
      plan.tops.push({ item, kind: 'dir' });
      const stop = await walkDir(item.localPath, item.rel, plan.tops.length - 1);
      if (stop) return stop;
    } else if (st.isFile()) {
      const why = req.refuse?.(item.rel);
      if (why) {
        plan.skipped.push({ path: item.rel, reason: why });
        continue;
      }
      plan.tops.push({ item, kind: 'file' });
      addFile(item.localPath, item.rel, Number(st.size), plan.tops.length - 1);
      const stop = refusal();
      if (stop) return stop;
    } else {
      plan.skipped.push({
        path: item.rel,
        reason: st.isSymbolicLink() ? 'a link - not copied' : 'not a regular file',
      });
    }
  }
  return refusal() ?? plan;
}

/** Copy `req.items` into `req.destDir` (see the module comment for the rules). */
export async function runUpload(req: UploadRequest): Promise<UploadResult> {
  const limits: UploadLimits = {
    maxFileBytes: req.limits?.maxFileBytes ?? UPLOAD_MAX_FILE_BYTES,
    maxBatchBytes: req.limits?.maxBatchBytes ?? UPLOAD_MAX_BATCH_BYTES,
    maxFiles: req.limits?.maxFiles ?? UPLOAD_MAX_FILES,
  };
  const now = req.now ?? Date.now;
  const { fs: dfs, path: dpath } = req.dest;
  const destOf = (rel: string): string => dpath.join(req.destDir, ...rel.split('/'));

  const planned = await walk(req, limits);
  if ('refused' in planned) return planned;
  const plan = planned;
  const skipped = [...plan.skipped];
  const errors: UploadError[] = [];
  /** Landed paths by walk index - two in flight finish in any order. */
  const landedAt: { at: number; rel: string }[] = [];
  const copied = (): string[] => landedAt.sort((a, b) => a.at - b.at).map((l) => l.rel);

  // Clashes: the top-level names that already exist there. Asked before
  // anything is written, so "ask" costs nothing to answer.
  const existing = await Promise.all(
    plan.tops.map((t) =>
      dfs.lstat(destOf(t.item.rel)).then(
        (st) => (st.isDirectory() ? 'dir' : 'file'),
        (err: unknown) => {
          if (isGone(err)) throw err;
          return null;
        },
      ),
    ),
  ).catch((err: unknown) => (isGone(err) ? ('gone' as const) : Promise.reject(err)));
  if (existing === 'gone') {
    return { ok: false, copied: [], skipped, errors, unreachable: true };
  }
  const clashes = plan.tops.filter((_, i) => existing[i] !== null);
  if (req.onClash === 'ask' && clashes.length > 0) {
    return { clash: { name: clashes[0].item.rel, count: clashes.length } };
  }
  const choice: ClashChoice = req.onClash === 'ask' ? 'replace' : req.onClash;

  // Where each top-level item lands. A keep-both FILE takes its free name at
  // the rename (reserved exclusively then); a keep-both folder takes the first
  // name nothing holds now.
  const topRel: (string | null)[] = [];
  const reserveAtRename = new Set<number>();
  for (let i = 0; i < plan.tops.length; i++) {
    const { item, kind } = plan.tops[i];
    const there = existing[i];
    if (!there) {
      topRel.push(item.rel);
      continue;
    }
    if (choice === 'skip') {
      skipped.push({ path: item.rel, reason: 'already there' });
      topRel.push(null);
    } else if (choice === 'replace') {
      if (there !== kind) {
        errors.push({
          path: item.rel,
          message:
            kind === 'dir'
              ? 'A file with this name is already there'
              : 'A folder with this name is already there',
        });
        topRel.push(null);
      } else topRel.push(item.rel);
    } else if (kind === 'file') {
      reserveAtRename.add(i);
      topRel.push(item.rel);
    } else {
      const dir = dpath.dirname(item.rel) === '.' ? '' : `${dpath.dirname(item.rel)}/`;
      const name = dpath.basename(item.rel);
      let n = 2;
      let free: string | null = null;
      for (; n < 1000 && !free; n++) {
        const candidate = `${dir}${keepBothName(name, n, true)}`;
        const taken = await dfs.lstat(destOf(candidate)).then(
          () => true,
          () => false,
        );
        if (!taken) free = candidate;
      }
      if (free) topRel.push(free);
      else {
        errors.push({ path: item.rel, message: 'No free name for a copy' });
        topRel.push(null);
      }
    }
  }
  const relOf = (top: number, rel: string): string | null => {
    const to = topRel[top];
    return to === null ? null : reTop(rel, plan.tops[top].item.rel, to);
  };

  const files = plan.files.filter((f) => topRel[f.top] !== null);
  const progress: UploadProgress = {
    done: 0,
    total: files.length,
    bytes: 0,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
  };
  let lastEmit = -Infinity;
  const emit = (force = false): void => {
    if (!req.onProgress) return;
    const t = now();
    if (!force && t - lastEmit < UPLOAD_PROGRESS_MS) return;
    lastEmit = t;
    req.onProgress({ ...progress });
  };
  emit(true);

  let cancelled = req.signal?.aborted === true;
  let unreachable = false;
  const made = new Set<string>();
  const mkdirp = async (abs: string): Promise<void> => {
    if (made.has(abs)) return;
    await dfs.mkdir(abs, { recursive: true });
    made.add(abs);
  };

  // Folders first (an empty folder that was dropped exists afterwards too).
  for (const d of plan.dirs) {
    if (cancelled || unreachable) break;
    const rel = relOf(d.top, d.rel);
    if (rel === null) continue;
    try {
      await mkdirp(destOf(rel));
    } catch (err) {
      if (isGone(err)) unreachable = true;
      else errors.push({ path: `${rel}/`, message: message(err) });
    }
  }

  const sendOne = async (f: PlannedFile, at: number): Promise<void> => {
    const rel = relOf(f.top, f.rel)!;
    const final = destOf(rel);
    const parent = dpath.dirname(final);
    const temp = dpath.join(parent, `${dpath.basename(final)}${UPLOAD_TEMP_TAG}${req.id}`);
    let tempWritten = false;
    let reserved: string | null = null;
    let sent = 0;
    try {
      // Read by path, after checking it is still a regular file within the cap.
      const st = await req.source.fs.lstat(f.src);
      if (!st.isFile()) throw new Error('no longer a regular file');
      if (Number(st.size) > limits.maxFileBytes) throw new Error('grew past the size limit');
      const body = (await req.source.fs.readFile(f.src)) as Buffer;
      if (body.length > limits.maxFileBytes) throw new Error('grew past the size limit');
      await mkdirp(parent);
      tempWritten = true;
      await dfs.writeFile(temp, body, {
        flag: 'wx',
        ...(req.mode !== undefined ? { mode: req.mode } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
        // A host's writeFile reports each chunk it sent (remote-runtime.ts).
        onProgress: (n: number) => {
          sent += n;
          progress.bytes += n;
          emit();
        },
      } as Parameters<HostFs['writeFile']>[2]);
      progress.bytes += Math.max(0, body.length - sent);
      sent = body.length;
      if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      let target = final;
      let landed = rel;
      if (reserveAtRename.has(f.top) && f.rel === plan.tops[f.top].item.rel) {
        // Keep both: claim the first free name exclusively, then move onto it.
        const dir = dpath.dirname(rel) === '.' ? '' : `${dpath.dirname(rel)}/`;
        const name = dpath.basename(rel);
        let claimed = false;
        for (let n = 2; n < 1000 && !claimed; n++) {
          const candidate = `${dir}${keepBothName(name, n, false)}`;
          try {
            await dfs.writeFile(destOf(candidate), '', { flag: 'wx' });
            reserved = destOf(candidate);
            target = destOf(candidate);
            landed = candidate;
            claimed = true;
          } catch (err) {
            if (errCode(err) !== 'EEXIST') throw err;
          }
        }
        if (!claimed) throw new Error('No free name for a copy');
      }
      await dfs.rename(temp, target);
      tempWritten = false;
      reserved = null;
      landedAt.push({ at, rel: landed });
      progress.done += 1;
      emit(progress.done === progress.total);
    } catch (err) {
      progress.bytes -= sent;
      if (isGone(err)) {
        unreachable = true;
        return;
      }
      if (tempWritten) await dfs.unlink(temp).catch(() => undefined);
      // A keep-both name claimed for a rename that never happened.
      if (reserved) await dfs.unlink(reserved).catch(() => undefined);
      if (isAbort(err) || req.signal?.aborted) {
        cancelled = true;
        return;
      }
      errors.push({ path: rel, message: message(err) });
    }
  };

  // Two in flight, taken in walk order.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length && !cancelled && !unreachable) {
      if (req.signal?.aborted) {
        cancelled = true;
        break;
      }
      const at = next++;
      await sendOne(files[at], at);
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_IN_FLIGHT }, worker));
  emit(true);

  return {
    ok: !cancelled && !unreachable && errors.length === 0,
    copied: copied(),
    skipped,
    errors,
    ...(cancelled ? { cancelled: true as const } : {}),
    ...(unreachable ? { unreachable: true as const } : {}),
  };
}
