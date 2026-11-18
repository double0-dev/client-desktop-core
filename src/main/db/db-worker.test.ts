import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { eq, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSessions, projects } from './schema';
import { DB_WORKER_GONE } from './db-worker-protocol';
import { createWorkerDb, type WorkerDb } from './worker-db';

/**
 * The database worker as the app runs it: db-worker.ts compiled the way
 * electron-vite does (PGlite external, everything else bundled), started
 * through createWorkerDb against a scratch data folder and the real
 * migrations, and queried through drizzle's pg-proxy driver in this thread.
 */

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const migrationsFolder = join(repo, 'src/main/db/migrations');
let workerFile = '';
let buildDir = '';
const scratch = mkdtempSync(join(tmpdir(), 'double0-db-worker-'));
let shared: WorkerDb;

const start = (dataDir: string): WorkerDb =>
  createWorkerDb({ workerFile, dataDir, migrationsFolder });

beforeAll(async () => {
  // Inside the repo, so the bundle's bare `@electric-sql/pglite` resolves.
  mkdirSync(join(repo, 'node_modules/.cache'), { recursive: true });
  buildDir = mkdtempSync(join(repo, 'node_modules/.cache/double0-db-worker-'));
  workerFile = join(buildDir, 'db-worker.mjs');
  await build({
    entryPoints: [join(repo, 'src/main/db/db-worker.ts')],
    outfile: workerFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['@electric-sql/pglite'],
    logLevel: 'silent',
  });
  shared = start(join(scratch, 'shared'));
  await shared.ready;
}, 60_000);

afterAll(async () => {
  await shared?.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  rmSync(buildDir, { recursive: true, force: true });
});

describe('the database worker', () => {
  it('opens and migrates in the worker: every migration of the folder is applied', async () => {
    const rows = await shared.db.execute(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    expect(rows).toEqual([{ n: readMigrationFiles({ migrationsFolder }).length }]);
  });

  it('round-trips the column types main reads: timestamps as Dates, jsonb, booleans, numbers', async () => {
    const createdAt = new Date('2026-01-02T03:04:05.678Z');
    const [inserted] = await shared.db
      .insert(projects)
      .values({
        name: 'production-pipeline',
        worktreeCopyPaths: ['.env', 'certs/'],
        sortOrder: -1.5,
        createdAt,
      })
      .returning();
    // Mapped by drizzle's column mappers in main, from the rows the worker sent.
    expect(inserted.createdAt).toBeInstanceOf(Date);
    expect(inserted.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(inserted.worktreeCopyPaths).toEqual(['.env', 'certs/']);
    expect(inserted.pinned).toBe(false);
    expect(inserted.sortOrder).toBe(-1.5);
    const [read] = await shared.db.select().from(projects).where(eq(projects.id, inserted.id));
    expect(read).toEqual(inserted);
  });

  it('gives a raw sql timestamp back as the string the in-process driver gave', async () => {
    // No column mapper here: the value is what the driver hands over. drizzle's
    // PGlite driver keeps timestamps raw (its parsers); without the same
    // parsers in the worker this would turn into a Date.
    const [row] = await shared.db
      .select({ at: sql<string>`'2026-01-02 03:04:05.678+00'::timestamptz` })
      .from(projects)
      .limit(1);
    expect(typeof row.at).toBe('string');
  });

  it('keeps PGlite’s error fields on a failed query (the cause carries the SQLSTATE)', async () => {
    const missing = '00000000-0000-4000-8000-0000000000aa';
    const err = await shared.db
      .insert(agentSessions)
      .values({ label: 'acme', status: 'idle', projectId: missing })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const cause = (err as Error & { cause?: Record<string, unknown> }).cause;
    expect(cause?.code).toBe('23503');
    expect(cause?.constraint).toMatch(/projectId/);
    expect(String(cause?.message)).toMatch(/foreign key/);
  });

  it('refuses a transaction loudly - main’s driver has none', async () => {
    await expect(shared.db.transaction(async () => undefined)).rejects.toThrow(
      /Transactions are not supported/,
    );
  });

  it('runs queries in the order they were sent', async () => {
    const names = ['first', 'second', 'third'];
    // Not awaited one by one: each goes out at once, as concurrent IPC handlers send them.
    const writes = names.map((name, i) =>
      shared.db
        .insert(projects)
        .values({ name: `order-${name}`, sortOrder: 100 + i })
        .returning(),
    );
    const read = shared.db
      .select({ name: projects.name })
      .from(projects)
      .where(sql`${projects.name} like 'order-%'`)
      .orderBy(projects.sortOrder);
    const [, , , rows] = await Promise.all([...writes, read]);
    // The select was sent last, so it sees all three writes.
    expect(rows.map((r) => r.name)).toEqual(names.map((n) => `order-${n}`));
  });
});

describe('closing and crashing', () => {
  it('closes cleanly: PGlite lets go of the folder and it opens again', async () => {
    const dataDir = join(scratch, 'reopen');
    const first = start(dataDir);
    await first.ready;
    await first.db.insert(projects).values({ name: 'acme' });
    expect(existsSync(join(dataDir, 'postmaster.pid'))).toBe(true);
    await first.close();
    // Only PGlite's own close removes it - a thread that was just ended
    // (terminate, a skipped close) leaves it behind.
    expect(existsSync(join(dataDir, 'postmaster.pid'))).toBe(false);
    const second = start(dataDir);
    await second.ready;
    const rows = await second.db.select({ name: projects.name }).from(projects);
    expect(rows).toEqual([{ name: 'acme' }]);
    await second.close();
  }, 30_000);

  it('finishes the queries already sent before it closes (a save fired as the app quits)', async () => {
    const dataDir = join(scratch, 'drain');
    const first = start(dataDir);
    await first.ready;
    // Sent, not awaited, right before the close - the layout saves on quit.
    // (A drizzle query runs only once something calls `then`; execute() sends it now.)
    const writes = Array.from({ length: 50 }, (_, i) =>
      first.db
        .insert(projects)
        .values({ name: `saved-on-quit-${i}` })
        .execute(),
    );
    const closing = first.close();
    const settled = await Promise.allSettled(writes);
    expect(settled.filter((r) => r.status === 'rejected')).toEqual([]);
    await closing;
    await expect(first.db.select().from(projects)).rejects.toThrow();
    const second = start(dataDir);
    await second.ready;
    const rows = await second.db.select({ name: projects.name }).from(projects);
    expect(rows).toHaveLength(50);
    await second.close();
  }, 30_000);

  it('rejects in-flight queries and tells main once when the thread dies', async () => {
    const handle = start(join(scratch, 'crash'));
    await handle.ready;
    const gone: Error[] = [];
    handle.onGone((err) => gone.push(err));
    const inFlight = handle.db
      .select()
      .from(projects)
      .catch((e: unknown) => e);
    await handle.worker.terminate();
    const err = (await inFlight) as Error & { cause?: { code?: string } };
    // drizzle wraps the driver's error; ours is its cause.
    expect(err.cause?.code).toBe(DB_WORKER_GONE);
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ code: DB_WORKER_GONE });
    // Later queries fail at once instead of waiting forever.
    await expect(handle.db.select().from(projects)).rejects.toThrow();
    await handle.close();
    expect(gone).toHaveLength(1);
  }, 30_000);

  it('reports a failed open through `ready` with the open’s own error', async () => {
    const file = join(scratch, 'not-a-folder');
    writeFileSync(file, 'x');
    const handle = start(file);
    const gone: Error[] = [];
    handle.onGone((err) => gone.push(err));
    await expect(handle.ready).rejects.toThrow();
    await handle.close();
    // A failed open is not a crash: `ready` reported it.
    expect(gone).toHaveLength(0);
  }, 30_000);
});
