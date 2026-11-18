import { getTableColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  CORE_TABLES,
  isTable,
  registerTables,
  tableDef,
  tableNames,
  tableOf,
  type CoreTableName,
  type TableDef,
} from './row-schemas';
import { sessionLayouts } from './schema';
import { describeTableParity } from './table-parity';

/**
 * Core's tables on the DB bridge and the registry an extension adds its own
 * to. The strictness checks every table owes are in table-parity.ts.
 */

const names = Object.keys(CORE_TABLES) as CoreTableName[];
const columnsOf = (table: PgTable): Record<string, PgColumn> =>
  getTableColumns(table) as Record<string, PgColumn>;
const SCHEMAS = {
  projects: CORE_TABLES.projects,
  agent_sessions: CORE_TABLES.agent_sessions,
};

describe('table allowlist', () => {
  it("serves core's tables", () => {
    expect(tableNames().slice(0, names.length)).toEqual(names);
  });

  it('recognises allowlisted names and rejects everything else', () => {
    for (const name of names) expect(isTable(name)).toBe(true);
    expect(isTable('session_layouts')).toBe(false);
    expect(isTable('users')).toBe(false);
    expect(isTable('projects; drop table projects')).toBe(false);
    expect(isTable('toString')).toBe(false); // inherited keys are not tables
    expect(isTable(undefined)).toBe(false);
    expect(isTable(42)).toBe(false);
  });

  it('keeps session_layouts off the generic DB bridge', () => {
    // It is reached through window.api.layout instead - and it has no `id`
    // column, so the generic id-keyed handlers could not serve it anyway.
    expect(names).not.toContain('session_layouts');
    expect(columnsOf(sessionLayouts).id).toBeUndefined();
  });
});

describe('registerTables', () => {
  // An extension adds tables; it must never swap the guard of a core one.
  it('adds an extension table and refuses a name already served', () => {
    const extra: TableDef = { ...CORE_TABLES.projects };
    registerTables({ test_extension_table: extra });
    expect(isTable('test_extension_table')).toBe(true);
    expect(tableDef('test_extension_table')).toBe(extra);
    expect(() => registerTables({ projects: extra })).toThrow(/already registered/);
    expect(() => registerTables({ test_extension_table: extra })).toThrow(/already registered/);
    expect(tableOf('projects')).toBe(CORE_TABLES.projects.table);
  });

  it('throws for a name nobody registered', () => {
    expect(() => tableDef('not_a_table')).toThrow(/unknown table/);
  });
});

describeTableParity(CORE_TABLES, (name) => validRow(name as CoreTableName));

describe('date handling', () => {
  it('coerces the ISO strings that cross the IPC boundary back into Dates', () => {
    // Dates do not survive structured cloning as Dates through every path into
    // main (settings import replays JSON), so the schemas coerce.
    const parsed = SCHEMAS.projects.insert.parse({
      ...validRow('projects'),
      createdAt: '2026-08-06T10:00:00.000Z',
      updatedAt: '2026-08-06T10:00:00.000Z',
    });
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(parsed.createdAt.toISOString()).toBe('2026-08-06T10:00:00.000Z');
  });

  it('rejects a date it cannot make sense of', () => {
    const bad = SCHEMAS.projects.insert.safeParse({
      ...validRow('projects'),
      createdAt: 'not a date',
    });
    expect(bad.success).toBe(false);
  });

  it('coerces null on a NOT NULL timestamp to the epoch rather than rejecting', () => {
    // Documented, not endorsed: z.coerce.date() runs `new Date(null)`, which is
    // a valid 1970 date, so a null createdAt slips past a NOT NULL column's
    // guard. Nothing sends null today (the renderer always stamps real dates,
    // and settings-import replays ISO strings); if that ever changes, tighten
    // the schema to z.coerce.date() on a non-nullable input and update this.
    const parsed = SCHEMAS.projects.insert.safeParse({
      ...validRow('projects'),
      createdAt: null,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.createdAt.getTime()).toBe(0);
  });
});

describe('column-specific constraints', () => {
  it('only allows the session statuses the UI renders', () => {
    const row = validRow('agent_sessions');
    for (const status of ['idle', 'active', 'needs-input', 'done', 'archived']) {
      expect(SCHEMAS.agent_sessions.insert.safeParse({ ...row, status }).success, status).toBe(
        true,
      );
    }
    expect(SCHEMAS.agent_sessions.insert.safeParse({ ...row, status: 'paused' }).success).toBe(
      false,
    );
  });

  it('enforces the varchar lengths the columns declare', () => {
    // A too-long value would be truncated or error at the DB; catch it earlier.
    const long = 'x'.repeat(300);
    expect(SCHEMAS.projects.insert.safeParse({ ...validRow('projects'), name: long }).success).toBe(
      false,
    );
    expect(
      SCHEMAS.agent_sessions.insert.safeParse({ ...validRow('agent_sessions'), label: long })
        .success,
    ).toBe(false);
  });

  it('rejects an empty name where the UI requires one', () => {
    expect(SCHEMAS.projects.insert.safeParse({ ...validRow('projects'), name: '' }).success).toBe(
      false,
    );
  });
});

// --- fixtures -----------------------------------------------------------------

const UUID = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-08-06T10:00:00.000Z');
const base = { id: UUID, ownerId: UUID, createdAt: NOW, updatedAt: NOW };

/** A minimal row that must pass its table's insert schema. */
function validRow(name: CoreTableName): Record<string, unknown> {
  switch (name) {
    case 'projects':
      return {
        ...base,
        name: 'production-pipeline',
        description: null,
        path: '/Users/emmaw/code/production-pipeline',
        color: '#6366f1',
        pinned: false,
      };
    case 'agent_sessions':
      return {
        ...base,
        label: 'Fix flaky tests',
        detail: '',
        agent: 'claude',
        status: 'active',
        projectId: UUID,
      };
  }
}
