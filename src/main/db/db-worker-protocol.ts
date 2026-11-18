/**
 * The messages between main and the database worker (db-worker.ts), and the
 * error round trip both sides share. Pure: no Electron, no worker APIs and no
 * PGlite - main imports it, and PGlite stays out of main's module graph (the
 * worker alone loads it; db-worker-parsers.ts holds what needs its types).
 *
 * Main keeps drizzle (`drizzle-orm/pg-proxy`) and sends each query's SQL and
 * driver-form params; the worker runs it on the one PGlite connection and
 * answers with the rows. Ids are per worker; replies arrive in request order
 * because PGlite runs its queries one at a time, in call order.
 */

export type DbWorkerData = {
  /** The PGlite data folder (a native path). */
  dataDir: string;
  /** The drizzle migrations folder (a native path). */
  migrationsFolder: string;
};

/** `all` = a query drizzle maps from array rows; `execute` = raw rows as objects. */
export type QueryMethod = 'all' | 'execute';

export type ToWorker =
  { t: 'query'; id: number; sql: string; params: unknown[]; method: QueryMethod } | { t: 'close' };

export type FromWorker =
  | { t: 'ready'; openMs: number; migrateMs: number }
  | { t: 'init-error'; error: SerializedError }
  | { t: 'result'; id: number; rows: unknown[] }
  | { t: 'error'; id: number; error: SerializedError }
  | { t: 'closed' };

/**
 * An error as it crosses the thread. Structured clone keeps only an Error's
 * name, message, stack and cause, so PGlite's own fields (`code`, `detail`,
 * `constraint`, …) would be lost - they travel in `props`.
 */
export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  props: Record<string, string | number | boolean>;
};

/** The `code` of the error every in-flight query rejects with when the worker dies. */
export const DB_WORKER_GONE = 'EDBWORKERGONE';

export function serializeError(err: unknown): SerializedError {
  if (!(err instanceof Error)) return { name: 'Error', message: String(err), props: {} };
  const props: SerializedError['props'] = {};
  for (const [key, value] of Object.entries(err)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      props[key] = value;
    }
  }
  return { name: err.name, message: err.message, stack: err.stack, props };
}

export function reviveError(serialized: SerializedError): Error {
  const err = Object.assign(new Error(serialized.message), serialized.props);
  err.name = serialized.name;
  if (serialized.stack) err.stack = serialized.stack;
  return err;
}
