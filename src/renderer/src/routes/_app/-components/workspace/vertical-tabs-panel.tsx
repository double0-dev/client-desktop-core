import { Fragment, useContext, useRef, useState, type ReactNode } from 'react';
import {
  CopyX,
  ExternalLink,
  FileCode,
  FolderOpen,
  FolderTree,
  MessagesSquare,
  Plus,
  Rows3,
  SquareTerminal,
  SquareX,
  X,
  Globe,
} from 'lucide-react';
import { revealInExplorer } from '@renderer/lib/explorer-reveal';
import { REVEAL_IN_OS_LABEL, revealInOs } from '@renderer/lib/reveal-in-os';
import { currentHostOfPath } from '@renderer/lib/hosts/host-of-path';
import { canShowInFolder } from '@renderer/lib/session/remote-capabilities';
import { WorkspaceLayoutContext } from '@renderer/lib/workspace/layout-context';
import {
  isClosable,
  isPageTab,
  isPrimaryViewTab,
  isTearable,
  type PaneNode,
  type Tab,
  type WorkspaceLayout,
} from '@renderer/lib/workspace/layout';
import { useSessionTemplates } from '@renderer/lib/session/templates';
import { agentIconFor } from '@renderer/lib/session/agent-icon';
import { liveBandClass } from '@renderer/lib/session/live-band';
import { useTerminalBusyMap } from '@renderer/lib/terminal/busy';
import { TabStatusDot } from '@renderer/routes/_app/-components/workspace/tab-status-dot';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { cn } from '@renderer/lib/utils';
import { rendererExtension } from '@renderer/lib/extension/registry';
import { holdSurfaceFocus, stepFocusItem } from '@renderer/lib/workspace/focus-regions';

/**
 * Leaf panes in tree order (splits walked depth-first, children in order), so
 * the list mirrors the visual left-to-right / top-to-bottom arrangement -
 * unlike `leafPanes`, whose record order is insertion order.
 */
function panesInTreeOrder(layout: WorkspaceLayout): PaneNode[] {
  const out: PaneNode[] = [];
  const walk = (nodeId: string): void => {
    const node = layout.nodes[nodeId];
    if (!node) return;
    if (node.type === 'pane') out.push(node);
    else node.children.forEach(walk);
  };
  walk(layout.rootId);
  return out;
}

/** Same shell as the other dock panels' PanelHead (chrome-local, not imported
 * to avoid a chrome ↔ panel import cycle). */
function TabsPanelHead({ children }: { children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-surface pb-2 pl-3 pr-2.5 pt-2.5">
      <span className="font-mono text-[length:calc(10px*var(--ui-font-scale,1))] font-semibold tracking-[1px] text-foreground-subtle region-kbd-focus:text-primary">
        TABS
      </span>
      {children}
    </div>
  );
}

/**
 * The "Tabs" dock panel (vertical-tabs setting): every open tab of the current
 * session in one vertical list, replacing the per-pane horizontal tab strips
 * (hidden in WorkspaceSurface while the setting is on). Split panes keep their
 * own groups, in tree order, separated by a hairline. Reads the layout context
 * directly - the released/session-less chrome renders the dock outside any
 * provider, where the panel shows an empty state instead.
 */
export function VerticalTabsPanel({ cwd }: { cwd: string | null }) {
  const ctx = useContext(WorkspaceLayoutContext);
  // Long-press the "+" opens a template menu; a short click adds the default
  // terminal. Same controlled-DropdownMenu-over-invisible-anchor pattern as the
  // horizontal strip's "+" (see PaneTabStrip).
  const templates = useSessionTemplates();
  // Which terminals are mid-work / blocked on the user - each such row is
  // washed with its status colour (live-band.ts) and carries its dot.
  const busyPtys = useTerminalBusyMap();
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const longPressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const clearLongPress = (): void => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  if (!ctx) {
    return (
      <>
        <TabsPanelHead />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <Rows3 className="size-5 text-foreground-subtle" />
          <p className="text-[length:calc(11px*var(--ui-font-scale,1))] leading-snug text-foreground-muted">
            Open a session to see its tabs.
          </p>
        </div>
      </>
    );
  }

  const { layout, dispatch, addTerminal, addTemplateTerminal, closeTab, closeTabs, dirtyTabs } =
    ctx;
  const panes = panesInTreeOrder(layout);
  const allIds = panes.flatMap((p) => p.tabs);

  // Same transfer as the tab strip's "Open in separate window" (see
  // WorkspaceBody.openTabInNewWindow): origin-side removal rides the normal
  // `tab:removed` reply handled by the mounted body's controller.
  const openInWindow = (tab: Tab): void => {
    if (!tab.ptyId || !isTearable(tab)) return;
    window.api?.tab?.dropExternal(
      { kind: 'terminal', termId: tab.ptyId, title: tab.title, cwd },
      { newWindow: true },
    );
  };

  const selectTab = (paneId: string, tabId: string): void => {
    dispatch({ type: 'setActivePane', paneId });
    dispatch({ type: 'setActiveTab', paneId, tabId });
  };

  // ↑/↓ on a row picks the previous/next tab (across split groups) while the
  // caret stays on the row, so the list can be walked further - the surface
  // stands down from focusing the newly shown terminal/editor for a moment
  // (see focus-regions). Enter/Space on a row select it the click way, which
  // does hand focus to the tab's content.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const target = e.target as HTMLElement;
    if (target.closest('[role="menu"]')) return;
    const next = stepFocusItem(e.currentTarget, target, e.key === 'ArrowDown' ? 1 : -1);
    if (!next) return;
    e.preventDefault();
    holdSurfaceFocus();
    next.focus();
    const { focusKey, paneId } = next.dataset;
    if (focusKey && paneId) selectTab(paneId, focusKey);
  };

  const renderRow = (pane: PaneNode, tabId: string): ReactNode => {
    const tab = layout.tabs[tabId];
    if (!tab) return null;
    const activeInPane = pane.activeTabId === tabId;
    // The pane-active tab of the focused pane is THE active tab; pane-active
    // tabs of other panes keep a quieter tint (they're on screen too).
    const focused = activeInPane && layout.activePaneId === pane.id;
    const isEditor = tab.kind === 'editor';
    const AgentIcon = isEditor ? undefined : agentIconFor(tab.title);
    const isDirty = isEditor && dirtyTabs.has(tabId);
    const band = tab.ptyId ? busyPtys.get(tab.ptyId) : undefined;
    const otherIds = allIds.filter((id) => id !== tabId);
    const showCloseOthers = otherIds.length > 0;
    // "Show in file explorer" needs a file to reveal and a project root to
    // reveal it under.
    const revealTarget = isEditor && cwd ? tab.filePath : undefined;
    // The OS file manager needs only the file.
    // Nothing on this machine to reveal for a file on a remote host.
    const osRevealTarget =
      isEditor && canShowInFolder(currentHostOfPath(tab.filePath)) ? tab.filePath : undefined;
    return (
      <ContextMenu key={tabId}>
        <ContextMenuTrigger asChild>
          <div
            role="tab"
            aria-selected={focused}
            tabIndex={0}
            data-focus-item
            data-focus-key={tabId}
            data-pane-id={pane.id}
            data-focus-current={focused || undefined}
            onClick={() => selectTab(pane.id, tabId)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectTab(pane.id, tabId);
              }
            }}
            className={cn(
              'group flex h-7 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-xs outline-none transition-colors kbd-focus:ring-1 kbd-focus:ring-inset kbd-focus:ring-primary',
              focused
                ? 'bg-accent font-semibold text-foreground'
                : activeInPane
                  ? 'bg-muted/50 font-medium text-foreground'
                  : 'font-medium text-foreground-muted hover:bg-muted/50 hover:text-foreground',
              liveBandClass(band),
            )}
          >
            {isEditor ? (
              <FileCode className="size-3.5 shrink-0 text-[#60a5fa]" />
            ) : isPageTab(tab) ? (
              <Globe className="size-3.5 shrink-0" />
            ) : isPrimaryViewTab(tab) ? (
              <PrimaryViewIcon
                className={cn('size-3.5 shrink-0', focused ? 'text-primary' : 'text-primary/80')}
              />
            ) : AgentIcon ? (
              <AgentIcon
                className={cn('size-3.5 shrink-0', focused ? 'text-primary' : 'text-primary/80')}
              />
            ) : (
              <SquareTerminal className="size-3.5 shrink-0" />
            )}
            <span className={cn('min-w-0 flex-1 truncate', isEditor && 'font-normal')}>
              {tab.title}
            </span>
            <TabStatusDot state={band} />
            {isClosable(tab) && (
              <button
                type="button"
                aria-label={isDirty ? `Close ${tab.title} (unsaved)` : `Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tabId);
                }}
                className={cn(
                  'group/close flex size-4 shrink-0 items-center justify-center rounded text-foreground-subtle transition-colors hover:bg-muted hover:text-foreground',
                  // The dirty dot always shows; a plain X only on hover/focus.
                  !isDirty &&
                    !focused &&
                    'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                )}
              >
                {isDirty ? (
                  <>
                    {/* Unsaved: a dot that becomes the close X on hover. */}
                    <span className="size-2 rounded-full bg-primary group-hover/close:hidden" />
                    <X className="hidden size-3 group-hover/close:block" />
                  </>
                ) : (
                  <X className="size-3" />
                )}
              </button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isClosable(tab) && (
            <ContextMenuItem onSelect={() => closeTab(tabId)}>
              <X />
              Close
            </ContextMenuItem>
          )}
          {showCloseOthers && (
            <ContextMenuItem onSelect={() => closeTabs(otherIds)}>
              <CopyX />
              Close other tabs
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => closeTabs([...otherIds, tabId])}>
            <SquareX />
            Close all tabs
          </ContextMenuItem>
          {(revealTarget || osRevealTarget || isTearable(tab)) && <ContextMenuSeparator />}
          {revealTarget && (
            <ContextMenuItem
              onSelect={() => {
                // Select the tab so the explorer highlights the revealed row.
                selectTab(pane.id, tabId);
                revealInExplorer(cwd!, revealTarget);
              }}
            >
              <FolderTree />
              Show in file explorer
            </ContextMenuItem>
          )}
          {osRevealTarget && (
            <ContextMenuItem onSelect={() => void revealInOs(osRevealTarget)}>
              <FolderOpen />
              {REVEAL_IN_OS_LABEL}
            </ContextMenuItem>
          )}
          {isTearable(tab) && (
            <ContextMenuItem onSelect={() => openInWindow(tab)}>
              <ExternalLink />
              Open in separate window
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div data-focus-region="tabs" className="group/region flex min-h-0 flex-1 flex-col focus-frame">
      <TabsPanelHead>
        <div className="relative flex shrink-0">
          <button
            type="button"
            aria-label="New terminal"
            aria-haspopup="menu"
            title="Click for a new terminal · hold for a template"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              longPressed.current = false;
              clearLongPress();
              longPressTimer.current = window.setTimeout(() => {
                longPressed.current = true;
                setNewTabMenuOpen(true);
              }, 400);
            }}
            onPointerUp={clearLongPress}
            onPointerLeave={clearLongPress}
            onClick={() => {
              // A click that ended a long-press opened the menu instead of adding.
              if (longPressed.current) {
                longPressed.current = false;
                return;
              }
              addTerminal();
            }}
            className={cn(
              'flex size-5 items-center justify-center rounded text-foreground-muted transition-colors hover:bg-muted hover:text-foreground',
              newTabMenuOpen && 'bg-muted text-foreground',
            )}
          >
            <Plus className="size-3.5" />
          </button>
          <DropdownMenu open={newTabMenuOpen} onOpenChange={setNewTabMenuOpen}>
            {/* Invisible anchor over the button: positions the menu without
                intercepting the button's own clicks (pointer-events-none). */}
            <DropdownMenuTrigger asChild>
              <span aria-hidden className="pointer-events-none absolute inset-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={2} className="min-w-[180px]">
              <DropdownMenuLabel className="text-foreground-subtle">
                New terminal from…
              </DropdownMenuLabel>
              {templates.map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  onSelect={() => addTemplateTerminal(t.name, t.startCommand)}
                >
                  {t.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TabsPanelHead>
      <div
        role="tablist"
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2"
      >
        {panes.map((pane, i) => (
          <Fragment key={pane.id}>
            {/* A hairline between split panes' groups (only when actually split). */}
            {i > 0 && <div className="mx-1 my-1 h-px shrink-0 bg-border" />}
            {pane.tabs.map((tabId) => renderRow(pane, tabId))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** A session's primary view tab: the extension's icon, or the same glyph for a placeholder. */
function PrimaryViewIcon({ className }: { className?: string }) {
  const Icon = rendererExtension().sessionView?.Icon ?? MessagesSquare;
  return <Icon className={className} />;
}
