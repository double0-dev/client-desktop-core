import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { LOCAL_OWNER } from './constants';

// Local-first copies of backend/src/db/schema/* - same pg-core dialect (PGlite is
// Postgres), minus the users FK (no users table locally). `ownerId` defaults to
// the single local user. Production will switch to drizzle-kit migrations.

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 256 }).notNull(),
    description: text('description'),
    path: text('path'),
    // Null = no color of its own: the project follows the app accent color.
    color: varchar('color', { length: 16 }),
    // Unused since pinning went (a private plan): kept so an
    // older settings export still imports; the drop-project-pins migration
    // folded the pinned-first order into sortOrder and cleared it.
    pinned: boolean('pinned').notNull().default(false),
    // Manual list order (ascending; smaller = higher). New projects are stamped
    // with `-Date.now()` (lib/project-actions.ts createProject) so the newest
    // lands on top; a drag sets the midpoint between its new neighbours.
    // Fractional, hence doublePrecision.
    sortOrder: doublePrecision('sortOrder').notNull().default(0),
    // Worktree setup (Settings → Worktrees → project): the git-ignored paths
    // (relative to the repo root, folders with a trailing `/`) copied into every
    // new worktree of this project, and the command its setup tab runs once
    // afterwards. Empty + null = not set up: nothing is copied, nothing runs.
    worktreeCopyPaths: jsonb('worktreeCopyPaths').$type<string[]>().notNull().default([]),
    worktreeSetupCommand: text('worktreeSetupCommand'),
    // The host this project lives on (a private plan): the
    // id of an entry in this machine's hosts store (`double0-hosts`), null =
    // this machine. A session runs on its project's host - no column on
    // agent_sessions. A row naming a host this machine lacks is kept as is.
    hostId: text('hostId'),
    // A host project made for a project of this machine (its clone there,
    // a found copy or a plain terminal's folder): its sessions are listed
    // under that project and it is not listed itself (plan 29 › 12, user
    // decision 2026-11-01). No foreign key on purpose: a link to a project
    // that is gone just reads as unlinked - the host project shows again.
    linkedProjectId: uuid('linkedProjectId'),
    ownerId: uuid('ownerId').notNull().default(LOCAL_OWNER),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('projects_ownerId_createdAt_idx').on(table.ownerId, table.createdAt)],
);

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: varchar('label', { length: 64 }).notNull(),
    detail: text('detail').notNull().default(''),
    agent: varchar('agent', { length: 32 }).notNull().default(''),
    // Free-text command the primary terminal auto-runs on first spawn (from the
    // New Session dialog, e.g. `claude`, `codex`, or a custom command). null =
    // plain shell. Supersedes deriving the command from `agent`; pre-column
    // sessions fall back to agentStartupCommand(agent) in the renderer.
    startCommand: text('start_command'),
    // Session runtime: null = terminal session (the primary tab is a shell that
    // runs startCommand), else an extension's runtime (the primary tab is its
    // view and startCommand launches its agent).
    runtime: varchar('runtime', { length: 16 }),
    // Whether new "+" terminal tabs in this session also auto-run startCommand
    // (vs. opening a plain shell). Default true = every terminal runs it.
    runOnNewTerminal: boolean('run_on_new_terminal').notNull().default(true),
    // True while the user never named the session: launched with an empty name
    // (label seeded from the template), the label then follows the conversation
    // terminal's title reports (OSC 0/2 - e.g. Claude Code's task summary; see
    // session/auto-name.ts) until a manual rename pins it and clears this.
    autoNamed: boolean('auto_named').notNull().default(false),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    // Manual sidebar order (ascending; smaller = higher in the list). Kept OUT of
    // the status/updatedAt sort so a status change never reorders the list - only
    // an explicit drag does. New sessions are stamped with `-Date.now()` (see
    // launch-session) so the newest lands on top; a drag sets the midpoint between
    // its new neighbours. Fractional, hence doublePrecision.
    sortOrder: doublePrecision('sortOrder').notNull().default(0),
    // Absolute path of the git worktree backing this session (under
    // <project>/.worktree/<name>), or null for a session that runs in the project
    // dir itself. Drives the session's cwd (see workspace-chrome).
    worktreePath: text('worktreePath'),
    // Absolute folder the session runs in ("New session here" on an explorer
    // folder), or null for the project root / worktree root. For a worktree
    // session the path is already mapped inside the worktree (see launch-session).
    // Takes precedence over worktreePath/project.path in the cwd derivation.
    rootPath: text('rootPath'),
    // When the session last went into the archive (status 'archived'), null while
    // it is out of it. Stamped by main's db:update/db:insert from the status
    // alone (db/archive-stamp.ts), so every writer - the sweep, the menus, a
    // revive - keeps it right. Settings → Sessions deletes by it.
    archivedAt: timestamp('archivedAt', { withTimezone: true }),
    projectId: uuid('projectId').references(() => projects.id, { onDelete: 'cascade' }),
    ownerId: uuid('ownerId').notNull().default(LOCAL_OWNER),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_sessions_ownerId_updatedAt_idx').on(table.ownerId, table.updatedAt),
    // A project delete looks up its sessions by projectId (cascade broadcast in
    // db/ipc.ts), and the FK cascade itself scans the same column.
    index('agent_sessions_projectId_idx').on(table.projectId),
  ],
);

// Persisted workspace layout per session: the split tree + open terminal tabs and
// their placement (which pane, which split, row/column, sizes). One row per
// session so quitting and reopening the app restores a session's tabs and their
// layout. The shells themselves can't survive a restart - the layout's `ptyId`s
// just respawn fresh shells (re-running each tab's startup command) on restore.
//
// Kept OUT of `agent_sessions` on purpose: layouts change on every resize drag, and
// the agent_sessions collection feeds the sidebar/dashboard - pumping a large,
// rapidly-changing blob through it would re-render those on every drag. This table
// is reached via a dedicated IPC channel (window.api.layout), not a TanStack DB
// collection, since it needs no reactivity (read once on mount, write on change).
export const sessionLayouts = pgTable('session_layouts', {
  sessionId: uuid('sessionId')
    .primaryKey()
    .references(() => agentSessions.id, { onDelete: 'cascade' }),
  // The renderer's serialized WorkspaceLayout (rootId + nodes + tabs + activePaneId).
  layout: jsonb('layout').notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
});
