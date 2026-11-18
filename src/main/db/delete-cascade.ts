import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { TableName } from './row-schemas';

/**
 * An extension's part of a delete (MainExtension.db, used by db/ipc.ts): its
 * tables reference core rows (a project, a session) and each other, so a
 * delete's FK cascades reach rows each window only hears about through a
 * broadcast. Asked before the delete, with the row still there. Kept apart
 * from ipc.ts, which pulls in Electron - the renderer's typecheck reads
 * extension.ts, and through it this file.
 */
export type DeleteCascadePlan = {
  /** Rows the database removes with this delete, in broadcast order. */
  deletes: { table: TableName; id: string }[];
  /** After the delete: the rows a set-null FK changed (re-broadcast as updates), plus any cleanup. */
  after?: () => Promise<{ table: TableName; row: unknown }[]>;
};

/**
 * `db` is the shared base of the app's database (pg-proxy over the worker,
 * worker-db.ts) and the in-process PGlite a cascade test opens.
 */
export type DeleteCascade = (
  db: PgAsyncDatabase<PgQueryResultHKT, Record<string, unknown>>,
  table: TableName,
  id: string,
) => Promise<DeleteCascadePlan>;
