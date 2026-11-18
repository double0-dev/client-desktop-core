import { createContext, useContext, type Dispatch } from 'react';
import type { Edge, NodeId, TabId, WorkspaceLayout } from '@renderer/lib/workspace/layout';
import type { WorkspaceAction } from '@renderer/lib/workspace/reducer';

export type WorkspaceLayoutContextValue = {
  layout: WorkspaceLayout;
  /** Raw dispatch for side-effect-free actions (split/move/resize/setActive…). */
  dispatch: Dispatch<WorkspaceAction>;
  /** Open a fresh terminal tab in a pane (defaults to the active pane). */
  addTerminal: (paneId?: NodeId) => void;
  /**
   * Open a new terminal pre-set to a template's start command (long-press the
   * "+"): `command` '' opens a plain shell, else it auto-runs that command. The
   * tab is titled after the template. Defaults to the active pane.
   */
  addTemplateTerminal: (title: string, command: string, paneId?: NodeId) => void;
  /** Open a fresh terminal in a new split of `paneId` on the given edge. */
  splitWithNewTerminal: (paneId: NodeId, edge: Edge) => void;
  /**
   * Open a file in an editor tab in the active pane (or `paneId`, or a new
   * split of it on `split`). If a tab for that path is already open it's
   * activated instead of duplicated.
   */
  openFile: (
    filePath: string,
    opts?: {
      paneId?: NodeId;
      split?: Edge;
      /** A host's file outside every project root there (opened read-only). */
      hostId?: string;
    },
  ) => void;
  /**
   * Open a browser tab (a private plan): '' is the new-tab
   * page. A URL on a server that already has a tab activates and navigates
   * that tab instead, unless `newTab`. `split` opens it on a new split of
   * `paneId` (default: the active pane).
   */
  /** Open a page in a browser tab. Absent in the core build (browser tabs are Pro). */
  openBrowser?: (url?: string, opts?: { paneId?: NodeId; split?: Edge; newTab?: boolean }) => void;
  /** Close a tab: kill its PTY + xterm (terminals) or drop the editor, then remove it. */
  closeTab: (tabId: TabId) => void;
  /**
   * Close several tabs in order (tab-menu bulk actions). Non-closable tabs are
   * skipped; unsaved editors among the targets are confirmed once, not per tab.
   */
  closeTabs: (tabIds: TabId[]) => void;
  /**
   * Bring back the most recently closed editor or browser tab (Reopen closed
   * tab, lib/workspace/closed-tabs.ts). An editor whose file is open again is
   * activated rather than duplicated. False when there is nothing to reopen.
   */
  reopenClosedTab: () => boolean;
  /** Tab ids whose editor has unsaved changes - drives the tab strip's dot. */
  dirtyTabs: ReadonlySet<TabId>;
  /** Report an editor tab's dirty state (called from the editor on edit/save). */
  setTabDirty: (tabId: TabId, dirty: boolean) => void;
  /**
   * A file/folder was renamed/moved on disk: repoint any open editor tab at (or
   * under) `oldPath` to the new location so it keeps saving to the right file.
   */
  remapEditorPaths: (oldPath: string, newPath: string) => void;
  /** A file/folder was deleted on disk: close any open editor tab at or under it. */
  closeEditorsUnder: (path: string) => void;
};

export const WorkspaceLayoutContext = createContext<WorkspaceLayoutContextValue | null>(null);

export function useWorkspaceLayout(): WorkspaceLayoutContextValue {
  const ctx = useContext(WorkspaceLayoutContext);
  if (!ctx) throw new Error('useWorkspaceLayout must be used within a WorkspaceLayoutProvider');
  return ctx;
}
