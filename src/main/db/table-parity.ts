import { getTableColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { idOf, type TableDef } from './row-schemas';

/**
 * The parity checks every table on the DB bridge owes (a test helper - only
 * test files import it). The zod row schemas are hand-maintained mirrors of
 * the Drizzle tables, and they are STRICT: a column added to a schema file
 * without a matching key makes every insert carrying it fail validation -
 * which the renderer sees as an optimistic row quietly rolling back, with no
 * obvious cause. Core runs it over its tables (row-schemas.test.ts), an
 * extension over its own.
 */
export function describeTableParity(
  defs: Record<string, TableDef>,
  validRow: (name: string) => Record<string, unknown>,
): void {
  const names = Object.keys(defs);
  const columnsOf = (table: PgTable): Record<string, PgColumn> =>
    getTableColumns(table) as Record<string, PgColumn>;
  const shapeOf = (schema: z.ZodObject): Record<string, z.ZodType> =>
    schema.shape as Record<string, z.ZodType>;

  it('resolves each name to a table with an id primary key', () => {
    for (const name of names) {
      const id = idOf(defs[name].table);
      expect(id, name).toBeDefined();
      expect(id.primary, name).toBe(true);
    }
  });

  describe.each(names)('%s insert schema', (name) => {
    const { table, insert } = defs[name];
    const columns = columnsOf(table);
    const shape = shapeOf(insert);

    it('has exactly one key per table column', () => {
      // Missing key  -> strictObject rejects the row and the insert fails.
      // Extra key    -> the value is forwarded to a column that does not exist.
      expect(Object.keys(shape).sort()).toEqual(Object.keys(columns).sort());
    });

    it('requires every NOT NULL column that has no database default', () => {
      for (const [key, column] of Object.entries(columns)) {
        if (!column.notNull || column.hasDefault) continue;
        const field = shape[key];
        expect(field, `${name}.${key} has no schema key`).toBeDefined();
        expect(field.safeParse(undefined).success, `${name}.${key} must be required`).toBe(false);
      }
    });

    it('accepts null exactly where the column is nullable', () => {
      for (const [key, column] of Object.entries(columns)) {
        // Timestamps are exempt - z.coerce.date() coerces null to the epoch
        // instead of rejecting it (pinned in row-schemas.test.ts).
        if (column.columnType === 'PgTimestamp') continue;
        const accepts = shape[key].safeParse(null).success;
        expect(accepts, `${name}.${key} nullability`).toBe(!column.notNull);
      }
    });

    it('rejects unknown keys instead of forwarding them to SQL', () => {
      const row = validRow(name);
      expect(insert.safeParse(row).success).toBe(true);
      expect(insert.safeParse({ ...row, notAColumn: 'x' }).success).toBe(false);
    });

    it('accepts a full valid row', () => {
      const parsed = insert.safeParse(validRow(name));
      expect(parsed.success ? null : z.prettifyError(parsed.error)).toBeNull();
    });

    it('rejects a non-uuid id', () => {
      expect(insert.safeParse({ ...validRow(name), id: 'not-a-uuid' }).success).toBe(false);
    });
  });

  describe.each(names)('%s patch schema', (name) => {
    const { insert, patch } = defs[name];

    it('accepts an empty patch', () => {
      expect(patch.safeParse({}).success).toBe(true);
    });

    it('accepts a single-field patch', () => {
      const row = validRow(name);
      const key = Object.keys(insert.shape).find((k) => k !== 'id');
      expect(patch.safeParse({ [key!]: row[key!] }).success).toBe(true);
    });

    it('stays strict about unknown keys', () => {
      expect(patch.safeParse({ notAColumn: 'x' }).success).toBe(false);
    });
  });
}
