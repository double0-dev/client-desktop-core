import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Main's drizzle is the pg-proxy driver over the database worker
 * (db/worker-db.ts), which has no transactions: `db.transaction()` throws at
 * run time. A new one in main would pass review and fail only when its code
 * path runs - so it fails here first. Work that needs one belongs in the
 * worker (db-worker.ts, as the migrations do).
 */

const repo = fileURLToPath(new URL('../../..', import.meta.url));

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

describe('main runs no database transactions', () => {
  it('finds no .transaction( call in main (core and, when present, Pro)', () => {
    const roots = [join(repo, 'src/main'), join(repo, 'the official build')];
    const offenders = roots
      .flatMap(sources)
      // The worker runs on real PGlite, where transactions work.
      .filter((file) => !/[\\/]db[\\/](db-worker|migrate)\.ts$/.test(file))
      .filter((file) => /\.transaction\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repo, file));
    expect(offenders).toEqual([]);
  });
});
