import { parentPort, workerData } from 'node:worker_threads';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from './schema';
import { runMigrations } from './migrate';
import { DRIZZLE_PGLITE_PARSERS } from './db-worker-parsers';
import {
  serializeError,
  type DbWorkerData,
  type FromWorker,
  type ToWorker,
} from './db-worker-protocol';

/**
 * The database worker thread (its own electron-vite entry, out/main/db-worker.js;
 * started by client.ts). It owns the app's one PGlite connection: opening it
 * reads the data folder synchronously and boots PGlite's wasm, which blocked
 * main for 170-270 ms of every launch - main could not serve the renderer's
 * scripts meanwhile. Here it runs beside main from main's first module load.
 *
 * Opens PGlite, brings the schema up to date with drizzle's migrator (which
 * needs a transaction - main's pg-proxy driver has none), says `ready`, then
 * runs each `query` straight into PGlite, whose own queue keeps arrival order.
 * Never import Electron here, directly or through anything this imports.
 */

const port = parentPort;
if (!port) throw new Error('db-worker.ts runs only as a worker thread');
const data = workerData as DbWorkerData;
const send = (msg: FromWorker): void => port.postMessage(msg);

let client: PGlite | null = null;

const opened: Promise<PGlite> = (async () => {
  const started = performance.now();
  const pg = await PGlite.create(data.dataDir);
  client = pg;
  const openedAt = performance.now();
  await runMigrations(drizzle({ client: pg, schema }), data);
  send({
    t: 'ready',
    openMs: Math.round(openedAt - started),
    migrateMs: Math.round(performance.now() - openedAt),
  });
  return pg;
})();

opened.catch(async (err: unknown) => {
  send({ t: 'init-error', error: serializeError(err) });
  // A PGlite that opened but failed its migrations still holds the folder.
  await client?.close().catch(() => undefined);
  port.close();
});

/** Queries PGlite has not answered yet: a close lets them finish first. */
const inFlight = new Set<Promise<unknown>>();
let closeRequested = false;

port.on('message', (msg: ToWorker) => {
  if (msg.t === 'query') {
    // Main sends queries only after `ready`, so the client is open; dispatched
    // without an await in between so PGlite queues them in arrival order.
    const pg = client;
    if (!pg || closeRequested) {
      const reason = closeRequested ? '[db] the database is closing' : '[db] not open';
      send({ t: 'error', id: msg.id, error: serializeError(new Error(reason)) });
      return;
    }
    const running = pg
      .query(msg.sql, msg.params as unknown[], {
        rowMode: msg.method === 'all' ? 'array' : 'object',
        parsers: DRIZZLE_PGLITE_PARSERS,
      })
      .then(
        (res) => send({ t: 'result', id: msg.id, rows: res.rows }),
        (err: unknown) => send({ t: 'error', id: msg.id, error: serializeError(err) }),
      );
    inFlight.add(running);
    void running.finally(() => inFlight.delete(running));
    return;
  }
  // close: also during the open (a quit while a migration runs) - wait for it
  // and for every query already sent (a layout save fired as the app quits),
  // so the close never races PGlite's own queue (a close in the same tick as
  // a query wedged PGlite's thread in a review probe), then flush and release
  // the folder's postmaster.pid before the thread ends. Later queries are refused.
  closeRequested = true;
  void opened
    .catch(() => null)
    .then(async (pg) => {
      try {
        await Promise.allSettled([...inFlight]);
        await pg?.close();
      } finally {
        send({ t: 'closed' });
        port.close();
      }
    });
});
