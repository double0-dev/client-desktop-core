import { BrowserWindow, app, ipcMain } from 'electron';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { getDb } from './client';
import { agentSessions } from './schema';
import { archivedAtOnInsert, archivedAtOnUpdate } from './archive-stamp';
import { idOf, isTable, tableDef, tableOf, type TableName } from './row-schemas';
import type { DeleteCascade } from './delete-cascade';

export type { DeleteCascade, DeleteCascadePlan } from './delete-cascade';
import { refreshSessionBadge } from '../badge';
import { projectRowsChanged } from '../project-rows';
import {
  claudeSessionRecordsDir,
  codexSessionRecordsDir,
  forgetClaudeSession,
  forgetCodexSession,
} from '../agent-resume';

/** Flatten a zod failure into one readable line for the thrown IPC error. */
const zodIssues = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');

/**
 * Only a window's top frame (our own bundle) may touch the DB - reject calls from
 * any other frame (an iframe that somehow gained access to the preload bridge).
 */
function assertMainFrame(event: Electron.IpcMainInvokeEvent, channel: string): void {
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error(`${channel}: rejected call from a non-main frame`);
  }
}

export type DbChange =
  | { table: TableName; type: 'insert' | 'update'; row: unknown }
  | { table: TableName; type: 'delete'; id: string };

/**
 * A row change made in main outside these handlers (the startup
 * crash-recovery sweep, crash-recovery.ts) takes the same path to the
 * renderers as an IPC write.
 */
export function broadcastDbChange(change: DbChange): void {
  broadcast(change);
}

const sessionDeletedListeners = new Set<(sessionId: string) => void>();

/**
 * Main-side hook for a deleted session row - its own delete or a project
 * cascade (an extension's runtime sessions drop their agent and its log).
 * Fired from the broadcast, so it sees exactly the deletes every window sees.
 */
export function onSessionRowDeleted(listener: (sessionId: string) => void): () => void {
  sessionDeletedListeners.add(listener);
  return () => sessionDeletedListeners.delete(listener);
}

const sessionRowListeners = new Set<(row: unknown) => void>();

/**
 * Main-side hook for an inserted or updated session row (a remote session's
 * host manifest follows its label and folders, hosts/session-manifests.ts).
 */
export function onSessionRowChanged(listener: (row: unknown) => void): () => void {
  sessionRowListeners.add(listener);
  return () => sessionRowListeners.delete(listener);
}

const projectRowsListeners = new Set<() => void>();

/**
 * Main-side hook for any projects row change (insert, update, delete): the
 * remote-host path resolver re-reads its project roots (hosts/hosts-ipc.ts).
 */
export function onProjectRowsChanged(listener: () => void): () => void {
  projectRowsListeners.add(listener);
  return () => projectRowsListeners.delete(listener);
}

/** Push a row change to every live window so each renderer's collection updates. */
function broadcast(change: DbChange): void {
  if (change.table === 'agent_sessions' && change.type === 'delete') {
    for (const listener of sessionDeletedListeners) listener(change.id);
  } else if (change.table === 'agent_sessions' && change.type !== 'delete') {
    for (const listener of sessionRowListeners) listener(change.row);
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('db:change', change);
  }
  // A session status change may flip the dock/taskbar status dot (running / needs input).
  if (change.table === 'agent_sessions') refreshSessionBadge();
  // Integrations are scoped per project, and enforced on paths: a new project
  // (or a session worktree under one) has to reach main's path registry before
  // the next git spawn, and the settings table wants the new row's remote.
  if (change.table === 'projects' || change.table === 'agent_sessions') projectRowsChanged();
  if (change.table === 'projects') for (const listener of projectRowsListeners) listener();
}

const CHANNELS = ['db:list', 'db:insert', 'db:update', 'db:delete'] as const;

// Invalid payloads THROW (surfacing in the renderer as a rejected invoke) rather
// than returning null - a null looks like success to the collection handlers, so
// the optimistic row would silently vanish instead of rolling back with an error.
export function registerDbIpc(cascade?: DeleteCascade): () => void {
  ipcMain.handle('db:list', async (event, payload: { table?: unknown }) => {
    assertMainFrame(event, 'db:list');
    if (!isTable(payload?.table))
      throw new Error(`db:list: unknown table ${String(payload?.table)}`);
    const db = await getDb();
    return db.select().from(tableOf(payload.table));
  });

  ipcMain.handle('db:insert', async (event, payload: { table?: unknown; row?: unknown }) => {
    assertMainFrame(event, 'db:insert');
    if (!isTable(payload?.table)) {
      throw new Error(`db:insert: unknown table ${String(payload?.table)}`);
    }
    const parsed = tableDef(payload.table).insert.safeParse(payload.row);
    if (!parsed.success) {
      throw new Error(`db:insert(${payload.table}): invalid row - ${zodIssues(parsed.error)}`);
    }
    const db = await getDb();
    const values = { ...(parsed.data as Record<string, unknown>) };
    if (payload.table === 'agent_sessions') {
      values.archivedAt = archivedAtOnInsert(values, new Date());
    }
    const [row] = await db
      .insert(tableOf(payload.table))
      .values(values as never)
      .returning();
    broadcast({ table: payload.table, type: 'insert', row });
    return row;
  });

  ipcMain.handle(
    'db:update',
    async (event, payload: { table?: unknown; id?: unknown; patch?: unknown }) => {
      assertMainFrame(event, 'db:update');
      if (!isTable(payload?.table)) {
        throw new Error(`db:update: unknown table ${String(payload?.table)}`);
      }
      if (typeof payload.id !== 'string') throw new Error('db:update: id must be a string');
      const parsed = tableDef(payload.table).patch.safeParse(payload.patch);
      if (!parsed.success) {
        throw new Error(`db:update(${payload.table}): invalid patch - ${zodIssues(parsed.error)}`);
      }
      const db = await getDb();
      const table = tableOf(payload.table);
      // Never let the client move the PK or rewrite createdAt; always stamp
      // updatedAt server-side (replaces the old Postgres trigger).
      const rest = { ...(parsed.data as Record<string, unknown>) };
      delete rest.id;
      delete rest.createdAt;
      // The archive clock follows the status (db/archive-stamp.ts); the client
      // never sets it. `coalesce` keeps the first stamp when an already
      // archived session is written 'archived' again.
      if (payload.table === 'agent_sessions') {
        delete rest.archivedAt;
        const stamp = archivedAtOnUpdate(rest);
        if (stamp === 'stamp') rest.archivedAt = sql`coalesce(${agentSessions.archivedAt}, now())`;
        else if (stamp === 'clear') rest.archivedAt = null;
      }
      const [row] = await db
        .update(table)
        .set({ ...rest, updatedAt: new Date() } as never)
        .where(eq(idOf(table), payload.id))
        .returning();
      // Broadcasting `row: undefined` would crash every window's collection sync
      // (getKey(undefined)) - a vanished row is an error the caller rolls back.
      if (!row) throw new Error(`db:update(${payload.table}): no row with id ${payload.id}`);
      broadcast({ table: payload.table, type: 'update', row });
      return row;
    },
  );

  ipcMain.handle('db:delete', async (event, payload: { table?: unknown; id?: unknown }) => {
    assertMainFrame(event, 'db:delete');
    if (!isTable(payload?.table)) {
      throw new Error(`db:delete: unknown table ${String(payload?.table)}`);
    }
    if (typeof payload.id !== 'string') throw new Error('db:delete: id must be a string');
    const db = await getDb();
    const table = tableOf(payload.table);
    // FK cascades happen inside the DB, but each window's collections only hear
    // what we broadcast - capture the doomed child ids up front so every cascade
    // is replayed as explicit delete events. Core's own: a project delete takes
    // its sessions. An extension plans the cascades into its tables.
    const cascadedSessionIds =
      payload.table === 'projects'
        ? (
            await db
              .select({ id: agentSessions.id })
              .from(agentSessions)
              .where(eq(agentSessions.projectId, payload.id))
          ).map((s) => s.id)
        : [];
    const plan = cascade ? await cascade(db, payload.table, payload.id) : { deletes: [] };
    const [row] = (await db
      .delete(table)
      .where(eq(idOf(table), payload.id))
      .returning()) as Record<string, unknown>[];
    // Deleting an already-gone row is a no-op (delete is idempotent), but don't
    // broadcast a phantom delete for it.
    if (!row) return null;
    broadcast({ table: payload.table, type: 'delete', id: payload.id });
    for (const id of cascadedSessionIds) broadcast({ table: 'agent_sessions', type: 'delete', id });
    // A deleted session's primary conversation record (keyed by the session id,
    // see agent-resume.ts) is dead with it; the records of its other tabs go on
    // tab close (terminal:dispose).
    const deadSessionIds = [
      ...(payload.table === 'agent_sessions' ? [payload.id] : []),
      ...cascadedSessionIds,
    ];
    if (deadSessionIds.length) {
      const recordsDir = claudeSessionRecordsDir(app.getPath('userData'));
      const codexRecords = codexSessionRecordsDir(app.getPath('userData'));
      for (const id of deadSessionIds) {
        forgetClaudeSession(recordsDir, `conversation:${id}`);
        forgetCodexSession(codexRecords, `conversation:${id}`);
      }
    }
    for (const doomed of plan.deletes) broadcast({ ...doomed, type: 'delete' });
    for (const changed of (await plan.after?.()) ?? []) {
      broadcast({ table: changed.table, type: 'update', row: changed.row });
    }
    return { id: payload.id };
  });

  return () => {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}
