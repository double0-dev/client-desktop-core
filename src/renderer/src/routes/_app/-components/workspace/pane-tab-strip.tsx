import { showsView } from '@renderer/lib/workspace/tab-kinds';
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Columns2,
  CopyX,
  ExternalLink,
  FileCode,
  FileDiff,
  FolderOpen,
  FolderTree,
  Globe,
  MessagesSquare,
  Radio,
  Plus,
  SquareCode,
  SquareTerminal,
  SquareX,
  X,
} from 'lucide-react';
import { useRef, useState, type CSSProperties } from 'react';
import { cn } from '@renderer/lib/utils';
import { revealInExplorer } from '@renderer/lib/explorer-reveal';
import { REVEAL_IN_OS_LABEL, revealInOs } from '@renderer/lib/reveal-in-os';
import { currentHostOfPath } from '@renderer/lib/hosts/host-of-path';
import { canShowInFolder } from '@renderer/lib/session/remote-capabilities';
import { OpenInEditorMenu } from '@renderer/routes/_app/-components/workspace/open-in-editor-menu';
import { TabStatusDot } from '@renderer/routes/_app/-components/workspace/tab-status-dot';
import {
  isClosable,
  isPageTab,
  isPrimaryViewTab,
  isTearable,
  type PaneNode,
  type Tab,
  type TabId,
} from '@renderer/lib/workspace/layout';
import { useSessionTemplates } from '@renderer/lib/session/templates';
import { agentIconFor } from '@renderer/lib/session/agent-icon';
import { followsAgentCli } from '@renderer/lib/session/cli-view';
import { rendererExtension } from '@renderer/lib/extension/registry';
import { liveBandClass } from '@renderer/lib/session/live-band';
import { useTerminalBusyMap } from '@renderer/lib/terminal/busy';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { addressParts } from '@renderer/lib/url';
import type { SessionServer } from '@renderer/lib/extension/types';
import { isMac } from '@renderer/lib/settings/keyboard-shortcuts';

/**
 * A live tab drag, as this strip sees it: the dragged tab collapses out of its
 * slot (the floating chip carries it), and while the cursor is over THIS strip
 * the tabs at/after the insertion index slide aside to open a gap - the same
 * look as the app's dnd-kit sortable lists. The drop itself stays with the
 * drag engine (use-tab-drag), which hit-tests against gesture-start geometry,
 * so the sliding never feeds back into the index.
 */
export type StripDragState = {
  /** The tab being dragged (possibly from another pane's strip). */
  tabId: TabId;
  /** The dragged tab's pre-drag width - the size of the gap to open. */
  width: number;
  /** Insertion index in THIS strip (counting the dragged tab), or null while
   * the cursor is elsewhere (another strip, a pane body, past the window). */
  index: number | null;
};

/**
 * The tab strip for a single pane. Each pane owns its own strip (unlike the
 * original single global strip), so tabs can be split across panes. Tab
 * selection happens on pointer-down so it composes with drag-to-move.
 */
export function PaneTabStrip({
  pane,
  tabs,
  isActivePane,
  dirtyTabs,
  cwd,
  isWorktree,
  onSelectTab,
  onCloseTab,
  onCloseTabs,
  onOpenInWindow,
  onToggleView,
  onAddTerminal,
  onAddTemplateTerminal,
  onSplit,
  onTabPointerDown,
  changesDrawerOpen = false,
  onToggleChangesDrawer,
  onOpenBrowser,
  servers = [],
  drag = null,
}: {
  pane: PaneNode;
  tabs: Record<TabId, Tab>;
  isActivePane: boolean;
  /** Editor tab ids with unsaved changes - shown as a dot in place of the close X. */
  dirtyTabs: ReadonlySet<TabId>;
  /** This session's folder (worktree or project dir) - the "Open in IDE" target. */
  cwd: string | null;
  /** Whether `cwd` is a git worktree - only affects the launcher's wording. */
  isWorktree: boolean;
  onSelectTab: (tabId: TabId) => void;
  onCloseTab: (tabId: TabId) => void;
  /** Bulk close for the context menu's other/all/left/right actions. */
  onCloseTabs: (tabIds: TabId[]) => void;
  /** Tear the tab off into its own window (context menu; terminals only). */
  onOpenInWindow: (tabId: TabId) => void;
  /** Show an agent CLI's tab in the extension's view, or back as the terminal (context menu). */
  onToggleView?: (tabId: TabId) => void;
  onAddTerminal: () => void;
  /** Long-press the "+": open a terminal from a chosen template (name + command). */
  onAddTemplateTerminal: (title: string, command: string) => void;
  onSplit: () => void;
  /** Drag initiator, wired by the drag engine. */
  onTabPointerDown?: (e: React.PointerEvent, tabId: TabId) => void;
  /** Whether this session's changes drawer is open (the button's pressed state). */
  changesDrawerOpen?: boolean;
  /** Toggle the session-changes drawer; absent (lone-terminal windows) = no button. */
  onToggleChangesDrawer?: () => void;
  /** The live tab drag (null/absent outside one) - drives the slide-apart gap. */
  drag?: StripDragState | null;
  /**
   * Open a browser tab in this pane ('' = the new-tab page). Absent in
   * torn-off terminal windows, which hold terminals only - no globe, and the
   * hold-+ menu stays terminal-only there.
   */
  /** `split`: in a new pane to the right (the globe), else a tab here. */
  onOpenBrowser?: (url?: string, opts?: { split?: boolean }) => void;
  /** The session's dev servers - one row each in the hold-+ menu. */
  servers?: readonly SessionServer[];
}) {
  // An extension's view over a tab's agent (its icon, its menu label); a
  // primary view this build cannot draw keeps the same icon.
  const viewSlot = rendererExtension().sessionView;
  const ViewIcon = viewSlot?.Icon ?? MessagesSquare;
  // Long-press the "+" opens a template menu; a short click adds the default
  // terminal. The DropdownMenu is controlled and anchored to an invisible
  // overlay so the button's own click/long-press handling stays intact.
  const templates = useSessionTemplates();
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  // Which terminals are mid-work / blocked on the user - each such tab is
  // washed with its status colour (live-band.ts) and carries its dot.
  const busyPtys = useTerminalBusyMap();
  const longPressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const clearLongPress = (): void => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Per-tab drag styling: the dragged tab collapses closed (it rides the
  // floating chip), and tabs at/after the insertion index shift right by the
  // dragged tab's width to open the gap. Everything transitions, so the gap
  // slides open/closed as the cursor moves.
  const dragStyle = (tabId: TabId, i: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    if (tabId === drag.tabId) {
      return {
        maxWidth: 0,
        paddingLeft: 0,
        paddingRight: 0,
        borderRightWidth: 0,
        opacity: 0,
        overflow: 'hidden',
        transition: 'all 150ms ease',
      };
    }
    return {
      transform:
        drag.index != null && i >= drag.index ? `translateX(${drag.width}px)` : 'translateX(0)',
      transition: 'transform 150ms ease',
    };
  };

  return (
    <div
      data-strip-pane={pane.id}
      role="tablist"
      className={cn(
        'pointer-events-auto flex min-h-9 shrink-0 items-start border-b bg-muted',
        isActivePane ? 'border-border-strong' : 'border-border',
      )}
    >
      {/* Tabs + the "+" wrap to additional rows when they don't fit the pane
          width; the split control stays pinned to the top-right. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-stretch">
        {pane.tabs.map((tabId, i) => {
          const tab = tabs[tabId];
          if (!tab) return null;
          const isActive = pane.activeTabId === tabId;
          const isEditor = tab.kind === 'editor';
          const isDirty = isEditor && dirtyTabs.has(tabId);
          // A tab shows its agent's glyph when it's an agent terminal (Claude
          // Code, OpenCode - the primary tab or one opened with "+"), else the
          // plain terminal icon - keyed off the agent-derived title so the icon
          // matches the label.
          const AgentIcon = isEditor ? undefined : agentIconFor(tab.title);
          // The extension's view follows the tab's own agent CLI (a Claude tab,
          // or one whose command starts it).
          const viewable = !!onToggleView && followsAgentCli(tab);
          const band = tab.ptyId ? busyPtys.get(tab.ptyId) : undefined;
          // Context-menu targets. Directional/other items only appear when at
          // least one tab lies that way.
          const leftIds = pane.tabs.slice(0, i);
          const rightIds = pane.tabs.slice(i + 1);
          const otherIds = pane.tabs.filter((id) => id !== tabId);
          const showCloseOthers = otherIds.length > 0;
          const showCloseLeft = leftIds.length > 0;
          const showCloseRight = rightIds.length > 0;
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
                  data-tab-id={tabId}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={0}
                  style={dragStyle(tabId, i)}
                  className={cn(
                    // `before:` is the focus bar (design: WorkspaceTab `focus-bar`): a
                    // line along the tab's top edge, primary on the active tab of the
                    // focused pane, border-strong on the active tab of any other pane -
                    // so "which tab is showing" and "where the keyboard goes" both read
                    // at a glance. Absolute, so no tab's content shifts. 2px, raised to
                    // 4px (`--focus-bar-height`) while the pane's focus frame is lit
                    // (globals.css): the frame's 2px top edge would hide a 2px bar.
                    'relative flex h-9 shrink-0 cursor-pointer touch-none select-none items-center gap-2 border-r border-border px-3.5 text-xs outline-none before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:content-[""] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
                    isActive
                      ? cn(
                          'bg-background font-semibold text-foreground',
                          isActivePane
                            ? 'before:h-[var(--focus-bar-height,2px)] before:bg-primary'
                            : 'before:bg-border-strong',
                        )
                      : 'font-medium text-foreground-muted before:bg-transparent hover:text-foreground',
                    liveBandClass(band),
                  )}
                  onPointerDown={(e) => {
                    // Left button only - a right-click opens the context menu and
                    // must not activate the tab or arm a drag.
                    if (e.button !== 0) return;
                    onSelectTab(tabId);
                    onTabPointerDown?.(e, tabId);
                  }}
                  onKeyDown={(e) => {
                    // Only when the tab itself holds focus - let the close button keep
                    // its own Enter/Space.
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectTab(tabId);
                    }
                  }}
                >
                  {isEditor ? (
                    <FileCode className="size-3.5 text-[#60a5fa]" />
                  ) : isPageTab(tab) ? (
                    <Globe className="size-3.5" />
                  ) : isPrimaryViewTab(tab) || showsView(tab) ? (
                    <ViewIcon
                      className={cn('size-3.5', isActive ? 'text-primary' : 'text-primary/80')}
                    />
                  ) : AgentIcon ? (
                    <AgentIcon
                      className={cn('size-3.5', isActive ? 'text-primary' : 'text-primary/80')}
                    />
                  ) : (
                    <SquareTerminal className="size-3.5" />
                  )}
                  <span className={cn('max-w-[180px] truncate', isEditor && 'font-normal')}>
                    {tab.title}
                  </span>
                  <TabStatusDot state={band} />
                  {isClosable(tab) && (
                    <button
                      type="button"
                      aria-label={isDirty ? `Close ${tab.title} (unsaved)` : `Close ${tab.title}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTab(tabId);
                      }}
                      className="group/close flex size-4 items-center justify-center rounded text-foreground-subtle transition-colors hover:bg-muted hover:text-foreground"
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
                  <ContextMenuItem onSelect={() => onCloseTab(tabId)}>
                    <X />
                    Close
                  </ContextMenuItem>
                )}
                {showCloseOthers && (
                  <ContextMenuItem onSelect={() => onCloseTabs(otherIds)}>
                    <CopyX />
                    Close other tabs
                  </ContextMenuItem>
                )}
                <ContextMenuItem onSelect={() => onCloseTabs([...otherIds, tabId])}>
                  <SquareX />
                  Close all tabs
                </ContextMenuItem>
                {(showCloseLeft || showCloseRight) && <ContextMenuSeparator />}
                {showCloseLeft && (
                  <ContextMenuItem onSelect={() => onCloseTabs(leftIds)}>
                    <ArrowLeftToLine />
                    Close tabs to the left
                  </ContextMenuItem>
                )}
                {showCloseRight && (
                  <ContextMenuItem onSelect={() => onCloseTabs(rightIds)}>
                    <ArrowRightToLine />
                    Close tabs to the right
                  </ContextMenuItem>
                )}
                {viewable && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => onToggleView!(tabId)}>
                      {showsView(tab) ? <SquareTerminal /> : <ViewIcon />}
                      {showsView(tab) ? 'Show as terminal' : viewSlot?.labels.show}
                    </ContextMenuItem>
                  </>
                )}
                {(revealTarget || osRevealTarget || isTearable(tab)) && <ContextMenuSeparator />}
                {revealTarget && (
                  <ContextMenuItem
                    onSelect={() => {
                      // Select the tab so the explorer highlights the revealed row.
                      onSelectTab(tabId);
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
                  <ContextMenuItem onSelect={() => onOpenInWindow(tabId)}>
                    <ExternalLink />
                    Open in separate window
                  </ContextMenuItem>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
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
              onAddTerminal();
            }}
            className={cn(
              'flex size-9 items-center justify-center text-foreground-muted transition-colors hover:text-foreground',
              newTabMenuOpen && 'text-foreground',
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
            <DropdownMenuContent align="start" sideOffset={2} className="min-w-[180px]">
              <DropdownMenuLabel className="text-foreground-subtle">
                {onOpenBrowser ? 'New tab' : 'New terminal from…'}
              </DropdownMenuLabel>
              {templates.map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  onSelect={() => onAddTemplateTerminal(t.name, t.startCommand)}
                >
                  {t.name}
                </DropdownMenuItem>
              ))}
              {onOpenBrowser && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onOpenBrowser('')}>
                    <Globe className="size-3.5 text-foreground-muted" />
                    <span className="flex-1">Browser tab</span>
                    <span className="font-mono text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
                      {isMac ? '⌘⇧B' : 'Ctrl+Shift+B'}
                    </span>
                  </DropdownMenuItem>
                  {servers.map((s) => (
                    <DropdownMenuItem key={s.url} onSelect={() => onOpenBrowser(s.url)}>
                      <Radio className="size-3.5 text-foreground-muted" />
                      <span className="flex-1 font-mono text-[length:calc(12px*var(--ui-font-scale,1))]">
                        {addressParts(s.url).origin}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1 px-1.5">
        <button
          type="button"
          aria-label="Split right"
          onClick={onSplit}
          className="flex size-[26px] items-center justify-center rounded-sm text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
        >
          <Columns2 className="size-3.5" />
        </button>
        {onOpenBrowser && (
          <button
            type="button"
            aria-label="Open browser to the right"
            title="Open browser to the right"
            onClick={() =>
              onOpenBrowser(servers.length === 1 ? servers[0].url : '', { split: true })
            }
            className="flex size-[26px] items-center justify-center rounded-sm text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
          >
            <Globe className="size-3.5" />
          </button>
        )}
        {/* Open this session's folder (worktree or project dir) in an installed
            IDE. Renders nothing when there's no folder or no editor is found. */}
        <OpenInEditorMenu
          cwd={cwd}
          isWorktree={isWorktree}
          trigger={
            <button
              type="button"
              aria-label="Open in IDE"
              title="Open this session’s folder in an IDE"
              className="flex size-[26px] items-center justify-center rounded-sm text-foreground-muted transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-primary"
            >
              <SquareCode className="size-3.5" />
            </button>
          }
        />
        {onToggleChangesDrawer && (
          <button
            type="button"
            aria-label="Session changes"
            aria-pressed={changesDrawerOpen}
            title="Changes in this session"
            onClick={onToggleChangesDrawer}
            className={cn(
              'flex size-[26px] items-center justify-center rounded-sm transition-colors',
              changesDrawerOpen
                ? 'bg-accent text-primary'
                : 'text-foreground-muted hover:bg-muted hover:text-foreground',
            )}
          >
            <FileDiff className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
