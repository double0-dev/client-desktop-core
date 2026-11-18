import { createCollection } from '@tanstack/react-db';
import { z } from 'zod';
import { ipcSync } from '@renderer/lib/local-collection';

// Local-first: every collection is backed by the embedded PGlite database in the
// main process, over the window.api.db IPC bridge (see lib/local-collection.ts +
// src/main/db). No Electric, no backend, no txid - local writes are synchronously
// durable and broadcast back to every window via `db:change`.
//
// To re-introduce cloud sync later, swap a collection's `sync`/handlers back to
// `electricCollectionOptions(...)`; the schemas and all UI queries stay the same.

/**
 * Run a handler's persistence work, logging failures with context before
 * re-throwing - a rejected onInsert/onUpdate/onDelete is how TanStack DB knows
 * to roll back the transaction's optimistic state.
 */
export async function persist(context: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(`[collections] ${context} failed - rolling back optimistic state`, err);
    throw err;
  }
}

// --- Projects ---------------------------------------------------------------

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(256),
  description: z.string().nullable(),
  path: z.string().nullable(),
  // Null = follows the app accent color. Defaulted so imports predating the
  // project color picker validate.
  color: z.string().max(16).nullable().default(null),
  pinned: z.boolean(),
  // Manual list order (ascending), secondary to pinned-first grouping. Defaulted
  // so imports predating the column validate.
  sortOrder: z.number().default(0),
  // Worktree setup (Settings → Worktrees): git-ignored paths copied into each
  // new worktree + the setup tab's command. Defaulted so older rows/imports
  // read as "not set up" instead of failing validation.
  worktreeCopyPaths: z.array(z.string()).default([]),
  worktreeSetupCommand: z.string().nullable().default(null),
  // The host this project lives on (a private plan): an id
  // from this machine's hosts store, null = this machine. Defaulted so rows
  // and imports predating hosts validate.
  hostId: z.string().max(64).nullable().default(null),
  linkedProjectId: z.string().uuid().nullable().default(null),
  ownerId: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type Project = z.infer<typeof projectSchema>;

export const projectsCollection = createCollection({
  id: 'projects',
  schema: projectSchema,
  getKey: (project) => project.id,
  sync: ipcSync<Project>('projects'),
  onInsert: ({ transaction }) =>
    persist('projects insert', async () => {
      for (const m of transaction.mutations) await window.api.db.insert('projects', m.modified);
    }),
  onUpdate: ({ transaction }) =>
    persist('projects update', async () => {
      // Send only the changed fields - a full row would clobber concurrent
      // edits to other fields arriving from another window.
      for (const m of transaction.mutations) {
        await window.api.db.update('projects', m.original.id, m.changes);
      }
    }),
  onDelete: ({ transaction }) =>
    persist('projects delete', async () => {
      for (const m of transaction.mutations) await window.api.db.remove('projects', m.original.id);
    }),
});

// --- Agent sessions (Live feed; created via the New session dialog) ---------

export const agentSessionSchema = z.object({
  id: z.string().uuid(),
  label: z.string().max(64),
  detail: z.string(),
  agent: z.string().max(32),
  // Free-text startup command (New Session dialog). Nullable/optional so pre-column
  // rows and older settings-transfer imports (without the field) still validate.
  startCommand: z.string().nullable().optional(),
  runtime: z.string().max(16).nullable().optional(),
  // Whether new "+" terminals inherit the start command. Defaulted for the same reason.
  runOnNewTerminal: z.boolean().default(true),
  // True while the label follows the terminal's title reports (session launched
  // without a name; see session/auto-name.ts). Defaulted so pre-column rows and
  // older settings-transfer imports validate - absent means user-named.
  autoNamed: z.boolean().default(false),
  // 'finished' = the agent stopped while the session was not on screen; it
  // reads as idle again the moment the session is opened (session/attention.ts).
  status: z.enum(['idle', 'active', 'needs-input', 'finished', 'done', 'archived']),
  // Optional/nullable so older settings-transfer imports (without the field) still validate.
  worktreePath: z.string().nullable().optional(),
  // Absolute folder the session runs in (subfolder session), null/absent = project
  // or worktree root. Optional/nullable for the same import-compat reason.
  rootPath: z.string().nullable().optional(),
  // When the session went into the archive; null while it is out. Main stamps
  // it from the status on every write (db/archive-stamp.ts) - never set it here.
  // Optional/nullable so rows and imports predating the column validate.
  archivedAt: z.coerce.date().nullable().optional(),
  // Manual sidebar order (ascending). Defaulted so imports predating the column validate.
  sortOrder: z.number().default(0),
  projectId: z.string().uuid().nullable(),
  ownerId: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type AgentSession = z.infer<typeof agentSessionSchema>;

export const agentSessionsCollection = createCollection({
  id: 'agent_sessions',
  schema: agentSessionSchema,
  getKey: (session) => session.id,
  sync: ipcSync<AgentSession>('agent_sessions'),
  onInsert: ({ transaction }) =>
    persist('agent_sessions insert', async () => {
      for (const m of transaction.mutations) {
        await window.api.db.insert('agent_sessions', m.modified);
      }
    }),
  onUpdate: ({ transaction }) =>
    persist('agent_sessions update', async () => {
      // Send only the changed fields - a full row would clobber concurrent
      // edits to other fields arriving from another window.
      for (const m of transaction.mutations) {
        await window.api.db.update('agent_sessions', m.original.id, m.changes);
      }
    }),
  onDelete: ({ transaction }) =>
    persist('agent_sessions delete', async () => {
      for (const m of transaction.mutations) {
        await window.api.db.remove('agent_sessions', m.original.id);
      }
    }),
});
