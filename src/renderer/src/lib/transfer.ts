import type { WorkspaceLayout } from '@renderer/lib/workspace/layout';

/**
 * Shape of a terminal tab moving between windows. Mirrors the type in
 * `src/preload/index.ts` / `src/main/index.ts` (the IPC boundary).
 */
export type TabDescriptor = {
  kind: 'terminal';
  /** Stable PTY id; the receiving window adopts the live shell by this id. */
  termId: string;
  title: string;
  cwd: string | null;
};

/**
 * The bottom panel's view state, carried on a session tear-off so the new window
 * restores it EXACTLY: whether the dock is open, which command is selected, and
 * which command terminals are open. The shells themselves travel via main's
 * ownership transfer (reassignSessionShells); this just restores the view
 * around them. Null when the session's dock was never mounted (never opened).
 */
export type CommandDockState = {
  open: boolean;
  selectedId: string | null;
  mountedIds: string[];
};

/**
 * A whole session being torn off into its own window. Carries the full layout
 * (every tab's `ptyId` + splits) so the new window reconstructs it exactly and
 * adopts each live shell. `layout` is null when the session was never opened in
 * the origin (no in-memory layout) - the new window then starts it fresh.
 */
export type SessionDescriptor = {
  kind: 'session';
  sessionId: string;
  /** The session's project: a session torn off from a project window returns there. */
  projectId: string | null;
  /** Session + project names, shown in the torn-off window's header and title. */
  label: string;
  projectName: string | null;
  layout: WorkspaceLayout | null;
  cwd: string | null;
  /** The bottom panel's view state, restored verbatim in the new window. */
  commandDock: CommandDockState | null;
};

/**
 * A whole project opened in its own window (a private plan):
 * every session of the project this window knows, with the live layout of the
 * ones it holds (open or evicted) - null for one it never opened, whose eager
 * shells main routes by id. The new window boots the full app scoped to the
 * project and seeds each session's view from these layouts.
 */
export type ProjectDescriptor = {
  kind: 'project';
  projectId: string;
  projectName: string;
  sessions: Array<{ sessionId: string; layout: WorkspaceLayout | null }>;
};

/**
 * One-shot bootstrap a freshly torn-off window reads on load (mirrors the
 * non-null `InitialPayload` variants in `src/preload/index.ts`): a single
 * terminal tab or a whole session (the reduced `DetachedWindow`), or a whole
 * project (the full router, scoped - see lib/workspace/project-scope.ts).
 */
export type DetachedPayload =
  | { kind: 'detached'; tab: TabDescriptor }
  | { kind: 'session'; session: SessionDescriptor }
  | { kind: 'project'; project: ProjectDescriptor };

/** The payloads `DetachedWindow` renders - everything but a project, which boots the router. */
export type DetachedWindowPayload = Exclude<DetachedPayload, { kind: 'project' }>;
