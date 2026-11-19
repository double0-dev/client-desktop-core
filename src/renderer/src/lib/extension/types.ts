import type { ComponentType, ReactNode } from 'react';
import type { z } from 'zod';
import type { LucideIcon } from 'lucide-react';
import type { AgentSession, Project } from '@renderer/lib/collections';
import type { RailTabId } from '@renderer/lib/workspace/dock-state';
import type { CommandScope } from '@renderer/lib/search/search-workspace-bridge';
import type { CommandRunRequest } from '@renderer/lib/search/run-request';
import type { SearchCandidate } from '@renderer/lib/search/types';
import type { CommandDockState } from '@renderer/lib/transfer';
import type { ExtensionCommands } from '@renderer/lib/settings/keyboard-shortcuts';
import type { SettingsSection } from '@renderer/routes/_app/-components/settings/settings-sections';
import type { NodeId, WorkspaceLayout } from '@renderer/lib/workspace/layout';
import type { HostStatus } from '@renderer/lib/hosts/host-status';
import type { PaneRect } from '@renderer/lib/workspace/use-pane-rects';
import type { InputEntry } from '../../../../main/terminal-inputs';
import type { Placement, PlacementInput } from '@renderer/lib/session/placement';
import type { RuntimeChoice, RuntimeChoiceInput } from '@renderer/lib/session/runtime-choice';

/**
 * The renderer's Pro slot (a private plan › Extension
 * points). `main.tsx` is the only core file that imports `@pro/renderer`,
 * and it installs the extension into the registry before the first render -
 * so the router layout and a torn-off window (which has no router) read the
 * same slots. A slot is added when the first feature that moves needs it.
 */
export type Edition = 'pro' | 'core';

/**
 * What the workspace chrome hands a rail tool: the window's sessions and
 * projects and the actions a tool may take on them. Built once per chrome
 * render; tools memoize on the lists, never on the functions.
 */
export type RailToolContext = {
  /** The session on screen, or null on a project's session-less view. */
  currentSessionId: string | null;
  /** The project this view shows (its session's, or the session-less view's). */
  projectId: string | null;
  /** That project's folder. */
  projectPath: string | null;
  /** The extension tool whose overlay is up, if any (a tool's dock may show another's data). */
  openOverlay: string | null;
  /** The view's folder: the session's (its root, worktree or project), else the project's. */
  cwd: string | null;
  /** Every session this window lists (a project window: its own only). */
  sessions: AgentSession[];
  projects: Project[];
  projectOf: (s: AgentSession) => Project | undefined;
  /** The folder a session works in (its root, worktree or project). */
  sessionFolder: (s: AgentSession) => string | null;
  /** The session's root folder label, when it runs in a subfolder. */
  sessionRootLabel: (s: AgentSession) => string | null;
  /** Sessions shown in another window right now. */
  releasedIds: string[];
  /** This chrome is the active session's and is not released - live data may run. */
  live: boolean;
  /** Whether this tool's overlay is open. */
  open: boolean;
  /** Close this tool's overlay. */
  close: () => void;
  /** Show a session: navigate to it, or raise the window it lives in. */
  openSession: (s: AgentSession) => void;
};

/**
 * An exclusive overlay on the icon rail (dock panel + content takeover). The rail renders the icon, the chrome mounts `Provider`
 * around the whole workspace (so the badge, panel and view share one model)
 * and shows `DockPanel` + `View` while the tool is open.
 */
export type RailTool = {
  id: RailTabId;
  icon: LucideIcon;
  label: string;
  Provider: ComponentType<{ ctx: RailToolContext; children: ReactNode }>;
  DockPanel: ComponentType;
  View: ComponentType;
  /** The count bubble on the rail icon (rendered inside the Provider). */
  Badge?: ComponentType;
  /** It shows a session's worktree branch (a session row's worktree icon opens it). */
  showsWorktrees?: boolean;
};

/**
 * Sign-in (decision 15: login is Pro). Absent = no account at all: the core
 * build opens straight into the workspace and shows no Account row.
 */
export type AuthSlot = {
  /** May the app run? `signed-out` sends the window to /sign-in. */
  status(): Promise<'signed-in' | 'signed-out'>;
  /** The /sign-in route's screen. */
  SignInScreen: ComponentType;
  /** Settings › General's ACCOUNT block. */
  AccountSection: ComponentType;
  /**
   * A cover over the whole window while the app may not be used, the
   * workspace kept mounted under it (nothing unsaved is lost). Mounted last
   * in every window - the app layout and a torn-off window - and it decides
   * itself whether it shows. Absent: nothing covers the app.
   */
  Lock?: ComponentType;
};

/**
 * The update UI: a banner, the Updates rows and the gear's dot. Absent: the
 * build never updates itself.
 */
export type UpdatesSlot = {
  /** A newer build is available / downloading / downloaded (the gear's dot). */
  usePending(): boolean;
  /** The once-per-version banner above the tab strip. */
  Banner: ComponentType;
  /** Settings › General's Updates rows + the auto-check toggle. */
  SettingsRows: ComponentType;
  /** Main asks to open Settings › General (a clicked update notification). */
  onOpenSettings(cb: () => void): () => void;
};

/** The bottom panel's props, as the chrome and a torn-off window mount it. */
export type BottomPanelProps = {
  sessionId: string;
  projectId: string | null;
  cwd?: string | null;
  open?: boolean;
  visible?: boolean;
  initialState?: CommandDockState | null;
  onClose: () => void;
};

/**
 * A panel under the surface that runs a session's commands: the rail's
 * toggle, the palette's Commands tab and the run requests the palette sends
 * it. Absent: no panel, no toggle, no Commands tab.
 */
export type BottomPanelSlot = {
  Dock: ComponentType<BottomPanelProps>;
  /** Ask `sessionId`'s dock to run `req` (now, or once it listens). */
  requestRun(sessionId: string, req: CommandRunRequest): void;
  /** The palette's Commands tab candidates for the active session. */
  usePaletteCommands(scope: CommandScope | null, open: boolean): SearchCandidate[];
};

/** A Settings section of a Pro feature: its nav entry and its body. */
export type ProSettingsSection = SettingsSection & { Body: ComponentType };

/** What the chrome (and a torn-off window) hands the workspace's git provider. */
export type GitProviderProps = {
  /** The repo the view reads; null = no project, undefined = still resolving. */
  cwd: string | null | undefined;
  /** The project the workspace shows. */
  projectId?: string | null;
  /** Only the visible session's provider talks to git. */
  active: boolean;
  /** The extension tool whose overlay is up, if any (its heavier reads wait for its own). */
  openOverlay: string | null;
  children: ReactNode;
};

/** The review drawer beside a session's panes. */
export type SessionDrawerProps = {
  onClose: () => void;
  /** Open the tool that shows this session's changes in full (the footer link). */
  onOpenTool?: () => void;
};

/**
 * A git client: the workspace's provider, the review drawer and the git keys.
 * Absent = the core build: a status-only provider
 * (workspace/git-status-provider.tsx), no drawer and no drawer toggle. Its
 * tool window is a rail tool (`tool`); its keys are `commands`.
 */
export type GitSlot = {
  /** The rail tool its commit box lives in (the commit key opens it). */
  tool: string;
  /** Replaces core's status-only provider and fills its context too. */
  Provider: ComponentType<GitProviderProps>;
  Drawer: ComponentType<SessionDrawerProps>;
};

/** A dev server a session's terminal announced (one per origin). */
export type SessionServer = { url: string; ptyId: string };

/** How the workspace opens a page: in a new tab, beside, or in a pane. */
export type OpenBrowser = (
  url?: string,
  opts?: { paneId?: NodeId; split?: 'left' | 'right' | 'top' | 'bottom'; newTab?: boolean },
) => void;

/** What the workspace body hands the browser tabs' layer. */
export type BrowserLayerProps = {
  layout: WorkspaceLayout;
  rects: Map<NodeId, PaneRect>;
  version: number;
  sessionId: string | null;
  cwd: string | null;
  isActiveSession: boolean;
  onActivatePane: (paneId: NodeId) => void;
};

/** A browser device preset (the palette's Device actions). */
export type BrowserDevice = {
  id: string;
  label: string;
  width: number;
  height: number;
  mobile?: boolean;
};

/**
 * Page tabs: a tab kind that shows a web page, the dev-server chips and
 * forwards, the page controls the keys and the palette reach. Absent: no page
 * tab kind (a saved one shows the placeholder), links open in the system
 * browser, no server chips.
 */
export type BrowserSlot = {
  /** The kind its page tabs carry in a layout (stored - never renamed). */
  tabKind: string;
  Layer: ComponentType<BrowserLayerProps>;
  /** A remote terminal's server nobody opened yet: forwarding it is the
   * user's open - the local URL to load. null = no forward needed. */
  forward(url: string): Promise<string | null> | null;
  /** Navigate a mounted tab's page; false when its page is not mounted. */
  navigate(tabId: string, url: string): boolean;
  /** A new tab's title before its page names itself. */
  tabTitle(url: string): string;
  /** The tab whose page has the keyboard, if any. */
  focusedTab(): string | null;
  togglePick(tabId: string): void;
  setDevice(tabId: string, deviceId: string | null): void;
  devices: readonly BrowserDevice[];
  /** Every terminal's announced servers, one URL per origin (the palette). */
  useServerUrls(): string[];
  /** A session's servers (the + menu's rows). */
  useSessionServers(ptyIds: readonly string[], sessionId: string): readonly SessionServer[];
  /** Follow a terminal's announced servers while its view is mounted. */
  trackServers(ptyIds: string[]): void;
  /** A terminal's server chip. */
  TerminalChip: ComponentType<{ ptyId: string; onOpen: (url: string) => void }>;
  /** Open a URL a terminal printed beside that terminal. */
  openPreviewBeside(
    open: OpenBrowser,
    layout: WorkspaceLayout | undefined,
    ptyId: string,
    url: string,
  ): void;
};

/** What the workspace body hands an extension view's layer. */
export type SessionViewLayerProps = {
  sessionId: string | undefined;
  /** The session's host (its agent runs there), null = this machine. */
  hostId?: string | null;
  layout: WorkspaceLayout;
  rects: Map<NodeId, PaneRect>;
  version: number;
  isActiveSession: boolean;
  onActivatePane: (paneId: NodeId) => void;
  /** Flip a shell tab shown in the view back to its terminal. */
  onShowTerminal: (tabId: string) => void;
};

/** The calls core's session plumbing makes to a runtime session's agent (main owns it). */
export type SessionViewBridge = {
  open(sessionId: string): Promise<unknown>;
  stop(sessionId: string): Promise<unknown>;
  /** A runtime session's "+" tabs' verdict, combined with its agent's in main. */
  terminalStatus?(sessionId: string, status: string): Promise<unknown>;
};

/**
 * A view an extension draws in place of a terminal: over a shell tab's own
 * agent CLI (`Tab.view`), and as the primary tab of a session whose runtime
 * has no shell (`agent_sessions.runtime`, `lib/session/templates.ts` ›
 * `runsInView`). Absent = the core build: every tab shows its terminal (a tab
 * saved in a view shows its terminal too), every session runs in a terminal.
 */
export type SessionViewSlot = {
  /** The `Tab.view` value, and the primary tab's `Tab.kind`, this view owns. */
  view: string;
  /** The `agent_sessions.runtime` value of a session that runs in it. */
  runtime: string;
  /** How menus and buttons name it: "Show as …", the button over a terminal. */
  labels: { show: string; button: string; buttonTitle: (cliName: string) => string };
  Icon: LucideIcon;
  /** Its bridge to main - read when called, never at module load. */
  bridge(): SessionViewBridge | undefined;
  Layer: ComponentType<SessionViewLayerProps>;
  /** Drop a view's renderer state (a closed tab, a deleted session). */
  forget(key: string): void;
  /** Raise the alerts for sessions that finished or wait while the app was closed. */
  raiseAwayAlerts(): void;
  /** The Inputs list's jumps through a tab shown in the view. */
  hasJump(ptyId: string): boolean;
  showsInput(ptyId: string, entry: InputEntry, list: InputEntry[]): boolean;
  jumpToInput(ptyId: string, entry: InputEntry, list: InputEntry[]): boolean;
  /** New session's runtime choice (lib/session/runtime-choice.ts). */
  useRuntimeChoice(input: RuntimeChoiceInput): RuntimeChoice;
};

/**
 * Remote hosts (M7, a private plan, plan 29): the hosts
 * store and its dialogs, the badges, where a new session runs (New
 * session's placement), the project-on-a-host fields in New project, the
 * session menu's own items. Absent = the core build: no host anywhere (the host
 * directory is empty), every session runs on this computer.
 */
/** Every host's connection status, as main reports it. */
export type HostStatusFeed = {
  statuses(): Promise<HostStatus[]>;
  onChanged(cb: (statuses: HostStatus[]) => void): () => void;
};

export type HostsSlot = {
  /** The status feed core's host-aware surfaces read (lib/hosts/host-status.ts). */
  statusFeed(): HostStatusFeed | undefined;
  /** The app-level host dialogs (the ssh login tab, agent sign-in). */
  AppDialogs: ComponentType;
  HostBadge: ComponentType<{ hostId: string | null | undefined; className?: string }>;
  /** The session menu's own items (moving a session elsewhere). */
  SessionMenuItems: ComponentType<{ sessionId: string }>;
  newSession: {
    /** Where a new session runs and the fields that choose it (lib/session/placement.ts). */
    usePlacement(input: PlacementInput): Placement;
  };
  newProject: {
    /** Which machine the project lives on (null = this computer). */
    MachinePicker: ComponentType<{
      value: string | null;
      onChange: (hostId: string | null) => void;
    }>;
    RemoteFolderPicker: ComponentType<{
      hostId: string;
      onPick: (path: string) => void;
      onCancel: () => void;
    }>;
  };
};

/** A repo picker's tool: `git` (the workspace's git surfaces) or an extension tool's id (lib/git/repo-choice.ts). */
export type RepoTool = string;

/**
 * The connected hosting accounts (GitHub / GitLab) and their per-project
 * ticks - the official build's (decision 17: integrations are Pro). Core asks
 * only what its shared surfaces need: which repos a tool's picker offers
 * and the settings document's section.
 * Each `use…` is a React hook, called on every render of the caller.
 */
export type IntegrationsSlot = {
  /** Whether a tool's repo picker offers a repo (judged on the repo's own path). */
  useRepoOffered(tool: RepoTool): (repoPath: string) => boolean;
  /** A folder-of-repos project's folder, for a window that has no project row. */
  useProjectRepoFolder(projectId: string | null): string | null;
  /** The folders main knows hold child repos (folder-of-repos projects). */
  useRepoFolders(): readonly string[];
  /** Its section of the settings document (Settings › JSON, export / import). */
  settings: SettingsDocSection;
};

/**
 * Desk-side alerts for a session that needs you (lib/session/status-alerts.ts).
 * Core derives every status - the dots, the row, the dock badge - and hands
 * each change here; absent = the core build, which raises no alert of its own.
 */
export type AlertsSlot = {
  /** One of this window's sessions moved from `prev` to `next` (never a quiet change). */
  statusChanged(
    sessionId: string,
    prev: AgentSession['status'],
    next: AgentSession['status'],
  ): void;
  /**
   * A window's workspace is up: `activate` opens a session in it (a clicked
   * alert). Returns the undo, run when the workspace goes.
   */
  attach(activate: (sessionId: string) => void): () => void;
};

/** An extension's section of the settings document (lib/settings/settings-transfer.ts). */
export type SettingsDocSection = {
  /** Its top-level key in the document. */
  key: string;
  /** Validates the section; its issues are reported under `key`. */
  schema: z.ZodType;
  /** Resolves once `collect` can answer (a store fed from main). */
  ensureLoaded(): Promise<void>;
  /** The section now; undefined = leave it out of the document. */
  collect(): unknown;
  /** Apply a validated section (absent from the document = never called). */
  apply(value: unknown): void;
};

/**
 * Settings › export / import (lib/settings/settings-transfer.ts): the
 * extension's own sections of the export file. Core writes and reads
 * settings, projects, sessions and layouts; an extension adds top-level
 * sections next to them and imports them after core's projects and sessions.
 */
export type DataTransferSlot = {
  /** The top-level keys it writes and reads - any other key core does not know is reported as skipped. */
  sections: readonly string[];
  /** What its sections hold, as Settings › General names them ("saved notes, boards"). */
  describes: string;
  /** Its sections of a new export, keyed as in `sections`. */
  collect(): Promise<Record<string, unknown>>;
  /** Import its sections of a parsed file; runs after core's projects and sessions. */
  apply(doc: Record<string, unknown>, ctx: DataTransferContext): Promise<DataTransferApplied>;
};

export type DataTransferContext = {
  /** Project ids that exist now - locally or just imported. */
  existingProjects: ReadonlySet<string>;
  /** Session ids that exist now - locally or just imported. */
  existingSessions: ReadonlySet<string>;
};

export type DataTransferApplied = {
  /** Named counts (`taskItemsCreated`), for tests and logs. */
  counts: Record<string, number>;
  /** One line per kind of item, shown in the import result. */
  summary: string[];
  /** Per-item problems; those items were skipped. */
  errors: string[];
};

export type RendererExtension = {
  edition: Edition;
  /**
   * Runs once, when main.tsx installs the extension (before the first render,
   * after every module loaded) - where Pro starts what a module load is too
   * early for (mirroring a setting into main).
   */
  start?(): void;
  railTools: readonly RailTool[];
  /** The rail's default order, the extension's tools among the core's (lib/workspace/dock-state.ts). */
  railOrder?: readonly RailTabId[];
  /**
   * Which of its rail tools exist for the project on screen: absent from the
   * record = always; `null` = not known yet (the tool waits, its overlay stays).
   */
  useRailToolAvailability?(projectId: string | null): Readonly<Record<string, boolean | null>>;
  auth?: AuthSlot;
  updates?: UpdatesSlot;
  bottomPanel?: BottomPanelSlot;
  /** Its commands: Settings › Keyboard shortcuts rows, keys and palette actions. */
  commands?: ExtensionCommands;
  /** Settings sections of Pro features (Tasks, ...) - none in the core build. */
  settingsSections?: readonly ProSettingsSection[];
  git?: GitSlot;
  browser?: BrowserSlot;
  sessionView?: SessionViewSlot;
  hosts?: HostsSlot;
  dataTransfer?: DataTransferSlot;
  integrations?: IntegrationsSlot;
  /** Its sections of the settings document (Settings › JSON, export / import). */
  settingsDocSections?: readonly SettingsDocSection[];
  /** Its persisted settings keys - "Reset all settings" clears them with core's. */
  settingsStorageKeys?: readonly string[];
  /** Rows it adds to Settings › General, after the updates rows. */
  generalRows?: readonly ComponentType[];
  /** Items at the right end of a session's status bar, after the Inputs list. */
  statusBarItems?: readonly ComponentType<StatusBarItemProps>[];
  alerts?: AlertsSlot;
  /**
   * A render failure a boundary caught (components/slot-boundary.tsx): a
   * caught error never reaches the window's global error handlers, so this
   * is the extension's only chance to record it. Absent: logged only.
   */
  reportError?(error: unknown, where: string): void;
};

/** What the session's status bar hands an extension's item. */
export type StatusBarItemProps = {
  /** The focused tab's shell, null when it is no terminal. */
  focusedPtyId: string | null;
  /** The folder the session runs in (a remote one names its host). */
  sessionPath: string | null;
};
