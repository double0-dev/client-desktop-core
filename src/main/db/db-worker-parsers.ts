import { types } from '@electric-sql/pglite';

/** The worker's half of the protocol that needs PGlite (db-worker-protocol.ts must not). */

const raw = (value: string): string => value;

/**
 * The type parsers drizzle's own PGlite driver passes with every query
 * (drizzle-orm/pglite/session.js, `queryConfig.parsers`): dates, timestamps
 * and intervals - and their arrays - come back as the raw strings drizzle's
 * column mappers parse in main. Without them PGlite returns `Date` objects
 * the mappers do not expect. db-worker-parsers.test.ts fails when a drizzle
 * upgrade changes drizzle's table.
 */
export const DRIZZLE_PGLITE_PARSERS: Record<number, (value: string) => unknown> = {
  [types.TIMESTAMP]: raw,
  [types.TIMESTAMPTZ]: raw,
  [types.INTERVAL]: raw,
  [types.DATE]: raw,
  [1231]: raw,
  [1115]: raw,
  [1185]: raw,
  [1187]: raw,
  [1182]: raw,
};
