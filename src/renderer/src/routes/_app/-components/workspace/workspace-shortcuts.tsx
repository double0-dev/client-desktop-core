import { useEffect, useRef, type RefObject } from 'react';
import { showsView } from '@renderer/lib/workspace/tab-kinds';
import { useWorkspaceLayout } from '@renderer/lib/workspace/layout-context';
import {
  cycleTab,
  paneInDirection,
  tabInDirection,
  type Edge,
  type FocusDirection,
} from '@renderer/lib/workspace/layout';
import type { DockStackPanelId, RailTabId } from '@renderer/lib/workspace/dock-state';
import {
  flashFocusFrame,
  focusRegion,
  focusRegionPart,
  regionInDirection,
  regionOf,
  setFocusIn,
} from '@renderer/lib/workspace/focus-regions';
import { focusActiveTab } from '@renderer/lib/workspace/surface-focus';
import { getPooledTerminal } from '@renderer/lib/terminal/pool';
import { openTerminalFind } from '@renderer/lib/terminal/find';
import { clearTerminal } from '@renderer/lib/terminal/clear';
import {
  commands as allCommands,
  getKeymap,
  isCapturing,
  matchCombo,
  type CommandId,
} from '@renderer/lib/settings/keyboard-shortcuts';
import {
  clearActiveWorkspaceActions,
  setActiveWorkspaceActions,
  type WorkspaceActions,
} from '@renderer/lib/search/search-workspace-bridge';
import { rendererExtension } from '@renderer/lib/extension/registry';
import { isAppLocked } from '@renderer/lib/app-lock';
import { requestNewProject } from '@renderer/lib/projects/new-project-request';

/** Workspace commands that still run while a file editor has focus (besides
 * the focus walk) - tab-level keys Monaco binds nothing to. */
const EDITOR_PASSES = new Set<CommandId>([
  'close-tab',
  'reopen-closed-tab',
  'next-tab',
  'previous-tab',
]);

/**
 * The global workspace key handler. Renders nothing; it attaches one
 * capture-phase `keydown` listener and runs the matching command. Mounted
 * inside `WorkspaceLayoutProvider` (so it can drive layout actions) and below
 * `GitProvider` (so it can pull/push), with the chrome-level actions it can't
 * reach from here passed in as props.
 *
 * Only the active session's handler runs - the host keeps several sessions
 * mounted-but-hidden, and each renders its own `WorkspaceShortcuts`.
 */
export function WorkspaceShortcuts({
  isActiveSession,
  sessionId,
  projectId = null,
  openOverlay,
  bottomPanelOpen = false,
  cwd,
  onToggleDock,
  onToggleBottomPanel,
  onNewSession,
  openPanels = [],
  explorerOpen = false,
  viewRef,
}: {
  isActiveSession: boolean;
  /** This session - the bottom panel a palette-picked command runs in. */
  sessionId: string;
  /** The session's project, whose saved commands the palette lists. */
  projectId?: string | null;
  /** The extension tool whose overlay is up, if any. */
  openOverlay: string | null;
  /** Whether the bottom panel is shown: ⇧⌘↓ from the surface enters it, and
   * running a command from the palette opens it when it is not. */
  bottomPanelOpen?: boolean;
  /** This session's working directory - the folder handed to an IDE when the
   * Search Everywhere palette dispatches an "Open in <IDE>" action. */
  cwd: string | null;
  onToggleDock: (id: RailTabId) => void;
  onToggleBottomPanel: () => void;
  onNewSession: () => void;
  /** The dock panels currently open, top→bottom - the sidebar regions the
   * focus-direction shortcuts can land in (see lib/workspace/focus-regions.ts).
   * A detached terminal window has no sidebars and passes nothing. */
  openPanels?: DockStackPanelId[];
  /** Whether the file-explorer sidebar is shown (another focus region). */
  explorerOpen?: boolean;
  /** This view's root - focus moves are scoped to it, since the host keeps
   * other sessions' views mounted (hidden) with the same panel markup. */
  viewRef?: RefObject<HTMLElement | null>;
}) {
  const {
    layout,
    dispatch,
    addTerminal,
    splitWithNewTerminal,
    closeTab,
    reopenClosedTab,
    openFile,
    openBrowser,
  } = useWorkspaceLayout();
  // The extension's commands run through its own runner. The slot is fixed
  // for the window's life, so the hook is called (or not) on every render alike.
  const runExtension = rendererExtension().commands?.useRun();

  // Re-pointed every render so the (stable) listener always runs against the
  // current layout/git/props without re-subscribing on every layout tick.
  const runRef = useRef<(id: CommandId) => void>(() => {});
  // The workspace actions the Search Everywhere palette dispatches through.
  // Re-pointed each render (below) and indirected via a stable wrapper in the
  // effect, so only an active-session switch ever re-registers.
  const actionsRef = useRef<WorkspaceActions>({
    openFile,
    runCommand: () => {},
    openInEditor: () => {},
    openUrl: () => {},
    browserDevice: () => {},
    runShellCommand: () => {},
    commandScope: () => ({ projectId: null, cwd: null }),
  });
  runRef.current = (id: CommandId) => {
    const pane = layout.nodes[layout.activePaneId];
    const activeTabId = pane?.type === 'pane' ? pane.activeTabId : null;
    // Peel the active tab into a new split on `edge`. Node ids are minted here
    // (dispatch-side) so the reducer stays pure under StrictMode.
    const peelActive = (edge: Edge): void => {
      if (!activeTabId) return;
      dispatch({
        type: 'split',
        targetPaneId: layout.activePaneId,
        edge,
        tabId: activeTabId,
        newPaneId: crypto.randomUUID(),
        splitId: crypto.randomUUID(),
      });
    };
    // Move keyboard focus in `direction`. From the surface, first try the
    // neighbouring split pane (making it the active pane focuses its visible
    // terminal/editor via the layout's activePaneId). When nothing lies that
    // way - an unsplit workspace, or the edge of the splits - fall back to
    // walking the active pane's own tab strip (← previous, → next), so the same
    // shortcuts also switch tabs when more than one is open. Activating a tab in
    // the already-active pane focuses its terminal exactly like clicking the
    // tab. Past the first tab, ← leaves the surface for the sidebar: the file
    // explorer, then the dock's panels (which ↑/↓ walk); past the last tab, →
    // enters the drawer when one is open (its open state lives in the surface,
    // so it's read off the DOM: the drawer mounts as a region).
    // Past the bottom pane, ↓ enters the bottom panel when it's open, and ↑
    // comes back. → from the sidebar / ← from the drawer come back and put the caret in
    // the active tab explicitly (no layout change fires the surface's own
    // focus effects then).
    const focusPane = (direction: FocusDirection): void => {
      // Outline wherever focus ends up for a few seconds - also at an edge
      // where nothing moves, which still answers "where am I".
      flashFocusFrame();
      const root = viewRef?.current ?? document;
      const from = regionOf(document.activeElement);
      // Inside the bottom panel ←/→ move between its parts (a list, a terminal).
      if (from === 'bottom' && (direction === 'left' || direction === 'right')) {
        focusRegionPart(root, 'bottom', document.activeElement, direction);
        return;
      }
      if (from === 'surface') {
        const target = paneInDirection(layout, layout.activePaneId, direction);
        if (target) {
          dispatch({ type: 'setActivePane', paneId: target });
          return;
        }
        const tabId = tabInDirection(layout, layout.activePaneId, direction);
        if (tabId) {
          dispatch({ type: 'setActiveTab', paneId: layout.activePaneId, tabId });
          return;
        }
      }
      const next = regionInDirection(
        {
          dock: openPanels,
          explorer: explorerOpen,
          drawer: root.querySelector('[data-focus-region="drawer"]') != null,
          bottom: bottomPanelOpen,
        },
        from,
        direction,
      );
      if (!next) return;
      if (next === 'surface') {
        // Nothing focusable in the active tab (an image viewer, an editor still
        // loading): drop focus to <body> instead, which also counts as the
        // surface - otherwise the next ⇧⌘→ would start from the sidebar again
        // and the tabs/drawer past it could never be reached.
        if (!focusActiveTab(layout)) {
          (document.activeElement as HTMLElement | null)?.blur();
          setFocusIn(null);
        }
      } else {
        focusRegion(root, next);
      }
    };

    switch (id) {
      case 'new-session':
        onNewSession();
        break;
      case 'new-project':
        requestNewProject();
        break;
      case 'new-tab':
        addTerminal();
        break;
      // "vertically" = side by side (a new pane to the right); "horizontally" =
      // stacked (a new pane below).
      case 'new-tab-vertical':
        splitWithNewTerminal(layout.activePaneId, 'right');
        break;
      case 'new-tab-horizontal':
        splitWithNewTerminal(layout.activePaneId, 'bottom');
        break;
      case 'move-tab-vertical':
        peelActive('right');
        break;
      case 'move-tab-horizontal':
        peelActive('bottom');
        break;
      case 'focus-pane-left':
        focusPane('left');
        break;
      case 'focus-pane-right':
        focusPane('right');
        break;
      case 'focus-pane-up':
        focusPane('up');
        break;
      case 'focus-pane-down':
        focusPane('down');
        break;
      case 'close-tab':
        if (activeTabId) closeTab(activeTabId);
        break;
      case 'reopen-closed-tab':
        reopenClosedTab();
        break;
      case 'next-tab':
      case 'previous-tab': {
        const tabId = cycleTab(layout, layout.activePaneId, id === 'next-tab' ? 1 : -1);
        if (tabId) dispatch({ type: 'setActiveTab', paneId: layout.activePaneId, tabId });
        break;
      }
      case 'toggle-projects':
        onToggleDock('projects');
        break;
      case 'toggle-sessions':
        onToggleDock('sessions');
        break;
      case 'toggle-files':
        onToggleDock('files');
        break;
      // Tabs shows only with the vertical-tabs setting; `onToggleDock` ignores
      // it while hidden, so the shortcut is inert exactly when the rail tab is
      // absent (an extension's tools get the same gate).
      case 'toggle-tabs':
        onToggleDock('tabs');
        break;
      // From the palette (the key itself is the terminal's own): the active
      // pane's tab, when it is a terminal.
      case 'terminal-find': {
        const tab = activeTabId ? layout.tabs[activeTabId] : undefined;
        if (tab && tab.kind !== 'editor' && tab.ptyId && !showsView(tab)) {
          const term = getPooledTerminal(tab.ptyId)?.term;
          openTerminalFind(tab.ptyId, term?.getSelection() ?? '');
        }
        break;
      }
      case 'terminal-clear': {
        const tab = activeTabId ? layout.tabs[activeTabId] : undefined;
        const term = tab?.ptyId && !showsView(tab) ? getPooledTerminal(tab.ptyId)?.term : null;
        if (term) clearTerminal(term);
        break;
      }
      default:
        // One of the extension's commands.
        runExtension?.(id, {
          activeTab: activeTabId ? layout.tabs[activeTabId] : undefined,
          openOverlay,
          toggleTool: onToggleDock,
          toggleBottomPanel: () => {
            if (rendererExtension().bottomPanel) onToggleBottomPanel();
          },
          openPage: openBrowser ? (url) => openBrowser(url) : undefined,
        });
    }
  };
  actionsRef.current = {
    openFile,
    runCommand: (id) => runRef.current(id),
    openInEditor: (editorId) => {
      if (cwd) void window.api?.editors?.open(editorId, cwd);
    },
    openUrl: (url) => (openBrowser ? openBrowser(url) : window.open(url)),
    browserDevice: (deviceId) => {
      const browser = rendererExtension().browser;
      const tabId = browser?.focusedTab();
      if (browser && tabId) browser.setDevice(tabId, deviceId);
    },
    runShellCommand: (req) => {
      // Commands run in the extension's bottom panel; without one the palette
      // offers none, so this never fires.
      const dock = rendererExtension().bottomPanel;
      if (!dock) return;
      if (!bottomPanelOpen) onToggleBottomPanel();
      dock.requestRun(sessionId, req);
    },
    commandScope: () => ({ projectId, cwd }),
  };

  // Publish this session's workspace actions to the global Search Everywhere
  // palette while it's the active one, so selecting a file/action there lands in
  // the session the user is looking at. The registered object is a stable wrapper
  // indirecting through the ref, so switching the active session is the only
  // thing that re-registers.
  useEffect(() => {
    if (!isActiveSession) return;
    const actions: WorkspaceActions = {
      openFile: (filePath, opts) => actionsRef.current.openFile(filePath, opts),
      runCommand: (id) => actionsRef.current.runCommand(id),
      openInEditor: (editorId) => actionsRef.current.openInEditor(editorId),
      openUrl: (url) => actionsRef.current.openUrl(url),
      browserDevice: (deviceId) => actionsRef.current.browserDevice(deviceId),
      runShellCommand: (req) => actionsRef.current.runShellCommand(req),
      commandScope: () => actionsRef.current.commandScope(),
    };
    setActiveWorkspaceActions(actions);
    return () => clearActiveWorkspaceActions(actions);
  }, [isActiveSession]);

  useEffect(() => {
    if (!isActiveSession) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      // Stand down while a Settings row is capturing a new binding.
      if (isCapturing()) return;
      // A cover over the whole window (lib/app-lock.ts) owns the keyboard.
      if (isAppLocked()) return;
      // A modal (Settings, New session, a confirm) owns the keyboard while open.
      if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) return;
      // Don't hijack typing in real inputs - but the terminal (xterm) is exempt,
      // since it lets ⌘/Ctrl combos through to the app and that's where the user
      // spends most of their time. A file editor (Monaco's hidden textarea) is
      // exempt for the focus-direction commands only: without that, keyboard
      // navigation dead-ends on the first editor tab (⇧⌘→ could never get past
      // it to the next tab or the session-changes drawer). Close tab passes
      // too: Monaco binds nothing to ⌘W, so held back it closed nothing and
      // ⌘W looked dead on every file tab. The editor's other ⌘ combos stay
      // its own (⌘Enter, ⌘T…), as before. Tab cycling and reopen pass for the
      // same reason as close: Monaco binds none of them.
      const el = document.activeElement as HTMLElement | null;
      const editable =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      const inEditor = !!el?.closest('.monaco-editor');
      if (editable && el.closest('.xterm') == null && !inEditor) return;

      const keymap = getKeymap();
      // Editor- and terminal-group commands are handled by the focused editor
      // or terminal itself.
      const cmd = allCommands().find((c) => c.group === undefined && matchCombo(e, keymap[c.id]));
      if (!cmd) return;
      if (inEditor && !EDITOR_PASSES.has(cmd.id) && !cmd.id.startsWith('focus-pane-')) return;
      e.preventDefault();
      runRef.current(cmd.id);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isActiveSession]);

  return null;
}
