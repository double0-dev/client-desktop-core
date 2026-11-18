import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  initialLayout,
  nextShellTitle,
  normalizeRestoredLayout,
  paneOf,
  removeTab,
  setTabView,
  shellPtyIds,
  CONVERSATION_TAB_ID,
  type Edge,
  type NodeId,
  type Tab,
  type TabId,
  type WorkspaceLayout,
} from '@renderer/lib/workspace/layout';
import { workspaceReducer } from '@renderer/lib/workspace/reducer';
import {
  popClosed,
  rememberClosed,
  reopenTarget,
  type ClosedTab,
} from '@renderer/lib/workspace/closed-tabs';
import {
  WorkspaceLayoutContext,
  type WorkspaceLayoutContextValue,
} from '@renderer/lib/workspace/layout-context';
import { disposePooledTerminal } from '@renderer/lib/terminal/pool';
import { cliViewKey } from '@renderer/lib/session/pty-ids';
import { setSessionDirty } from '@renderer/lib/session/dirty';
import { unarchiveSession } from '@renderer/lib/session/unarchive';
import {
  isViewLaunch,
  setOneShotCommand,
  setupPtyId,
  takeViewLaunch,
  takePendingSessionSetup,
} from '@renderer/lib/session/setup';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { confirmCloseBusyTab, confirmCloseBusyTabs } from '@renderer/components/busy-tabs-dialog';
import { busyShellTabs, getTerminalBusy } from '@renderer/lib/terminal/busy';
import { getSessionQuestion } from '@renderer/lib/session/questions';
import { recheckSessionStatus } from '@renderer/lib/session/status';
import { noteFocusedTab } from '@renderer/lib/review/review-target';
import { fileName, isPathInside, remapPath } from '@renderer/lib/utils';
import { originOf } from '@renderer/lib/url';
import { rendererExtension } from '@renderer/lib/extension/registry';

// Window-wide close-guard state, shared by every mounted provider (several
// sessions can be open in one window; any of them blocking is enough, and only
// one discard dialog should ever be up).
let unloadConfirmShowing = false;
let unloadDiscardConfirmed = false;

/**
 * The primary tab's kind for a session whose runtime this build has no view
 * for: a placeholder that never spawns a shell (its start command is no
 * terminal command).
 */
const UNAVAILABLE_VIEW = 'unavailable-view';

/** A session's first layout: its primary tab, in the extension's view when it was launched so. */
function firstLayout(
  sessionId: string,
  primaryTitle: string | undefined,
  startupCommand: string | undefined,
  inView: boolean,
): WorkspaceLayout {
  const view = rendererExtension().sessionView?.view;
  const layout = initialLayout(sessionId, primaryTitle, startupCommand, {
    view: inView ? (view ?? UNAVAILABLE_VIEW) : undefined,
  });
  return view && isViewLaunch(sessionId) ? setTabView(layout, CONVERSATION_TAB_ID, view) : layout;
}

/**
 * Holds one session's layout (a `useReducer` over the pure tree ops) and the
 * action helpers that have side effects or mint ids - kept out of the reducer so
 * it stays pure under StrictMode. The context object + `useWorkspaceLayout` hook
 * live in `lib/workspace-layout-context.ts`.
 */
export function WorkspaceLayoutProvider({
  sessionId,
  initial,
  primaryTitle,
  startupCommand,
  runOnNewTerminal = true,
  inView = false,
  children,
}: {
  sessionId: string;
  /** Seed layout (detached terminal windows); defaults to the session's. */
  initial?: WorkspaceLayout;
  /** Label for the primary tab (the session's agent); see `initialLayout`. */
  primaryTitle?: string;
  /** Startup command for the session's terminals (e.g. `claude`); see `initialLayout`. */
  startupCommand?: string;
  /**
   * Whether new "+" terminal tabs also auto-run `startupCommand` (vs. a plain
   * shell). The primary tab always runs it; only additional terminals honour
   * this. Defaults to true (the pre-opt-out behaviour).
   */
  runOnNewTerminal?: boolean;
  /**
   * A session whose runtime has no shell (`runsInView`): the primary tab is
   * the extension's view. Callers pass no `startupCommand` for it - that column
   * holds the runtime's launch command, which must never run in a terminal.
   */
  inView?: boolean;
  children: ReactNode;
}) {
  const [layout, dispatch] = useReducer(
    workspaceReducer,
    sessionId,
    // Seeds are normalized defensively: a slightly-invalid blob (restored from
    // disk or handed across windows) is repaired - orphans pruned, tree
    // re-collapsed - rather than crashing the provider; one beyond repair falls
    // back to a fresh layout. Valid seeds pass through with tab identity intact.
    (sid) =>
      (initial ? normalizeRestoredLayout(initial) : null) ??
      firstLayout(sid, primaryTitle, startupCommand, inView),
  );

  // Always read the freshest layout inside stable callbacks (no stale closures,
  // no churning callback identities).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // A session launched onto the extension's view: its first layout is saved at once
  // (the surface skips saving the layout it mounted with), so it reopens there.
  useEffect(() => {
    if (takeViewLaunch(sessionId)) window.api?.layout?.save(sessionId, layoutRef.current);
    // Mount only: the launch mark is for the first layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember which shells you focus, so a review (browser picks, diff
  // comments) goes to the agent you were last talking to - the browser tab
  // itself holds focus while you comment (lib/review/review-target.ts).
  const activePane = layout.nodes[layout.activePaneId];
  const focusedTabId = activePane?.type === 'pane' ? activePane.activeTabId : undefined;
  useEffect(() => {
    if (focusedTabId) noteFocusedTab(sessionId, layoutRef.current.tabs[focusedTabId]);
  }, [sessionId, focusedTabId]);

  // The conversation tab froze the agent label + start command at session
  // creation - and the frozen command WINS when "+" terminals inherit it (see
  // newTerminalTab) and re-runs on a restart respawn. Reconcile the tab whenever
  // the session's live values change (the Edit session dialog), so edits
  // actually reach new terminals and survive a relaunch. Detached windows pass
  // no session context (both props undefined) and keep their traveled layout
  // authoritative; the dispatch is a no-op when nothing changed.
  useEffect(() => {
    if (primaryTitle === undefined && startupCommand === undefined) return;
    dispatch({
      type: 'syncConversation',
      title: primaryTitle ?? 'Terminal',
      startupCommand,
    });
  }, [primaryTitle, startupCommand]);

  // Editor tabs with unsaved changes. A flat set keyed by tab id; the editor
  // reports in/out of it on edit and save, and the tab strip reads it to show a
  // dot. Kept here (not per-editor) so it survives the editor scrolling out of an
  // inactive pane and is readable by the close path.
  const [dirtyTabs, setDirtyTabs] = useState<Set<TabId>>(() => new Set());
  const dirtyTabsRef = useRef(dirtyTabs);
  dirtyTabsRef.current = dirtyTabs;

  // Publish this session's dirty state to the window-wide registry so code
  // outside this provider (the sidebar's delete flow) can check it; cleared on
  // unmount so a closed workspace can't leave a stale flag behind.
  useEffect(() => {
    setSessionDirty(sessionId, dirtyTabs.size > 0);
  }, [sessionId, dirtyTabs]);
  useEffect(() => () => setSessionDirty(sessionId, false), [sessionId]);

  // Guard the window against closing over unsaved edits. Electron fires
  // `beforeunload` before a window closes (including app quit); cancelling the
  // event blocks the close but - unlike a browser - shows no native prompt. So
  // on block we raise our own dialog, and a confirmed discard re-triggers
  // `window.close()` with the guard lowered.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent): void => {
      if (unloadDiscardConfirmed) return;
      if (dirtyTabsRef.current.size === 0) return;
      event.preventDefault();
      event.returnValue = false; // Electron treats a set returnValue as "cancel the close"
      if (unloadConfirmShowing) return;
      unloadConfirmShowing = true;
      void confirmDialog({
        title: 'Discard unsaved changes?',
        description: 'Some open files have unsaved changes that will be lost if you close now.',
        confirmLabel: 'Discard and close',
        destructive: true,
      }).then((ok) => {
        unloadConfirmShowing = false;
        if (ok) {
          unloadDiscardConfirmed = true;
          window.close();
        }
      });
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const newTerminalTab = useCallback((): Tab => {
    // New terminals inherit the session's template from the primary tab: a
    // Claude Code session opens more "Claude Code" terminals that launch the
    // agent, a Terminal session opens plain shells. Reading it off the layout
    // means this also works in detached windows, where the primary tab travels
    // with the serialized layout. The primary tab is closable (once another
    // shell exists), so fall back to the provider's session template when it's
    // gone.
    const primary = Object.values(layoutRef.current.tabs).find((t) => t.kind === 'conversation');
    // Honour the session's "run on new terminals" opt-out: when off, a new tab is
    // a plain shell (no startup command), while the primary tab still ran it.
    const inheritedCommand = runOnNewTerminal
      ? (primary?.startupCommand ?? startupCommand)
      : undefined;
    // Title (and thereby the tab icon, keyed off it) follows what the tab will
    // actually RUN: only a tab launching the agent command inherits the agent
    // title - a plain shell reads as "Terminal" even in a Claude Code session.
    const base = inheritedCommand ? (primary?.title ?? primaryTitle ?? 'Terminal') : 'Terminal';
    return {
      id: crypto.randomUUID(),
      kind: 'terminal',
      title: nextShellTitle(layoutRef.current.tabs, base),
      ptyId: crypto.randomUUID(),
      startupCommand: inheritedCommand,
    };
  }, [primaryTitle, startupCommand, runOnNewTerminal]);

  // Opening a terminal in an archived session is the user picking it back up:
  // bring it out of the archive here, explicitly - a fresh shell's prompt is
  // gated out of status derivation as an app-induced redraw, so the status
  // observer's own auto-unarchive (session/status.ts) wouldn't see it until
  // something actually ran in it.
  const addTerminal = useCallback(
    (paneId?: NodeId) => {
      unarchiveSession(sessionId);
      dispatch({
        type: 'addTab',
        paneId: paneId ?? layoutRef.current.activePaneId,
        tab: newTerminalTab(),
      });
    },
    [sessionId, newTerminalTab],
  );

  // Open a terminal from a specific template (long-press the "+"), independent of
  // the session's default: `command` '' → plain shell, else auto-run it. Titled
  // after the template, numbered ("Codex 2") once one of that name is open.
  // Picking the session's OWN agent runs the session's command, as a short
  // click does: a session started through a wrapper (`claude-personal`, an
  // env-prefixed `claude`) reads as "Claude Code", and the built-in template's
  // bare `claude` would launch the agent under another account.
  const addTemplateTerminal = useCallback(
    (title: string, command: string, paneId?: NodeId) => {
      unarchiveSession(sessionId);
      const primary = Object.values(layoutRef.current.tabs).find((t) => t.kind === 'conversation');
      const sessionCommand = primary?.startupCommand ?? startupCommand;
      const sessionTitle = primary?.title ?? primaryTitle;
      if (sessionCommand && title.trim() === sessionTitle) command = sessionCommand;
      dispatch({
        type: 'addTab',
        paneId: paneId ?? layoutRef.current.activePaneId,
        tab: {
          id: crypto.randomUUID(),
          kind: 'terminal',
          title: nextShellTitle(layoutRef.current.tabs, title.trim() || 'Terminal'),
          ptyId: crypto.randomUUID(),
          startupCommand: command.trim() || undefined,
        },
      });
    },
    [sessionId, primaryTitle, startupCommand],
  );

  // Add a dedicated "setup" terminal for a worktree session's setup step (e.g.
  // `npm i`). Launch already spawned this shell - running the command - under the
  // session's deterministic setup PTY id, so the tab adopts the live shell here.
  // The one-shot (memory-only, not a persisted startup command) is a fallback for
  // when that spawn couldn't happen (no PTY bridge); main ignores it when the
  // shell already runs, and it never re-runs on relaunch - the tab then persists
  // as a plain shell in the worktree.
  const addSetupTerminal = useCallback(
    (command: string) => {
      const ptyId = setupPtyId(sessionId);
      setOneShotCommand(ptyId, command);
      const tab: Tab = { id: crypto.randomUUID(), kind: 'terminal', title: 'setup', ptyId };
      dispatch({ type: 'addTab', paneId: layoutRef.current.activePaneId, tab });
    },
    [sessionId],
  );

  // On a worktree session's first mount, spawn its one-time setup terminal. The
  // read-and-delete keeps it to a single tab under StrictMode's double mount, and
  // once added the tab lives in the (persisted) layout, so this never repeats.
  useEffect(() => {
    const command = takePendingSessionSetup(sessionId);
    if (command) addSetupTerminal(command);
  }, [sessionId, addSetupTerminal]);

  const splitWithNewTerminal = useCallback<WorkspaceLayoutContextValue['splitWithNewTerminal']>(
    (paneId, edge) => {
      unarchiveSession(sessionId);
      // Node ids are minted here, dispatch-side, so the reducer stays pure
      // (StrictMode double-invokes it; minting inside would fork the ids).
      dispatch({
        type: 'splitNewTerminal',
        paneId,
        edge,
        tab: newTerminalTab(),
        newPaneId: crypto.randomUUID(),
        splitId: crypto.randomUUID(),
      });
    },
    [sessionId, newTerminalTab],
  );

  const setTabDirty = useCallback((tabId: TabId, dirty: boolean) => {
    setDirtyTabs((prev) => {
      if (dirty === prev.has(tabId)) return prev;
      const next = new Set(prev);
      if (dirty) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  }, []);

  const openFile = useCallback(
    (filePath: string, opts: { paneId?: NodeId; split?: Edge; hostId?: string } = {}) => {
      const current = layoutRef.current;
      // Re-focus an already-open file rather than opening a second tab for it
      // (the same path on another machine is another file).
      const existing = Object.values(current.tabs).find(
        (t) =>
          t.kind === 'editor' &&
          t.filePath === filePath &&
          (t.hostId ?? null) === (opts.hostId ?? null),
      );
      if (existing) {
        const paneId = paneOf(current, existing.id);
        if (paneId) dispatch({ type: 'setActiveTab', paneId, tabId: existing.id });
        return;
      }
      const tab: Tab = {
        id: crypto.randomUUID(),
        kind: 'editor',
        title: fileName(filePath),
        filePath,
        ...(opts.hostId ? { hostId: opts.hostId } : {}),
      };
      const paneId = opts.paneId ?? current.activePaneId;
      if (opts.split) {
        dispatch({
          type: 'splitNewTerminal',
          paneId,
          edge: opts.split,
          tab,
          newPaneId: crypto.randomUUID(),
          splitId: crypto.randomUUID(),
        });
      } else dispatch({ type: 'addTab', paneId, tab });
    },
    [],
  );

  const openBrowserRef = useRef<
    (url?: string, opts?: { paneId?: NodeId; split?: Edge; newTab?: boolean }) => void
  >(() => undefined);
  const openBrowser = useCallback(
    (url = '', opts: { paneId?: NodeId; split?: Edge; newTab?: boolean } = {}) => {
      // A remote terminal's server nobody opened yet (plan 28 › M3): opening
      // it IS the user action that forwards it - main answers the local URL,
      // which is what the tab opens. Every opener comes through here.
      const browser = rendererExtension().browser;
      if (!browser) return;
      const forwarded = url ? browser.forward(url) : null;
      if (forwarded) {
        void forwarded.then((local) => {
          if (local) openBrowserRef.current(local, opts);
        });
        return;
      }
      const current = layoutRef.current;
      // A page from a server that already has a tab goes there (navigated),
      // instead of a second tab on the same app.
      if (url && !opts.newTab) {
        const origin = originOf(url);
        const existing = Object.values(current.tabs).find(
          (t) => t.kind === browser.tabKind && !!t.url && originOf(t.url) === origin,
        );
        if (existing) {
          const paneId = paneOf(current, existing.id);
          if (paneId) dispatch({ type: 'setActiveTab', paneId, tabId: existing.id });
          if (existing.url !== url && !browser.navigate(existing.id, url)) {
            dispatch({ type: 'setPageTab', tabId: existing.id, url });
          }
          return;
        }
      }
      const tab: Tab = {
        id: crypto.randomUUID(),
        kind: browser.tabKind,
        title: browser.tabTitle(url),
        url,
      };
      const paneId = opts.paneId ?? current.activePaneId;
      if (opts.split) {
        dispatch({
          type: 'splitNewTerminal',
          paneId,
          edge: opts.split,
          tab,
          newPaneId: crypto.randomUUID(),
          splitId: crypto.randomUUID(),
        });
      } else {
        // Right of the tab you are on, not at the end of the strip.
        const pane = current.nodes[paneId];
        const at = pane?.type === 'pane' ? pane.tabs.indexOf(pane.activeTabId) : -1;
        dispatch({ type: 'addTab', paneId, tab, index: at >= 0 ? at + 1 : undefined });
      }
    },
    [],
  );
  openBrowserRef.current = openBrowser;

  // Recently closed editor / page tabs, newest last (Reopen closed tab).
  const closedTabsRef = useRef<ClosedTab[]>([]);
  // Called with the layout as it is BEFORE the close, so the pane and the
  // tab's place in it are still known.
  const rememberClosedTab = useCallback((before: WorkspaceLayout, tab: Tab): void => {
    const paneId = paneOf(before, tab.id);
    const pane = paneId ? before.nodes[paneId] : undefined;
    if (!paneId || pane?.type !== 'pane') return;
    closedTabsRef.current = rememberClosed(closedTabsRef.current, {
      tab,
      paneId,
      index: pane.tabs.indexOf(tab.id),
    });
  }, []);

  const reopenClosedTab = useCallback((): boolean => {
    const { entry, rest } = popClosed(closedTabsRef.current);
    closedTabsRef.current = rest;
    if (!entry) return false;
    const current = layoutRef.current;
    // A file the user opened again by hand is shown, not duplicated.
    if (entry.tab.kind === 'editor') {
      const open = Object.values(current.tabs).find(
        (t) =>
          t.kind === 'editor' && t.filePath === entry.tab.filePath && t.hostId === entry.tab.hostId,
      );
      const paneId = open ? paneOf(current, open.id) : null;
      if (open && paneId) {
        dispatch({ type: 'setActiveTab', paneId, tabId: open.id });
        return true;
      }
    }
    const target = reopenTarget(current, entry, crypto.randomUUID());
    dispatch({ type: 'addTab', paneId: target.paneId, tab: target.tab, index: target.index });
    return true;
  }, []);

  const finishCloseTab = useCallback(
    (tab: Tab) => {
      // Probe the pure op first and only kill the shell + xterm once we know
      // the reducer will actually drop the tab (e.g. it wasn't already closed
      // while a confirm dialog was up) - otherwise a refused close would leave
      // a dead terminal behind a still-open tab.
      const next = removeTab(layoutRef.current, tab.id);
      if (next === layoutRef.current) return;
      rememberClosedTab(layoutRef.current, tab);
      if (tab.ptyId) {
        disposePooledTerminal(tab.ptyId);
        // The view over it, if one followed it, goes with it.
        rendererExtension().sessionView?.forget(cliViewKey(tab.ptyId));
      }
      setTabDirty(tab.id, false);
      dispatch({ type: 'closeTab', tabId: tab.id });
      // The closed shell takes its verdict with it: re-derive the session's
      // status (and so its project's) from the tabs that remain - nobody
      // observes the killed pty's exit once the layout has dropped its tab.
      if (tab.ptyId) recheckSessionStatus(sessionId, shellPtyIds(next), [tab.ptyId]);
    },
    [sessionId, setTabDirty, rememberClosedTab],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const tab = layoutRef.current.tabs[tabId];
      if (!tab) return;
      // Don't silently discard unsaved edits - confirm first. The dialog is
      // async, so the close happens on confirm; callers still see a sync call.
      if (tab.kind === 'editor' && dirtyTabsRef.current.has(tabId)) {
        void confirmDialog({
          title: 'Close without saving?',
          description: `${tab.title} has unsaved changes that will be lost.`,
          confirmLabel: 'Close without saving',
          destructive: true,
        }).then((ok) => {
          if (ok) finishCloseTab(tab);
        });
        return;
      }
      // Likewise a shell tab whose terminal is still busy - an agent mid-turn
      // or one waiting for an answer - closes only after a warning. When the
      // agent is blocked on a question, show what it's asking.
      const busy = tab.ptyId ? getTerminalBusy(tab.ptyId) : null;
      if (busy) {
        const detail = busy === 'needs-input' ? getSessionQuestion(sessionId)?.question : undefined;
        void confirmCloseBusyTab({ tab: { title: tab.title, status: busy }, detail }).then((ok) => {
          if (ok) finishCloseTab(tab);
        });
        return;
      }
      finishCloseTab(tab);
    },
    [finishCloseTab, sessionId],
  );

  /**
   * Bulk close, fire-and-forget (no unsaved-changes prompt - `closeTabs` has
   * already confirmed). The reducer applies each close against the evolving
   * layout; simulating the same chain with the pure op keeps the side effects
   * (PTY/xterm disposal) aligned with the closes the reducer will actually
   * accept (a tab can vanish mid-chain, e.g. closed while a dialog was up).
   */
  const closeTabsNow = useCallback(
    (tabIds: TabId[]) => {
      let probe = layoutRef.current;
      const closedPtyIds: string[] = [];
      for (const tabId of tabIds) {
        const tab = probe.tabs[tabId];
        if (!tab) continue;
        const next = removeTab(probe, tabId);
        if (next === probe) continue;
        rememberClosedTab(probe, tab);
        probe = next;
        if (tab.ptyId) {
          disposePooledTerminal(tab.ptyId);
          rendererExtension().sessionView?.forget(cliViewKey(tab.ptyId));
          closedPtyIds.push(tab.ptyId);
        }
        setTabDirty(tabId, false);
        dispatch({ type: 'closeTab', tabId: tab.id });
      }
      // One recheck for the batch, against what the whole chain leaves behind.
      if (closedPtyIds.length > 0)
        recheckSessionStatus(sessionId, shellPtyIds(probe), closedPtyIds);
    },
    [sessionId, setTabDirty, rememberClosedTab],
  );

  const closeTabs = useCallback(
    (tabIds: TabId[]) => {
      // One confirm for the whole batch, counting only the unsaved editors the
      // close chain would actually drop.
      let probe = layoutRef.current;
      const closing: Tab[] = [];
      for (const tabId of tabIds) {
        const tab = probe.tabs[tabId];
        if (!tab) continue;
        const next = removeTab(probe, tabId);
        if (next === probe) continue;
        probe = next;
        closing.push(tab);
      }
      const dirty = closing.filter((t) => t.kind === 'editor' && dirtyTabsRef.current.has(t.id));
      const busy = busyShellTabs(closing);
      if (dirty.length === 0 && busy.length === 0) {
        closeTabsNow(tabIds);
        return;
      }
      // Busy terminals first (ending live work outranks unsaved edits), then the
      // unsaved-editors confirm; the dialogs are async - re-resolve the chain
      // against the layout as it is NOW, not as it was when the menu item was
      // clicked.
      void (async () => {
        if (busy.length > 0 && !(await confirmCloseBusyTabs({ tabs: busy }))) return;
        if (
          dirty.length > 0 &&
          !(await confirmDialog({
            title: 'Close without saving?',
            description:
              dirty.length === 1
                ? `${dirty[0].title} has unsaved changes that will be lost.`
                : `${dirty.length} files have unsaved changes that will be lost.`,
            confirmLabel: 'Close without saving',
            destructive: true,
          }))
        ) {
          return;
        }
        closeTabsNow(tabIds);
      })();
    },
    [closeTabsNow],
  );

  const remapEditorPaths = useCallback((oldPath: string, newPath: string) => {
    for (const tab of Object.values(layoutRef.current.tabs)) {
      if (tab.kind !== 'editor' || !tab.filePath) continue;
      const next = remapPath(tab.filePath, oldPath, newPath);
      if (next !== tab.filePath) {
        dispatch({ type: 'renameEditorTab', tabId: tab.id, filePath: next, title: fileName(next) });
      }
    }
  }, []);

  const closeEditorsUnder = useCallback(
    (path: string) => {
      for (const tab of Object.values(layoutRef.current.tabs)) {
        if (tab.kind !== 'editor' || !tab.filePath) continue;
        if (isPathInside(tab.filePath, path)) {
          // The file is gone - drop the tab outright (no unsaved-changes prompt).
          setTabDirty(tab.id, false);
          dispatch({ type: 'closeTab', tabId: tab.id });
        }
      }
    },
    [setTabDirty],
  );

  const value = useMemo<WorkspaceLayoutContextValue>(
    () => ({
      layout,
      dispatch,
      addTerminal,
      addTemplateTerminal,
      splitWithNewTerminal,
      openFile,
      // Browser tabs are Pro (a private plan › M5): no opener in the core build,
      // so every surface that offers one hides it.
      openBrowser: rendererExtension().browser ? openBrowser : undefined,
      closeTab,
      closeTabs,
      reopenClosedTab,
      dirtyTabs,
      setTabDirty,
      remapEditorPaths,
      closeEditorsUnder,
    }),
    [
      layout,
      addTerminal,
      addTemplateTerminal,
      splitWithNewTerminal,
      openFile,
      openBrowser,
      closeTab,
      closeTabs,
      reopenClosedTab,
      dirtyTabs,
      setTabDirty,
      remapEditorPaths,
      closeEditorsUnder,
    ],
  );

  return (
    <WorkspaceLayoutContext.Provider value={value}>{children}</WorkspaceLayoutContext.Provider>
  );
}
