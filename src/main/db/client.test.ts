import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDb } from './worker-db';

/**
 * client.ts's bookkeeping around the database worker, with Electron and the
 * worker faked: one worker per process unless it fails, a fresh one after a
 * failed open or a crash (three in all), the error box once, and nothing
 * opened again once the quit closed it. The worker itself: db-worker.test.ts.
 */

const showErrorBox = vi.fn();
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/double0-client-test',
    getAppPath: () => '/tmp/double0-client-app',
    whenReady: () => Promise.resolve(),
  },
  dialog: { showErrorBox: (...args: unknown[]) => showErrorBox(...args) },
}));
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }));

type Fake = WorkerDb & {
  open(): void;
  fail(err: Error): void;
  crash(err: Error): void;
  closed: boolean;
};
let workers: Fake[] = [];
let throwOnSpawn: Error | null = null;

function fakeWorker(): Fake {
  let resolve!: (v: { openMs: number; migrateMs: number }) => void;
  let reject!: (err: Error) => void;
  const ready = new Promise<{ openMs: number; migrateMs: number }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  ready.catch(() => undefined);
  const gone: Array<(err: Error) => void> = [];
  const fake: Fake = {
    db: { worker: workers.length } as unknown as WorkerDb['db'],
    ready,
    close: vi.fn(async () => {
      fake.closed = true;
    }),
    onGone: (listener) => gone.push(listener),
    worker: {} as WorkerDb['worker'],
    open: () => resolve({ openMs: 1, migrateMs: 1 }),
    fail: (err) => reject(err),
    crash: (err) => gone.forEach((listener) => listener(err)),
    closed: false,
  };
  return fake;
}

vi.mock('./worker-db', () => ({
  createWorkerDb: () => {
    if (throwOnSpawn) throw throwOnSpawn;
    const fake = fakeWorker();
    workers.push(fake);
    return fake;
  },
}));

async function load() {
  vi.resetModules();
  return import('./client');
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  workers = [];
  throwOnSpawn = null;
  showErrorBox.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('startDb / getDb', () => {
  it('opens one worker at startDb and hands every caller its database once ready', async () => {
    const client = await load();
    client.startDb('/out/main/db-worker.js');
    expect(workers).toHaveLength(1);
    const first = client.getDb();
    const second = client.getDb();
    workers[0].open();
    expect(await first).toBe(workers[0].db);
    expect(await second).toBe(workers[0].db);
    expect(workers).toHaveLength(1);
  });

  it('shows the error box once for a failed open, and the next call tries a fresh worker', async () => {
    const client = await load();
    client.startDb('/out/main/db-worker.js');
    const pending = client.getDb();
    workers[0].fail(new Error('could not open'));
    await expect(pending).rejects.toThrow('could not open');
    await settle();
    expect(showErrorBox).toHaveBeenCalledTimes(1);
    expect(showErrorBox.mock.calls[0][1]).toMatch(/could not open/);
    const retry = client.getDb();
    expect(workers).toHaveLength(2);
    workers[1].open();
    expect(await retry).toBe(workers[1].db);
    expect(showErrorBox).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh worker after a crash, and stops at three with the error box', async () => {
    const client = await load();
    client.startDb('/out/main/db-worker.js');
    workers[0].open();
    await client.getDb();
    workers[0].crash(new Error('stopped (exit code 1)'));
    const second = client.getDb();
    workers[1].open();
    expect(await second).toBe(workers[1].db);
    workers[1].crash(new Error('stopped (exit code 1)'));
    const third = client.getDb();
    workers[2].open();
    expect(await third).toBe(workers[2].db);
    expect(showErrorBox).not.toHaveBeenCalled();
    // The third one dies too: no fourth, every call fails with its error and
    // the user sees the box (a crash loop must not end silently).
    workers[2].crash(new Error('stopped (exit code 9)'));
    await expect(client.getDb()).rejects.toThrow('exit code 9');
    expect(workers).toHaveLength(3);
    await settle();
    expect(showErrorBox).toHaveBeenCalledTimes(1);
  });

  it('survives a worker that cannot even start: main boots, callers get the error', async () => {
    throwOnSpawn = Object.assign(new Error('bad worker path'), { code: 'ERR_WORKER_PATH' });
    const client = await load();
    // At module load in main: a throw here would stop the app from booting.
    expect(() => client.startDb('relative/db-worker.js')).not.toThrow();
    await expect(client.getDb()).rejects.toThrow('bad worker path');
    await settle();
    expect(showErrorBox).toHaveBeenCalledTimes(1);
  });
});

describe('closeDb', () => {
  it('closes the worker, then refuses to open another', async () => {
    const client = await load();
    client.startDb('/out/main/db-worker.js');
    workers[0].open();
    await client.getDb();
    await client.closeDb();
    expect(workers[0].closed).toBe(true);
    // A straggler during quit must not spin up a worker nobody closes.
    await expect(client.getDb()).rejects.toThrow(/closing/);
    expect(workers).toHaveLength(1);
  });

  it('shows no error box for an open that fails while the app quits', async () => {
    const client = await load();
    client.startDb('/out/main/db-worker.js');
    const closing = client.closeDb();
    workers[0].fail(new Error('closed mid-open'));
    await closing;
    await settle();
    expect(showErrorBox).not.toHaveBeenCalled();
  });
});
