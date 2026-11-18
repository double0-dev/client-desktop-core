import { Worker } from 'node:worker_threads';
import { drizzle, type PgRemoteDatabase } from 'drizzle-orm/pg-proxy';
import * as schema from './schema';
import {
  DB_WORKER_GONE,
  reviveError,
  type DbWorkerData,
  type FromWorker,
  type QueryMethod,
  type ToWorker,
} from './db-worker-protocol';

/** The database every main module queries (client.ts › getDb). */
export type AppDb = PgRemoteDatabase<typeof schema>;

export type WorkerDb = {
  /** Drizzle over the worker: each query is one message there and back. */
  db: AppDb;
  /** Settles once PGlite is open and migrated; rejects with the open's own error. */
  ready: Promise<{ openMs: number; migrateMs: number }>;
  /** Flushes and closes PGlite, then ends the thread. Safe after a crash. */
  close(): Promise<void>;
  /** Called once if the thread dies on its own (never for `close`). */
  onGone(listener: (err: Error) => void): void;
  /** The thread itself - a test ends it to stand in for a crash. */
  worker: Worker;
};

/** How long `close` waits for the thread to exit after PGlite closed. */
const EXIT_GRACE_MS = 500;

/**
 * Starts the database worker (db-worker.ts) and gives main a drizzle that
 * talks to it (`drizzle-orm/pg-proxy`). Electron-free, so its test drives the
 * real worker. pg-proxy has no transactions; no-transaction.test.ts keeps main
 * from needing one.
 */
export function createWorkerDb(opts: { workerFile: string } & DbWorkerData): WorkerDb {
  const workerData: DbWorkerData = {
    dataDir: opts.dataDir,
    migrationsFolder: opts.migrationsFolder,
  };
  // An empty execArgv: a worker inherits main's, and Electron's flags there
  // fail the spawn (ERR_WORKER_INVALID_EXEC_ARGV).
  const worker = new Worker(opts.workerFile, { workerData, name: 'double0-db', execArgv: [] });

  const pending = new Map<
    number,
    { resolve: (value: { rows: unknown[] }) => void; reject: (err: Error) => void }
  >();
  const goneListeners: Array<(err: Error) => void> = [];
  let seq = 0;
  let closing = false;
  /** Set once no query can be answered any more: the open failed or the thread ended. */
  let dead: Error | null = null;

  let resolveReady!: (value: { openMs: number; migrateMs: number }) => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<{ openMs: number; migrateMs: number }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Callers handle it through getDb; an open nobody awaited must not read as
  // an unhandled rejection.
  ready.catch(() => undefined);

  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));

  const fail = (err: Error, notify: boolean): void => {
    if (dead) return;
    dead = err;
    rejectReady(err);
    for (const request of pending.values()) request.reject(err);
    pending.clear();
    if (notify && !closing) for (const listener of goneListeners) listener(err);
  };
  const goneError = (detail: string): Error =>
    Object.assign(new Error(`[db] the database worker stopped (${detail})`), {
      code: DB_WORKER_GONE,
    });

  worker.on('message', (msg: FromWorker) => {
    switch (msg.t) {
      case 'ready':
        resolveReady({ openMs: msg.openMs, migrateMs: msg.migrateMs });
        return;
      case 'init-error':
        // Reported through `ready`; the thread ends right after.
        fail(reviveError(msg.error), false);
        return;
      case 'result': {
        const request = pending.get(msg.id);
        pending.delete(msg.id);
        request?.resolve({ rows: msg.rows });
        return;
      }
      case 'error': {
        const request = pending.get(msg.id);
        pending.delete(msg.id);
        request?.reject(reviveError(msg.error));
        return;
      }
      case 'closed':
        markClosed();
        return;
    }
  });
  // An `error` event nobody listens to would take main down with the thread.
  worker.on('error', (err) => fail(Object.assign(err, { code: DB_WORKER_GONE }), true));
  worker.on('exit', (code) => {
    markClosed();
    fail(goneError(`exit code ${code}`), true);
  });

  const query = (
    sql: string,
    params: unknown[],
    method: QueryMethod,
  ): Promise<{ rows: unknown[] }> =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ t: 'query', id, sql, params, method } satisfies ToWorker);
    });

  const db = drizzle((sql, params, method) => query(sql, params, method), { schema });

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> =>
    (closePromise ??= (async () => {
      closing = true;
      if (!dead) worker.postMessage({ t: 'close' } satisfies ToWorker);
      // `closed` (or the exit) means PGlite flushed and let go of the folder;
      // the thread ends right after, and is ended for it if it lingers.
      await closed;
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, EXIT_GRACE_MS))]);
      await worker.terminate();
    })());

  return { db, ready, close, onGone: (listener) => goneListeners.push(listener), worker };
}
