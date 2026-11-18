import { getTableColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { agentSessions, projects } from './schema';

/**
 * The IPC-reachable tables and the row schemas guarding them.
 *
 * Split out of ipc.ts (which pulls in Electron and PGlite) so row-schemas.test.ts
 * can check these against the Drizzle tables directly: a column added to
 * schema.ts without a matching key here is rejected by the strictObject at
 * runtime, and the insert fails silently from the user's point of view.
 */

// Mirrors of the renderer schemas (src/renderer/src/lib/collections.ts), enforced
// in main so a buggy or compromised renderer can't write rows the rest of the app
// can't read. Strict objects: unknown keys are rejected, not forwarded to SQL.
// Inserts take the full row (the renderer generates ids client-side); patches are
// partials - db:update strips id/createdAt and stamps updatedAt itself anyway.
const projectInsertSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1).max(256),
  description: z.string().nullable(),
  path: z.string().nullable(),
  color: z.string().max(16).nullable().optional(),
  pinned: z.boolean(),
  sortOrder: z.number().optional(),
  // Optional so exports predating the worktree setup still import.
  worktreeCopyPaths: z.array(z.string()).optional(),
  worktreeSetupCommand: z.string().nullable().optional(),
  // Remote sessions: the project's host (null = this machine). Optional so
  // exports predating hosts still import.
  hostId: z.string().max(64).nullable().optional(),
  linkedProjectId: z.string().uuid().nullable().optional(),
  ownerId: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const agentSessionInsertSchema = z.strictObject({
  id: z.string().uuid(),
  label: z.string().max(64),
  detail: z.string(),
  agent: z.string().max(32),
  startCommand: z.string().nullable().optional(),
  runtime: z.string().max(16).nullable().optional(),
  runOnNewTerminal: z.boolean().optional(),
  autoNamed: z.boolean().optional(),
  status: z.enum(['idle', 'active', 'needs-input', 'finished', 'done', 'archived']),
  worktreePath: z.string().nullable().optional(),
  rootPath: z.string().nullable().optional(),
  archivedAt: z.coerce.date().nullable().optional(),
  sortOrder: z.number().optional(),
  projectId: z.string().uuid().nullable(),
  ownerId: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/** A table reachable over the generic DB bridge: the Drizzle table and its row guards. */
export type TableDef = { table: PgTable; insert: z.ZodObject; patch: z.ZodObject };

const def = <I extends z.ZodObject>(table: PgTable, insert: I) => ({
  table,
  insert,
  patch: insert.partial(),
});

/** Core's tables. Pro adds its own through `registerTables` (MainExtension.db). */
export const CORE_TABLES = {
  projects: def(projects, projectInsertSchema),
  agent_sessions: def(agentSessions, agentSessionInsertSchema),
} satisfies Record<string, TableDef>;

export type CoreTableName = keyof typeof CORE_TABLES;

/** A name the bridge accepts: core's, or one an extension registered. */
export type TableName = string;

// Allowlist: only these tables are reachable over IPC, and the renderer-supplied
// name is mapped to a real table object (never interpolated into SQL). A Map,
// so an inherited key (`toString`) is never a table.
const registry = new Map<string, TableDef>(Object.entries(CORE_TABLES));

/**
 * Add an extension's tables to the bridge (src/main/index.ts, before the first
 * renderer message). A name core already serves is refused - an extension adds
 * tables, it never replaces one.
 */
export function registerTables(defs: Record<string, TableDef>): void {
  for (const [name, table] of Object.entries(defs)) {
    if (registry.has(name)) throw new Error(`db: table ${name} is already registered`);
    registry.set(name, table);
  }
}

export const isTable = (t: unknown): t is TableName => typeof t === 'string' && registry.has(t);

/** The registered table names, core's first. */
export const tableNames = (): TableName[] => [...registry.keys()];

export const tableDef = (name: TableName): TableDef => {
  const found = registry.get(name);
  if (!found) throw new Error(`db: unknown table ${name}`);
  return found;
};

export const tableOf = (name: TableName): PgTable => tableDef(name).table;

export const idOf = (table: PgTable): PgColumn =>
  (getTableColumns(table) as Record<string, PgColumn>).id;
