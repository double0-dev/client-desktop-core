import { app, dialog } from 'electron';
import { is } from '@electron-toolkit/utils';
import { join } from 'node:path';
import { createWorkerDb, type AppDb, type WorkerDb } from './worker-db';

// Single embedded Postgres for the whole app, persisted on disk under the user's
// data dir. It lives in a worker thread (db-worker.ts): opening it blocked main
// for 170-270 ms of every launch, while the renderer waited for main to serve
// its scripts. `startDb` spawns the worker at main's module load, so the open
// and the migrations run beside window creation; every caller of `getDb` waits
// for it. Main talks to it through drizzle's pg-proxy driver (worker-db.ts).

/** Spawns per process: a worker that keeps dying ends in the error box, not a spawn storm. */
const MAX_SPAWNS = 3;

let workerFile: string | null = null;
let current: WorkerDb | null = null;
let spawns = 0;
let lastError: Error | null = null;
// Once closeDb() has begun, no caller may re-open PGlite - a getDb() straggler
// during quit would otherwise spin up a fresh instance that never gets closed.
let closing = false;
// The error dialog fires once, not once per queued IPC call against the broken DB.
let initErrorShown = false;

/**
 * In dev the migrations are read from source; a packaged build ships them to
 * the app's Resources dir via electron-builder `extraResources` (so they're a
 * plain folder on disk, readable by the migrator rather than trapped in the asar).
 */
function migrationsFolder(): string {
  return is.dev
    ? join(app.getAppPath(), 'src', 'main', 'db', 'migrations')
    : join(process.resourcesPath, 'migrations');
}

/** Tell the user (once) that the local DB failed to open, with enough to recover. */
function showInitErrorOnce(dataDir: string, err: unknown): void {
  if (initErrorShown) return;
  initErrorShown = true;
  const detail = err instanceof Error ? err.message : String(err);
  dialog.showErrorBox(
    'double0 - local database error',
    `The local database could not be opened.\n\nLocation: ${dataDir}\n\n${detail}\n\n` +
      'Your data is still on disk. Quit and reopen the app to retry; if it keeps ' +
      `failing, a pre-migration copy may exist at ${dataDir}.backup-pre-migration.`,
  );
}

const dataDirOf = (): string => join(app.getPath('userData'), 'double0-db');

/** The box, once main is ready - it always appeared after the first window. */
function reportFailure(err: Error): void {
  lastError = err;
  if (!closing) void app.whenReady().then(() => showInitErrorOnce(dataDirOf(), err));
}

function spawn(): WorkerDb | null {
  const dataDir = dataDirOf();
  console.log(`[db] opening PGlite at ${dataDir}`);
  spawns++;
  let handle: WorkerDb;
  try {
    handle = createWorkerDb({
      // index.ts names it (its own folder is out/main); this module may land in a chunk.
      workerFile: workerFile ?? join(__dirname, 'db-worker.js'),
      dataDir,
      migrationsFolder: migrationsFolder(),
    });
  } catch (err) {
    // `new Worker` throws synchronously on a bad path or argv - at module load
    // that would stop main from booting at all.
    console.error('[db] could not start the database worker:', err);
    reportFailure(err instanceof Error ? err : new Error(String(err)));
    return null;
  }
  handle.ready.then(
    ({ openMs, migrateMs }) =>
      console.log(`[db] ready (open ${openMs} ms, migrations ${migrateMs} ms)`),
    (err: Error) => {
      if (current === handle) current = null;
      reportFailure(err);
    },
  );
  handle.onGone((err) => {
    console.error(`[db] ${err.message}`);
    lastError = err;
    if (current === handle) current = null;
    // The next getDb starts a fresh worker on the same folder; once the cap is
    // spent nothing will, so say so the one way the user sees.
    if (spawns >= MAX_SPAWNS) reportFailure(err);
  });
  return handle;
}

/**
 * Start opening the database now. Called at main's module load once the
 * single-instance lock is held (a second instance must never open the live
 * folder); `workerFile` is `<out/main>/db-worker.js`.
 */
export function startDb(file: string): void {
  workerFile = file;
  if (!closing && !current) current = spawn();
}

export async function getDb(): Promise<AppDb> {
  if (closing) throw new Error('[db] getDb() called while the database is closing');
  // A failed open or a crashed worker cleared the memo: retry on a fresh one.
  if (!current && spawns < MAX_SPAWNS) current = spawn();
  const handle = current;
  if (!handle) throw lastError ?? new Error('[db] the database could not start');
  await handle.ready;
  return handle.db;
}

// Close PGlite cleanly on quit so the data dir is flushed and the postmaster.pid
// lock is released - otherwise an abrupt exit leaves the dir "crashed" and the
// next open (or drizzle-kit studio) can fail.
export async function closeDb(): Promise<void> {
  closing = true;
  const handle = current;
  current = null;
  if (!handle) return;
  try {
    await handle.close();
    console.log('[db] closed');
  } catch (err) {
    console.error('[db] error during close:', err);
  }
}
