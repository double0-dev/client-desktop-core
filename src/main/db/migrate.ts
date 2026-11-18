import { cp, rm } from 'node:fs/promises';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { PGlite } from '@electric-sql/pglite';
import * as schema from './schema';

// Versioned schema via the drizzle migrator. Migration files are generated with
// `pnpm db:generate` into src/main/db/migrations. The migrator records applied
// migrations in the database (drizzle.__drizzle_migrations), so this is
// idempotent and upgrades an existing DB in place - only new migrations run, and
// user data is preserved across app updates.
//
// Runs in the database worker (db-worker.ts), so it never imports Electron:
// client.ts resolves the folder (source in dev, the app's Resources dir in a
// packaged build) and hands it over.

type Db = PgliteDatabase<typeof schema> & { $client: PGlite };

export async function runMigrations(
  db: Db,
  opts: { dataDir: string; migrationsFolder: string },
): Promise<void> {
  const { dataDir, migrationsFolder: folder } = opts;
  // Pending = local migration folders not yet recorded in the DB, matched by
  // name - the same rule the migrator itself uses (getMigrationsToRun).
  const applied = await appliedMigrationNames(db);
  const pending = readMigrationFiles({ migrationsFolder: folder }).filter(
    (m) => !m.name || !applied.has(m.name),
  );
  console.log(
    `[db] checking migrations (folder: ${folder}, applied: ${applied.size}, pending: ${pending.length})`,
  );

  // A migration can be destructive (drop/alter), so snapshot the data dir right
  // before one runs - only when an existing DB is about to be upgraded; a fresh
  // DB has nothing to lose. The previous backup is replaced: one "last schema
  // that worked" copy is all we keep. Every DB caller already waits on this
  // open, so the copy finishes before anything reads or writes - but it is
  // async: the folder runs to tens of MB over a thousand files, and a sync copy
  // froze the whole main process (IPC, window paint) for the first launch after
  // an update that ships a migration.
  if (pending.length > 0 && applied.size > 0) {
    const backupDir = `${dataDir}.backup-pre-migration`;
    await rm(backupDir, { recursive: true, force: true });
    await cp(dataDir, backupDir, { recursive: true });
    console.log(`[db] backed up data dir to ${backupDir}`);
  }

  const started = performance.now();
  await migrate(db, { migrationsFolder: folder });
  const ms = Math.round(performance.now() - started);

  if (pending.length > 0) {
    console.log(`[db] applied ${pending.length} new migration(s) (${ms}ms)`);
  } else {
    console.log(`[db] schema up to date - ${applied.size} migration(s) already applied (${ms}ms)`);
  }
}

/**
 * Names recorded in drizzle.__drizzle_migrations, or an empty set on a fresh DB
 * where the table doesn't exist yet (Postgres 42P01). Any other failure rethrows
 * - masking it as "nothing applied" would silently skip the backup and misreport
 * migration state.
 */
async function appliedMigrationNames(db: Db): Promise<Set<string>> {
  try {
    const res = await db.$client.query<{ name: string | null }>(
      'select name from drizzle.__drizzle_migrations',
    );
    return new Set(res.rows.map((r) => r.name).filter((n): n is string => n !== null));
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return new Set();
    throw err;
  }
}
