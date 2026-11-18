import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcSync } from '@renderer/lib/local-collection';

/**
 * ipcSync backs every TanStack DB collection. The interesting behaviour is the
 * race it exists to close: `db:change` broadcasts can land while the initial
 * snapshot read is still in flight, and the snapshot may predate them - so the
 * older snapshot row must never overwrite the newer change.
 */

type Row = { id: string; name: string };
type Change =
  | { table: string; type: 'insert' | 'update'; row: unknown }
  | { table: string; type: 'delete'; id: string };

/** A stand-in for the collection's write side, recording what it is told. */
function harness() {
  const ops: ({ type: 'insert' | 'update'; value: Row } | { type: 'delete'; key: string })[] = [];
  let begins = 0;
  let commits = 0;
  let ready = 0;
  return {
    ops,
    counts: () => ({ begins, commits, ready }),
    params: {
      begin: () => {
        begins += 1;
      },
      write: (op: (typeof ops)[number]) => {
        ops.push(op);
      },
      commit: () => {
        commits += 1;
      },
      markReady: () => {
        ready += 1;
      },
    },
  };
}

let listChanges: ((change: Change) => void)[] = [];
let resolveList: (rows: Row[]) => void;
let rejectList: (err: Error) => void;
let unsubscribe: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listChanges = [];
  unsubscribe = vi.fn();
  const list = vi.fn(
    () =>
      new Promise<Row[]>((res, rej) => {
        resolveList = res;
        rejectList = rej;
      }),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      db: {
        list,
        onChange: (cb: (change: Change) => void) => {
          listChanges.push(cb);
          return unsubscribe;
        },
      },
    },
  });
});

/** Push a broadcast to every registered listener. */
const emit = (change: Change): void => {
  for (const cb of listChanges) cb(change);
};

/** Start a sync and hand back its cleanup. TanStack DB types the return as
 * `CleanupFn | SyncConfigRes`; ipcSync always returns the cleanup function. */
const start = (h: ReturnType<typeof harness>): (() => void) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the sync param bag is internal to TanStack DB
  ipcSync<Row>('projects').sync(h.params as any) as () => void;

describe('ipcSync - initial snapshot', () => {
  it('writes every snapshot row inside one transaction and marks ready', async () => {
    const h = harness();
    start(h);
    resolveList([
      { id: 'a', name: 'acme' },
      { id: 'b', name: 'production-pipeline' },
    ]);
    await vi.waitFor(() => expect(h.counts().ready).toBe(1));

    expect(h.ops).toEqual([
      { type: 'insert', value: { id: 'a', name: 'acme' } },
      { type: 'insert', value: { id: 'b', name: 'production-pipeline' } },
    ]);
    expect(h.counts()).toEqual({ begins: 1, commits: 1, ready: 1 });
  });

  it('still marks ready for an empty table', async () => {
    const h = harness();
    start(h);
    resolveList([]);
    await vi.waitFor(() => expect(h.counts().ready).toBe(1));
    expect(h.ops).toEqual([]);
  });

  it('leaves the collection loading when the snapshot read fails', async () => {
    const h = harness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    start(h);
    rejectList(new Error('main not ready'));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(h.counts().ready).toBe(0);
    expect(h.ops).toEqual([]);
  });

  /**
   * Only the SUCCESS path drains the pre-snapshot buffer, so a failed snapshot
   * used to leave it in place forever: every later `db:change` was pushed onto
   * an array nothing would ever read, growing without bound for the life of the
   * window. Changes must flow through to the collection instead - which is
   * keyed, so repeated writes to a row overwrite rather than accumulate.
   */
  it('stops buffering changes after a failed snapshot read', async () => {
    const h = harness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    start(h);
    rejectList(new Error('main not ready'));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());

    emit({ table: 'projects', type: 'insert', row: { id: 'a', name: 'acme' } });
    emit({ table: 'projects', type: 'update', row: { id: 'a', name: 'renamed' } });

    await vi.waitFor(() => expect(h.ops.length).toBe(2));
    expect(h.ops).toEqual([
      { type: 'insert', value: { id: 'a', name: 'acme' } },
      { type: 'update', value: { id: 'a', name: 'renamed' } },
    ]);
  });
});

describe('ipcSync - changes buffered during the snapshot read', () => {
  it('lets a buffered update win over its stale snapshot row', async () => {
    const h = harness();
    start(h);
    // Arrives BEFORE the snapshot resolves, and the snapshot predates it.
    emit({ table: 'projects', type: 'update', row: { id: 'a', name: 'renamed' } });
    resolveList([{ id: 'a', name: 'stale' }]);
    await vi.waitFor(() => expect(h.counts().ready).toBe(1));

    // The stale snapshot copy is skipped; the buffered row is written instead.
    expect(h.ops).toEqual([{ type: 'insert', value: { id: 'a', name: 'renamed' } }]);
  });

  it('omits a row deleted while the snapshot was in flight', async () => {
    const h = harness();
    start(h);
    emit({ table: 'projects', type: 'delete', id: 'a' });
    resolveList([
      { id: 'a', name: 'acme' },
      { id: 'b', name: 'keep' },
    ]);
    await vi.waitFor(() => expect(h.counts().ready).toBe(1));

    expect(h.ops).toEqual([{ type: 'insert', value: { id: 'b', name: 'keep' } }]);
  });

  it('applies only the final buffered event per key', async () => {
    const h = harness();
    start(h);
    emit({ table: 'projects', type: 'insert', row: { id: 'a', name: 'first' } });
    emit({ table: 'projects', type: 'update', row: { id: 'a', name: 'second' } });
    emit({ table: 'projects', type: 'update', row: { id: 'a', name: 'third' } });
    resolveList([]);
    await vi.waitFor(() => expect(h.counts().ready).toBe(1));

    expect(h.ops).toEqual([{ type: 'insert', value: { id: 'a', name: 'third' } }]);
  });

  it('writes a buffered insert for a row the snapshot never had', async () => {
    const h = harness();
    start(h);
    emit({ table: 'projects', type: 'insert', row: { id: 'new', name: 'fresh' } });
    resolveList([{ id: 'old', name: 'acme' }]);
    await vi.waitFor(() => expect(h.counts().ready).toBe(1));

    expect(h.ops).toEqual([
      { type: 'insert', value: { id: 'old', name: 'acme' } },
      { type: 'insert', value: { id: 'new', name: 'fresh' } },
    ]);
    // One transaction - snapshot and replay commit together.
    expect(h.counts()).toEqual({ begins: 1, commits: 1, ready: 1 });
  });

  it('ignores buffered changes for other tables', async () => {
    const h = harness();
    start(h);
    emit({ table: 'tasks', type: 'insert', row: { id: 'a', name: 'not ours' } });
    resolveList([]);
    await vi.waitFor(() => expect(h.counts().ready).toBe(1));
    expect(h.ops).toEqual([]);
  });
});

describe('ipcSync - live changes after the snapshot', () => {
  const settled = async (): Promise<ReturnType<typeof harness>> => {
    const h = harness();
    start(h);
    resolveList([]);
    await vi.waitFor(() => expect(h.counts().ready).toBe(1));
    h.ops.length = 0;
    return h;
  };

  it('applies an insert straight through in its own transaction', async () => {
    const h = await settled();
    emit({ table: 'projects', type: 'insert', row: { id: 'a', name: 'acme' } });
    expect(h.ops).toEqual([{ type: 'insert', value: { id: 'a', name: 'acme' } }]);
    expect(h.counts()).toMatchObject({ begins: 2, commits: 2 });
  });

  it('applies an update as an update, not an insert', async () => {
    const h = await settled();
    emit({ table: 'projects', type: 'update', row: { id: 'a', name: 'renamed' } });
    expect(h.ops).toEqual([{ type: 'update', value: { id: 'a', name: 'renamed' } }]);
  });

  it('applies a delete by key', async () => {
    const h = await settled();
    emit({ table: 'projects', type: 'delete', id: 'a' });
    expect(h.ops).toEqual([{ type: 'delete', key: 'a' }]);
  });

  it('ignores other tables', async () => {
    const h = await settled();
    emit({ table: 'tasks', type: 'delete', id: 'a' });
    expect(h.ops).toEqual([]);
    expect(h.counts()).toMatchObject({ begins: 1 });
  });
});

describe('ipcSync - teardown', () => {
  it('unsubscribes from the change feed', () => {
    const h = harness();
    const dispose = start(h);
    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('drops a snapshot that resolves after disposal', async () => {
    const h = harness();
    const dispose = start(h);
    dispose();
    resolveList([{ id: 'a', name: 'acme' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.ops).toEqual([]);
    expect(h.counts().ready).toBe(0);
  });
});
