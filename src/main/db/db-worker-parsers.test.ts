import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it } from 'vitest';
import { DRIZZLE_PGLITE_PARSERS } from './db-worker-parsers';

/**
 * The worker hands PGlite the same type parsers drizzle's own PGlite driver
 * does, so main's drizzle maps the same raw values it always did. If a drizzle
 * upgrade changes its table, this fails and db-worker-parsers.ts follows.
 */

const client = new PGlite();
afterAll(() => client.close());

describe('DRIZZLE_PGLITE_PARSERS', () => {
  it('covers exactly the types drizzle’s PGlite driver parses itself', () => {
    const db = drizzle({ client });
    const probe = pgTable('probe', { id: text('id') });
    const prepared = db.select().from(probe).prepare('parsers_probe') as unknown as {
      queryConfig: { rowMode: string; parsers: Record<number, unknown> };
    };
    expect(prepared.queryConfig.rowMode).toBe('array');
    expect(Object.keys(DRIZZLE_PGLITE_PARSERS).sort()).toEqual(
      Object.keys(prepared.queryConfig.parsers).sort(),
    );
  });

  it('keeps a timestamp as the raw string drizzle parses', async () => {
    const res = await client.query<[string]>(
      "select '2026-01-02 03:04:05.678+00'::timestamptz",
      [],
      { rowMode: 'array', parsers: DRIZZLE_PGLITE_PARSERS },
    );
    expect(typeof res.rows[0][0]).toBe('string');
  });
});
