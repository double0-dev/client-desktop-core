import type { SyncConfig } from '@tanstack/react-db';

/**
 * Tables exposed over the local DB bridge (window.api.db): core's, or one an
 * extension registered in main (main/db/row-schemas.ts › registerTables).
 */
export type TableName = 'projects' | 'agent_sessions' | (string & {});

/** A `db:change` broadcast (mirrors DbChange in src/preload/index.ts). */
type DbChange =
  | { table: string; type: 'insert' | 'update'; row: unknown }
  | { table: string; type: 'delete'; id: string };

/**
 * Backs a TanStack DB collection with the local embedded database over IPC,
 * replacing Electric's shape stream. It loads the table once, then applies every
 * `db:change` the main process broadcasts (our own writes confirm here, and
 * writes from other windows / the agent runtime arrive the same way). Mutations
 * are persisted by the collection's onInsert/onUpdate/onDelete handlers.
 */
export function ipcSync<T extends { id: string }>(table: TableName): SyncConfig<T> {
  return {
    sync: ({ begin, write, commit, markReady }) => {
      let disposed = false;
      // `db:change` events that arrive while the initial snapshot read is still
      // in flight. The snapshot query may predate them, so applying them right
      // away would let the older snapshot rows overwrite (or duplicate) newer
      // state. Buffer until the snapshot commits, then replay; null afterwards,
      // when live changes flow straight through.
      let buffered: DbChange[] | null = [];

      void window.api.db
        .list(table)
        .then((rows) => {
          if (disposed) return;
          // Collapse the buffer to each key's final event. Snapshot rows for those
          // keys are stale, so they're skipped and the buffered event wins: a
          // delete simply omits the row; an insert/update carries the full row and
          // is written as an insert (its snapshot copy, if any, was skipped, so
          // this can't double-insert).
          const finalByKey = new Map<string, DbChange>();
          for (const change of buffered ?? []) {
            finalByKey.set(change.type === 'delete' ? change.id : (change.row as T).id, change);
          }
          buffered = null;
          begin();
          for (const row of rows as T[]) {
            if (!finalByKey.has(row.id)) write({ type: 'insert', value: row });
          }
          for (const change of finalByKey.values()) {
            if (change.type !== 'delete') write({ type: 'insert', value: change.row as T });
          }
          commit();
          markReady();
        })
        .catch((err) => {
          // Main shows its own dialog on DB init failure; this just keeps the
          // renderer's console useful.
          console.error(`[db] initial ${table} snapshot failed`, err);
          if (disposed) return;
          // Deliberately NOT markReady(): with no snapshot the collection holds
          // no rows, and a ready-but-empty projects/sessions list would render
          // as "you have nothing" - worse than staying on the loading state,
          // since main has already surfaced its own dialog for this.
          //
          // The buffer must still be released, though. Only the success path
          // drains it, so leaving it non-null meant every later `db:change` was
          // appended to an array nothing would ever read - growing without
          // bound for the life of the window. Nulling it lets changes apply to
          // the collection instead, which is keyed and therefore bounded.
          buffered = null;
        });

      const unsubscribe = window.api.db.onChange((change) => {
        if (change.table !== table) return;
        if (buffered) {
          buffered.push(change);
          return;
        }
        begin();
        if (change.type === 'delete') {
          write({ type: 'delete', key: change.id });
        } else {
          write({ type: change.type, value: change.row as T });
        }
        commit();
      });

      return () => {
        disposed = true;
        unsubscribe();
      };
    },
  };
}
