/**
 * Pure, React-free model for the workspace's split layout.
 *
 * A workspace is a binary-ish tree: leaf `pane` nodes hold an ordered list of
 * tab ids (one active), and inner `split` nodes arrange their children in a row
 * (side-by-side, vertical divider) or column (stacked, horizontal divider) with
 * percentage sizes. Tabs are normalised into a flat record so a tab's identity -
 * and crucially its stable `ptyId` - is decoupled from where it currently sits.
 * Moving/splitting only rewrites the tree; a tab object is never recreated, so
 * the terminal layer can keep every shell mounted across any restructuring.
 *
 * Nodes are referenced by id (not nested) so lookups are O(1), updates are a
 * shallow map copy, and a pane keeps a stable id across restructures - which is
 * what lets `react-resizable-panels` panel ids and the rect registry stay put.
 *
 * Every exported op is pure: `(layout, …) => WorkspaceLayout`. PTY side effects
 * (spawn on add, kill on close) are the caller's job, not the model's.
 */

import { isPageTabKind, rendersTabKind } from '@renderer/lib/workspace/tab-kinds';

export type TabId = string;
export type NodeId = string;
export type SplitDirection = 'row' | 'column';
/** Which side of a pane a dropped tab lands on when splitting. */
export type Edge = 'left' | 'right' | 'top' | 'bottom';
/**
 * The kinds core draws, plus whatever an extension adds: a page tab
 * (`BrowserSlot.tabKind` - no PTY, identified by its `url`, `isPageTab`), and
 * the primary tab of a session whose runtime has no shell is of its view's
 * kind (`SessionViewSlot.view`, `isPrimaryViewTab`) - no PTY either, so every
 * terminal path, which keys off `ptyId`, skips it.
 */
// `string & {}` keeps the literal kinds' autocomplete while accepting any kind.
export type TabKind = 'conversation' | 'terminal' | 'editor' | (string & {});

export type Tab = {
  id: TabId;
  kind: TabKind;
  title: string;
  /**
   * Stable PTY id owned by terminal/conversation tabs; handed to the main process
   * verbatim. Absent for `editor` tabs, which display a file instead of a shell.
   */
  ptyId?: string;
  /**
   * Command this tab's shell auto-runs on first spawn (e.g. `claude`). Set from
   * the session's template, so a Claude Code session's primary tab AND any new
   * terminals it opens launch the agent; plain Terminal sessions leave it unset.
   */
  startupCommand?: string;
  /** Absolute path of the file shown by an `editor` tab; absent otherwise. */
  filePath?: string;
  /**
   * `editor`: the remote host of a file outside every project root of that
   * host (a language server's jump into its `site-packages`, plan 29 › M9) -
   * the path alone would name this machine's file. Opened read-only.
   * Absent for every other file (its host follows from its path).
   */
  hostId?: string;
  /**
   * A page tab: the page it shows - the last committed URL, so a relaunch
   * reopens it; '' is the new-tab page. Only a page tab carries it.
   */
  url?: string;
  /**
   * A terminal / conversation tab shown in an extension's view over its own
   * agent CLI (`SessionViewSlot.view`) - the shell keeps running underneath;
   * absent = the terminal.
   */
  view?: string;
};

export type PaneNode = {
  type: 'pane';
  id: NodeId;
  tabs: TabId[];
  activeTabId: TabId;
};

export type SplitNode = {
  type: 'split';
  id: NodeId;
  direction: SplitDirection;
  children: NodeId[];
  /** Percentages aligned to `children`, summing to ~100. */
  sizes: number[];
};

export type LayoutNode = PaneNode | SplitNode;

export type WorkspaceLayout = {
  rootId: NodeId;
  nodes: Record<NodeId, LayoutNode>;
  tabs: Record<TabId, Tab>;
  /** Pane that currently holds keyboard focus / receives new tabs. */
  activePaneId: NodeId;
};

export const CONVERSATION_TAB_ID = 'conversation';

/**
 * The conversation tab's PTY id is derived from the session id so it is (a)
 * stable across React StrictMode's double mount in dev - both init runs produce
 * the same id, so main's idempotent `create` spawns exactly one shell - and (b)
 * unique per session, so two open sessions never collide on one shell.
 */
export function conversationPtyId(sessionId: string): string {
  return `conversation:${sessionId}`;
}

/**
 * Whether a tab can be torn off into another window. Only live shells transfer
 * across windows (the receiver adopts the PTY by id), so terminal tabs are
 * tearable while the primary conversation tab and editor tabs (no shell) are not -
 * they can still be reordered/split/moved within their window.
 */
export function isTearable(tab: Tab): boolean {
  return tab.kind === 'terminal';
}

/**
 * The primary tab of a session whose runtime has no shell: the conversation
 * slot holds a view, not a terminal. It IS the session - never closed.
 */
export function isPrimaryViewTab(tab: Tab): boolean {
  return tab.id === CONVERSATION_TAB_ID && tab.kind !== 'conversation' && !tab.ptyId;
}

/** Whether a tab can be closed: everything but a session's primary view. */
export function isClosable(tab: Tab): boolean {
  return !isPrimaryViewTab(tab);
}

/**
 * Title for a new shell tab: the bare `base` when no open shell tab holds it,
 * else "`base` n" with the smallest free n ≥ 2 - so closing "Terminal 2" frees
 * its number for the next terminal instead of a counter growing forever, and a
 * freed middle number is reused without colliding with the ones still open.
 */
export function nextShellTitle(tabs: Record<TabId, Tab>, base: string): string {
  const taken = new Set<number>();
  let baseTaken = false;
  for (const t of Object.values(tabs)) {
    if (t.kind === 'editor' || isPageTab(t)) continue;
    if (t.title === base) baseTaken = true;
    else if (t.title.startsWith(`${base} `)) {
      const n = Number(t.title.slice(base.length + 1));
      if (Number.isInteger(n)) taken.add(n);
    }
  }
  if (!baseTaken) return base;
  let n = 2;
  while (taken.has(n)) n++;
  return `${base} ${n}`;
}

/**
 * Reconcile the conversation (primary) tab with the session's live agent label
 * and start command after a session edit. Both were frozen into the layout at
 * creation - and the frozen command wins over the live one when "+" terminals
 * inherit it, and re-runs on a restart respawn. Returns the same state when
 * nothing changed, so callers can dispatch unconditionally.
 */
export function syncConversationTab(
  state: WorkspaceLayout,
  title: string,
  startupCommand: string | undefined,
): WorkspaceLayout {
  let changed = false;
  const tabs = { ...state.tabs };
  // "+" terminals that run the agent took the primary tab's title ("Custom 2"):
  // a relabel renames them with it, number kept. Plain shells ("Terminal 2")
  // have no command and keep theirs.
  const previous = state.tabs[CONVERSATION_TAB_ID];
  const oldTitle = previous && previous.kind === 'conversation' ? previous.title : undefined;
  if (oldTitle !== undefined && oldTitle !== title) {
    for (const [id, tab] of Object.entries(state.tabs)) {
      if (tab.kind !== 'terminal' || !tab.startupCommand) continue;
      const suffix =
        tab.title === oldTitle
          ? ''
          : tab.title.startsWith(`${oldTitle} `) &&
              Number.isInteger(Number(tab.title.slice(oldTitle.length + 1)))
            ? tab.title.slice(oldTitle.length)
            : null;
      if (suffix === null) continue;
      tabs[id] = { ...tab, title: `${title}${suffix}` };
      changed = true;
    }
  }
  for (const [id, tab] of Object.entries(state.tabs)) {
    // A primary view follows the label only - it runs no command.
    if (isPrimaryViewTab(tab)) {
      if (tab.title === title) continue;
      tabs[id] = { ...tab, title };
      changed = true;
      continue;
    }
    if (tab.kind !== 'conversation') continue;
    if (tab.title === title && tab.startupCommand === startupCommand) continue;
    tabs[id] = { ...tab, title, startupCommand };
    changed = true;
  }
  return changed ? { ...state, tabs } : state;
}

export function initialLayout(
  sessionId: string,
  primaryTitle = 'Terminal',
  startupCommand?: string,
  opts: { view?: string } = {},
): WorkspaceLayout {
  const conversation: Tab = opts.view
    ? // A runtime session's primary tab is its view: no shell, no command.
      { id: CONVERSATION_TAB_ID, kind: opts.view, title: primaryTitle }
    : {
        id: CONVERSATION_TAB_ID,
        kind: 'conversation',
        // The primary tab is labelled by the session's agent (e.g. "Claude
        // Code" or "Terminal"); the tab strip picks its icon to match.
        title: primaryTitle,
        ptyId: conversationPtyId(sessionId),
        startupCommand,
      };
  const root: PaneNode = {
    // Session-scoped (not a bare 'root') so panel ids never collide across the
    // multiple sessions WorkspaceHost keeps mounted at once. Deterministic, so
    // StrictMode's double init produces the same id.
    type: 'pane',
    id: `root:${sessionId}`,
    tabs: [CONVERSATION_TAB_ID],
    activeTabId: CONVERSATION_TAB_ID,
  };
  return {
    rootId: root.id,
    nodes: { [root.id]: root },
    tabs: { [conversation.id]: conversation },
    activePaneId: root.id,
  };
}

/** Initial layout for a detached terminal window: one pane holding `tab`. */
export function initialDetachedLayout(tab: Tab): WorkspaceLayout {
  const root: PaneNode = { type: 'pane', id: 'root', tabs: [tab.id], activeTabId: tab.id };
  return {
    rootId: root.id,
    nodes: { [root.id]: root },
    tabs: { [tab.id]: tab },
    activePaneId: root.id,
  };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function getTab(layout: WorkspaceLayout, tabId: TabId): Tab | undefined {
  return layout.tabs[tabId];
}

export function getPane(layout: WorkspaceLayout, id: NodeId): PaneNode | null {
  const node = layout.nodes[id];
  return node && node.type === 'pane' ? node : null;
}

/** Id of the pane currently holding `tabId`, or null. */
export function paneOf(layout: WorkspaceLayout, tabId: TabId): NodeId | null {
  for (const id in layout.nodes) {
    const node = layout.nodes[id];
    if (node.type === 'pane' && node.tabs.includes(tabId)) return id;
  }
  return null;
}

export function leafPanes(layout: WorkspaceLayout): PaneNode[] {
  const out: PaneNode[] = [];
  for (const id in layout.nodes) {
    const node = layout.nodes[id];
    if (node.type === 'pane') out.push(node);
  }
  return out;
}

/**
 * The shell PTYs the user can currently see: each leaf pane's active tab (in a
 * split, every pane shows one tab at once). Editor tabs have no pty and drop
 * out. Used to clear a tab's finished-unseen mark the moment it is on screen
 * (terminal/busy's `markTerminalSeen`, driven from WorkspaceBody).
 */
export function visibleShellPtyIds(layout: WorkspaceLayout): string[] {
  const ids: string[] = [];
  for (const pane of leafPanes(layout)) {
    const tab = layout.tabs[pane.activeTabId];
    if (tab && tab.kind !== 'editor' && tab.ptyId) ids.push(tab.ptyId);
  }
  return ids;
}

/**
 * Every shell tab's pty id, hidden siblings included, in tab order - the
 * terminals a session's status is derived from (session/status.ts). Editor
 * tabs have no pty and drop out.
 */
export function shellPtyIds(layout: WorkspaceLayout): string[] {
  const ids: string[] = [];
  for (const tab of allTabs(layout)) {
    // A kind this build does not render owns no shell here (tab-kinds.ts).
    if (tab.kind !== 'editor' && rendersTabKind(tab.kind) && tab.ptyId) ids.push(tab.ptyId);
  }
  return ids;
}

/**
 * The terminals to watch for a session that has no mounted view (evicted from
 * the LRU, or not opened yet this run): every shell of its last known layout,
 * else only the eagerly spawned conversation shell. Watching the conversation
 * shell alone missed an agent in any other tab - with no marker from the
 * watched shell the fallback quiet timer settled a working session idle
 * (2026-10-29).
 */
export function unmountedSessionPtyIds(
  sessionId: string,
  layout: WorkspaceLayout | undefined,
): string[] {
  return layout ? shellPtyIds(layout) : [conversationPtyId(sessionId)];
}

/**
 * All tabs in stable (insertion) order. Ops never recreate an existing tab
 * entry, so this order is stable across moves - letting the terminal pool key
 * by tab id without ever reordering (hence never remounting) a `TerminalView`.
 */
export function allTabs(layout: WorkspaceLayout): Tab[] {
  return Object.values(layout.tabs);
}

export function tabCount(layout: WorkspaceLayout): number {
  return Object.keys(layout.tabs).length;
}

// ---------------------------------------------------------------------------
// Spatial navigation (move keyboard focus between split panes)
// ---------------------------------------------------------------------------

/** Arrow-key direction for moving keyboard focus between split panes. */
export type FocusDirection = 'left' | 'right' | 'up' | 'down';

/** A pane's rectangle within the workspace; 0–100 on each axis (a percentage). */
type NormRect = { x: number; y: number; w: number; h: number };

/**
 * Each leaf pane's rectangle, computed by walking the split tree from the root
 * and dividing space by every split's `sizes`. Coordinates are percentages (the
 * whole workspace is 100×100) - directional navigation only compares relative
 * positions, so it needs no DOM measurement.
 */
function paneRectsFromTree(layout: WorkspaceLayout): Map<NodeId, NormRect> {
  const out = new Map<NodeId, NormRect>();
  const walk = (id: NodeId, rect: NormRect): void => {
    const node = layout.nodes[id];
    if (!node) return;
    if (node.type === 'pane') {
      out.set(id, rect);
      return;
    }
    const total = node.sizes.reduce((a, b) => a + b, 0) || 1;
    let offset = 0;
    node.children.forEach((childId, i) => {
      const frac = (node.sizes[i] ?? 0) / total;
      if (node.direction === 'row') {
        const w = rect.w * frac;
        walk(childId, { x: rect.x + offset, y: rect.y, w, h: rect.h });
        offset += w;
      } else {
        const h = rect.h * frac;
        walk(childId, { x: rect.x, y: rect.y + offset, w: rect.w, h });
        offset += h;
      }
    });
  };
  walk(layout.rootId, { x: 0, y: 0, w: 100, h: 100 });
  return out;
}

/** Length two 1-D intervals [a0, a0+aLen] and [b0, b0+bLen] overlap by. */
function overlapLen(a0: number, aLen: number, b0: number, bLen: number): number {
  return Math.min(a0 + aLen, b0 + bLen) - Math.max(a0, b0);
}

/**
 * The pane adjacent to `fromPaneId` in a given arrow direction, or null when
 * there is none - an unsplit workspace, or nothing lies that way. Drives the
 * keyboard shortcut that walks focus between split panes: from the source pane,
 * take the nearest pane on that side that shares some span along the
 * perpendicular axis; ties break toward the pane whose center lines up best.
 * Pure over the layout model (no DOM), so it's unit-testable in isolation.
 */
export function paneInDirection(
  layout: WorkspaceLayout,
  fromPaneId: NodeId,
  direction: FocusDirection,
): NodeId | null {
  const rects = paneRectsFromTree(layout);
  const from = rects.get(fromPaneId);
  if (!from) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const fromPerpCenter = horizontal ? from.y + from.h / 2 : from.x + from.w / 2;

  const EPS = 0.01;
  let best: { id: NodeId; gap: number; centerDist: number } | null = null;
  for (const [id, r] of rects) {
    if (id === fromPaneId) continue;
    // `gap` is the distance along the movement axis (≈0 for an adjacent pane,
    // negative when `r` is on the wrong side); `perp` is the overlap along the
    // other axis (> 0 means the two panes actually face each other).
    let gap = 0;
    let perp = 0;
    switch (direction) {
      case 'right':
        gap = r.x - (from.x + from.w);
        perp = overlapLen(from.y, from.h, r.y, r.h);
        break;
      case 'left':
        gap = from.x - (r.x + r.w);
        perp = overlapLen(from.y, from.h, r.y, r.h);
        break;
      case 'down':
        gap = r.y - (from.y + from.h);
        perp = overlapLen(from.x, from.w, r.x, r.w);
        break;
      case 'up':
        gap = from.y - (r.y + r.h);
        perp = overlapLen(from.x, from.w, r.x, r.w);
        break;
    }
    if (gap < -EPS || perp <= EPS) continue; // wrong side, or no shared span
    const perpCenter = horizontal ? r.y + r.h / 2 : r.x + r.w / 2;
    const centerDist = Math.abs(perpCenter - fromPerpCenter);
    // Prefer the closest pane along the movement axis, then the best-aligned.
    if (!best || gap < best.gap - EPS || (gap <= best.gap + EPS && centerDist < best.centerDist)) {
      best = { id, gap, centerDist };
    }
  }
  return best ? best.id : null;
}

/**
 * The tab adjacent to a pane's active tab within its own strip - the previous
 * tab for `left`, the next for `right` (the strip is horizontal) - or null at an
 * end, for a vertical direction, or when the pane can't be resolved. Lets the
 * focus-navigation shortcuts fall back to switching tabs when no pane lies in
 * the arrow's direction, e.g. an unsplit workspace with several tabs open. No
 * wrap, matching pane focus (a no-op at either end of the strip).
 */
export function tabInDirection(
  layout: WorkspaceLayout,
  paneId: NodeId,
  direction: FocusDirection,
): TabId | null {
  if (direction !== 'left' && direction !== 'right') return null;
  const pane = getPane(layout, paneId);
  if (!pane) return null;
  const idx = pane.tabs.indexOf(pane.activeTabId);
  if (idx < 0) return null;
  return pane.tabs[direction === 'left' ? idx - 1 : idx + 1] ?? null;
}

/**
 * The tab `step` places from the active one in `paneId`'s strip, wrapping at
 * either end (next / previous tab). Null when the pane holds a single tab -
 * there is nowhere to go.
 */
export function cycleTab(layout: WorkspaceLayout, paneId: NodeId, step: 1 | -1): TabId | null {
  const pane = getPane(layout, paneId);
  if (!pane || pane.tabs.length < 2) return null;
  const idx = pane.tabs.indexOf(pane.activeTabId);
  if (idx < 0) return null;
  const n = pane.tabs.length;
  return pane.tabs[(idx + step + n) % n] ?? null;
}

// ---------------------------------------------------------------------------
// Persistence (serialize / restore across app restarts)
// ---------------------------------------------------------------------------

/**
 * A string that changes when the *structure* changes - tabs added/removed/moved,
 * splits created/collapsed, a tab renamed - but NOT on a pure resize (split
 * `sizes`) or a focus change (active pane / active tab). Lets the save path
 * persist tab/split changes immediately while debouncing the rapid streams of
 * size changes from a resize-handle drag and focus flips from clicking around;
 * the debounced write still persists the full layout, focus included.
 */
export function structuralSignature(layout: WorkspaceLayout): string {
  const parts: string[] = [layout.rootId];
  for (const id of Object.keys(layout.nodes).sort()) {
    const n = layout.nodes[id];
    if (n.type === 'pane') parts.push(`P:${n.id}:${n.tabs.join('>')}`);
    else parts.push(`S:${n.id}:${n.direction}:${n.children.join('>')}`);
  }
  for (const id of Object.keys(layout.tabs).sort()) {
    const t = layout.tabs[id];
    parts.push(
      `T:${t.id}:${t.kind}:${t.title}:${t.ptyId ?? ''}:${t.filePath ?? ''}:${t.view ?? ''}:${t.hostId ?? ''}`,
    );
  }
  return parts.join('|');
}

/** Whether a parsed value is a well-formed `Tab` entry (id/kind plus the kind's identity field). */
function isValidTabEntry(value: unknown): value is Tab {
  const t = value as Record<string, unknown> | null;
  if (typeof t?.id !== 'string' || typeof t?.kind !== 'string') return false;
  // A page tab is identified by its URL in every build, rendered or not.
  if ('url' in t || isPageTabKind(t.kind)) return typeof t.url === 'string';
  // A kind this build does not render (a newer build's, or a Pro one in the
  // core build - tab-kinds.ts) is kept as it is: it shows a placeholder and
  // never spawns a shell. Rejecting it would reset the whole layout.
  if (!rendersTabKind(t.kind)) return typeof t.title === 'string';
  // Editor tabs are identified by a file path, shell tabs own a PTY id, and
  // an extension's view tab by its kind alone.
  if (t.kind === 'editor') {
    return (
      typeof t.filePath === 'string' && (t.hostId === undefined || typeof t.hostId === 'string')
    );
  }
  if (t.kind === 'conversation' || t.kind === 'terminal') return typeof t.ptyId === 'string';
  return true;
}

/**
 * Validate a value parsed back from storage before using it as a layout. A blob
 * could be from an older schema (or corrupt); a bad seed would crash the provider,
 * so callers fall back to a fresh layout when this returns false. Checks the full
 * set of invariants the renderer relies on: every tab is held by exactly one pane
 * (and every pane reference resolves), each pane's `activeTabId` is one of its
 * tabs, `activePaneId` resolves to a pane (not a split), every node is reachable
 * from the root exactly once (no orphans, no shared children, no cycles), and
 * every tab carries an id/kind/ptyId. For persisted blobs that *almost* satisfy
 * this, prefer `normalizeRestoredLayout`, which repairs before validating.
 */
export function isWorkspaceLayout(value: unknown): value is WorkspaceLayout {
  if (typeof value !== 'object' || value === null) return false;
  const l = value as Record<string, unknown>;
  if (typeof l.rootId !== 'string' || typeof l.activePaneId !== 'string') return false;
  if (typeof l.nodes !== 'object' || l.nodes === null) return false;
  if (typeof l.tabs !== 'object' || l.tabs === null) return false;
  const nodes = l.nodes as Record<string, unknown>;
  const tabs = l.tabs as Record<string, unknown>;
  if (!(l.rootId in nodes) || !(l.activePaneId in nodes)) return false;
  const referencedTabs = new Set<string>();
  for (const id in nodes) {
    const n = nodes[id] as Record<string, unknown> | null;
    if (n?.type === 'pane') {
      if (!Array.isArray(n.tabs) || typeof n.activeTabId !== 'string') return false;
      // An empty pane is legal only as the whole workspace (all tabs closed) -
      // inside a split it should have been collapsed away.
      if (n.tabs.length === 0 && (id !== l.rootId || n.activeTabId !== '')) return false;
      for (const t of n.tabs) {
        if (typeof t !== 'string' || !(t in tabs)) return false;
        // A tab lives in exactly one pane - a duplicate would render twice.
        if (referencedTabs.has(t)) return false;
        referencedTabs.add(t);
      }
      if (n.tabs.length > 0 && !n.tabs.includes(n.activeTabId)) return false;
    } else if (n?.type === 'split') {
      if (!Array.isArray(n.children) || !Array.isArray(n.sizes)) return false;
      if (n.children.length !== n.sizes.length) return false;
      for (const c of n.children) if (typeof c !== 'string' || !(c in nodes)) return false;
    } else {
      return false;
    }
  }
  // Orphaned tabs would never render but would pin PTY ids forever.
  for (const id in tabs) if (!referencedTabs.has(id)) return false;
  if ((nodes[l.activePaneId] as Record<string, unknown>).type !== 'pane') return false;
  for (const id in tabs) if (!isValidTabEntry(tabs[id])) return false;
  // Every node must be reachable from the root exactly once: revisiting means a
  // shared child or a cycle; a shortfall means unreachable (leaked) nodes.
  const visited = new Set<string>();
  const stack: string[] = [l.rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) return false;
    visited.add(id);
    const n = nodes[id] as Record<string, unknown>;
    if (n.type === 'split') for (const c of n.children as string[]) stack.push(c);
  }
  return visited.size === Object.keys(nodes).length;
}

/**
 * Best-effort repair of a layout restored from persistence (or handed across
 * windows). A blob can drift slightly out of shape - a crash mid-write, an op
 * from an older build - and rejecting it wholesale would cost the user their
 * whole tab/split arrangement. Instead: drop malformed tab entries and node
 * shapes, prune dangling/duplicate tab references and orphaned tabs, drop
 * unreachable/cyclic subtrees, then run `collapseEmpty` to re-normalise the tree
 * and re-target `activePaneId`. The result is accepted only if it then passes
 * `isWorkspaceLayout`; returns null when the blob is beyond repair, in which
 * case callers fall back to a fresh layout.
 *
 * Pure and deterministic (no id minting), so it is safe inside a `useReducer`
 * initializer under StrictMode's double-invocation. Valid layouts pass through
 * with every pane/tab object identity intact - terminals never remount.
 */
export function normalizeRestoredLayout(value: unknown): WorkspaceLayout | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.rootId !== 'string') return null;
  if (typeof raw.nodes !== 'object' || raw.nodes === null) return null;
  if (typeof raw.tabs !== 'object' || raw.tabs === null) return null;

  // 1) Keep only well-formed tab entries, repairing a key/id mismatch.
  const tabs: Record<TabId, Tab> = {};
  for (const [id, t] of Object.entries(raw.tabs as Record<string, unknown>)) {
    if (isValidTabEntry(t)) tabs[id] = t.id === id ? t : { ...t, id };
  }

  // 2) Keep only pane/split-shaped nodes. Panes drop dangling and duplicate tab
  //    references (first pane wins) and re-target a bad activeTabId; splits keep
  //    string children (dangling ones are dropped by the walk below) and coerce
  //    non-numeric sizes to 0 (renormalised by collapseEmpty).
  const shaped: Record<NodeId, LayoutNode> = {};
  const claimed = new Set<TabId>();
  // Whether the blob claimed to hold any tab at all (a record or a pane
  // reference, valid or not) - distinguishes a workspace the user emptied on
  // purpose from one repair emptied (see the guard at the end).
  let rawHadTabs = Object.keys(raw.tabs as object).length > 0;
  for (const [id, entry] of Object.entries(raw.nodes as Record<string, unknown>)) {
    const n = entry as Record<string, unknown> | null;
    if (n?.type === 'pane' && Array.isArray(n.tabs)) {
      if (n.tabs.length > 0) rawHadTabs = true;
      const paneTabs = (n.tabs as unknown[]).filter(
        (t): t is TabId => typeof t === 'string' && t in tabs && !claimed.has(t),
      );
      for (const t of paneTabs) claimed.add(t);
      const activeTabId =
        typeof n.activeTabId === 'string' && paneTabs.includes(n.activeTabId)
          ? n.activeTabId
          : (paneTabs[paneTabs.length - 1] ?? '');
      shaped[id] = { type: 'pane', id, tabs: paneTabs, activeTabId };
    } else if (n?.type === 'split' && Array.isArray(n.children) && Array.isArray(n.sizes)) {
      const children = (n.children as unknown[]).filter((c): c is NodeId => typeof c === 'string');
      shaped[id] = {
        type: 'split',
        id,
        direction: n.direction === 'column' ? 'column' : 'row',
        children,
        sizes: children.map((_, i) => {
          const s = (n.sizes as unknown[])[i];
          return typeof s === 'number' && Number.isFinite(s) ? s : 0;
        }),
      };
    }
  }

  // 3) Walk from the root, keeping only the first reference to each node - this
  //    sheds unreachable nodes, duplicate (shared-child) references, and cycles,
  //    none of which `collapseEmpty`'s recursion is guarded against.
  const nodes: Record<NodeId, LayoutNode> = {};
  const visit = (id: NodeId, path: Set<NodeId>): boolean => {
    if (path.has(id) || nodes[id]) return false; // cycle / already claimed
    const node = shaped[id];
    if (!node) return false;
    if (node.type === 'pane') {
      nodes[id] = node;
      return true;
    }
    path.add(id);
    const children: NodeId[] = [];
    const sizes: number[] = [];
    node.children.forEach((childId, i) => {
      if (visit(childId, path)) {
        children.push(childId);
        sizes.push(node.sizes[i] ?? 0);
      }
    });
    path.delete(id);
    nodes[id] = { ...node, children, sizes };
    return true;
  };
  if (!visit(raw.rootId, new Set())) return null;

  // 4) Re-collapse: prunes emptied panes, unwraps single-child splits, and
  //    re-targets activePaneId onto a surviving pane.
  const collapsed = collapseEmpty({
    rootId: raw.rootId,
    nodes,
    tabs,
    activePaneId: typeof raw.activePaneId === 'string' ? raw.activePaneId : raw.rootId,
  });

  // 5) Drop tabs no surviving pane references (their pane may have been pruned
  //    above) - they'd never render, just pin PTY ids. Then accept only if every
  //    invariant now holds.
  const referenced = new Set<TabId>();
  for (const id in collapsed.nodes) {
    const node = collapsed.nodes[id];
    if (node.type === 'pane') for (const t of node.tabs) referenced.add(t);
  }
  const survivingTabs: Record<TabId, Tab> = {};
  for (const id in collapsed.tabs) {
    if (referenced.has(id)) survivingTabs[id] = collapsed.tabs[id];
  }
  const repaired: WorkspaceLayout = { ...collapsed, tabs: survivingTabs };
  // A workspace the user emptied on purpose round-trips as empty. But when the
  // blob HAD tabs and repair dropped every one (malformed entries, dangling
  // references), the user never saw an empty workspace - treat it as beyond
  // repair so the caller falls back to a fresh layout instead of restoring a
  // surprise "No tabs open".
  if (tabCount(repaired) === 0 && rawHadTabs) return null;
  return isWorkspaceLayout(repaired) ? repaired : null;
}

// ---------------------------------------------------------------------------
// Operations (pure)
// ---------------------------------------------------------------------------

/**
 * Add a new (already-constructed) tab to a pane and activate it. `index` is the
 * position in the pane's tab list to insert at ("insert before the tab at this
 * index", as in `moveTab`); omitted, the tab is appended.
 */
export function addTab(
  layout: WorkspaceLayout,
  paneId: NodeId,
  tab: Tab,
  index?: number,
): WorkspaceLayout {
  const targetId = getPane(layout, paneId)
    ? paneId
    : (firstLeaf(layout.nodes, layout.rootId) ?? layout.rootId);
  const target = getPane(layout, targetId);
  if (!target) return layout;
  const tabs = [...target.tabs];
  tabs.splice(clamp(index ?? tabs.length, 0, tabs.length), 0, tab.id);
  return {
    ...layout,
    nodes: {
      ...layout.nodes,
      [targetId]: { ...target, tabs, activeTabId: tab.id },
    },
    tabs: { ...layout.tabs, [tab.id]: tab },
    activePaneId: targetId,
  };
}

/**
 * Split `targetPaneId` along `edge`, moving `movingTabId` into a new pane on
 * that side. If the target's parent is already a split of the same direction,
 * the new pane is inserted as a sibling (keeping the tree shallow); otherwise
 * the target is wrapped in a fresh split. The moving tab is pulled out of its
 * current pane first; any pane it empties is collapsed away.
 *
 * `ids` carries pre-minted ids for the nodes a split creates. The reducer path
 * MUST pass them (action payloads mint them dispatch-side) so it stays
 * deterministic under StrictMode's double-invocation; only direct, non-reducer
 * callers may omit them and have ids minted here.
 */
export function splitPane(
  layout: WorkspaceLayout,
  targetPaneId: NodeId,
  edge: Edge,
  movingTabId: TabId,
  ids?: { newPaneId?: NodeId; splitId?: NodeId },
): WorkspaceLayout {
  const target = getPane(layout, targetPaneId);
  if (!target) return layout;
  const sourcePaneId = paneOf(layout, movingTabId);
  if (!sourcePaneId) return layout;
  // Splitting a pane using its own sole tab is a no-op (nothing would change).
  if (sourcePaneId === targetPaneId && target.tabs.length <= 1) return layout;

  const direction: SplitDirection = edge === 'left' || edge === 'right' ? 'row' : 'column';
  const before = edge === 'left' || edge === 'top';

  const nodes: Record<NodeId, LayoutNode> = { ...layout.nodes };

  // 1) Remove the moving tab from its source pane.
  const source = nodes[sourcePaneId] as PaneNode;
  const srcTabs = source.tabs.filter((t) => t !== movingTabId);
  nodes[sourcePaneId] = {
    ...source,
    tabs: srcTabs,
    activeTabId:
      source.activeTabId === movingTabId
        ? (srcTabs[srcTabs.length - 1] ?? source.activeTabId)
        : source.activeTabId,
  };

  // 2) New pane holding only the moving tab.
  const newPane: PaneNode = {
    type: 'pane',
    id: ids?.newPaneId ?? crypto.randomUUID(),
    tabs: [movingTabId],
    activeTabId: movingTabId,
  };
  nodes[newPane.id] = newPane;

  // 3) Place it adjacent to the target.
  const parentInfo = findParent(layout, targetPaneId);
  if (parentInfo && parentInfo.parent.direction === direction) {
    // Insert into the existing same-direction split, halving the target's slot.
    const parent = nodes[parentInfo.parent.id] as SplitNode;
    const idx = parentInfo.index;
    const slot = parent.sizes[idx] ?? 100 / parent.children.length;
    const children = [...parent.children];
    const sizes = [...parent.sizes];
    sizes[idx] = slot / 2;
    const insertAt = before ? idx : idx + 1;
    children.splice(insertAt, 0, newPane.id);
    sizes.splice(insertAt, 0, slot / 2);
    nodes[parent.id] = { ...parent, children, sizes };
    return collapseEmpty({ ...layout, nodes, activePaneId: newPane.id });
  }

  // Otherwise wrap the target in a brand-new split.
  const split: SplitNode = {
    type: 'split',
    id: ids?.splitId ?? crypto.randomUUID(),
    direction,
    children: before ? [newPane.id, targetPaneId] : [targetPaneId, newPane.id],
    sizes: [50, 50],
  };
  nodes[split.id] = split;
  let rootId = layout.rootId;
  if (parentInfo) {
    const parent = nodes[parentInfo.parent.id] as SplitNode;
    const children = [...parent.children];
    children[parentInfo.index] = split.id;
    nodes[parent.id] = { ...parent, children };
  } else {
    rootId = split.id;
  }
  return collapseEmpty({ ...layout, nodes, rootId, activePaneId: newPane.id });
}

/**
 * Move `tabId` into `toPaneId` at `insertIndex` (index in the target pane's
 * current tab list - "insert before the tab at this index"). Works for both
 * reordering within a pane and moving across panes; empties collapse.
 */
export function moveTab(
  layout: WorkspaceLayout,
  tabId: TabId,
  toPaneId: NodeId,
  insertIndex: number,
): WorkspaceLayout {
  const toPane = getPane(layout, toPaneId);
  if (!toPane) return layout;
  const fromPaneId = paneOf(layout, tabId);
  if (!fromPaneId) return layout;

  const nodes: Record<NodeId, LayoutNode> = { ...layout.nodes };
  const fromPane = nodes[fromPaneId] as PaneNode;
  const fromIndex = fromPane.tabs.indexOf(tabId);

  if (fromPaneId === toPaneId) {
    // Reorder within one pane: drop the tab, account for the index shift.
    const arr = fromPane.tabs.filter((t) => t !== tabId);
    const at = clamp(insertIndex > fromIndex ? insertIndex - 1 : insertIndex, 0, arr.length);
    arr.splice(at, 0, tabId);
    nodes[fromPaneId] = { ...fromPane, tabs: arr, activeTabId: tabId };
    return { ...layout, nodes, activePaneId: fromPaneId };
  }

  const srcTabs = fromPane.tabs.filter((t) => t !== tabId);
  nodes[fromPaneId] = {
    ...fromPane,
    tabs: srcTabs,
    activeTabId:
      fromPane.activeTabId === tabId
        ? (srcTabs[Math.max(0, fromIndex - 1)] ?? srcTabs[0] ?? fromPane.activeTabId)
        : fromPane.activeTabId,
  };
  const toTabs = [...toPane.tabs];
  toTabs.splice(clamp(insertIndex, 0, toTabs.length), 0, tabId);
  nodes[toPaneId] = { ...toPane, tabs: toTabs, activeTabId: tabId };

  return collapseEmpty({ ...layout, nodes, activePaneId: toPaneId });
}

/**
 * Remove (close) a tab and drop it from the tabs record. Closing the last tab
 * is allowed - the workspace collapses to a single empty pane (rendered as the
 * "No tabs open" state) rather than keeping a shell alive.
 */
export function removeTab(layout: WorkspaceLayout, tabId: TabId): WorkspaceLayout {
  const tab = layout.tabs[tabId];
  if (!tab) return layout;
  // A primary view IS its session - closing it would leave no way back.
  if (!isClosable(tab)) return layout;
  const paneId = paneOf(layout, tabId);
  if (!paneId) return layout;

  const nodes: Record<NodeId, LayoutNode> = { ...layout.nodes };
  const pane = nodes[paneId] as PaneNode;
  const idx = pane.tabs.indexOf(tabId);
  const tabs = pane.tabs.filter((t) => t !== tabId);
  nodes[paneId] = {
    ...pane,
    tabs,
    activeTabId:
      pane.activeTabId === tabId
        ? (tabs[Math.max(0, idx - 1)] ?? tabs[0] ?? pane.activeTabId)
        : pane.activeTabId,
  };
  const restTabs = { ...layout.tabs };
  delete restTabs[tabId];
  return collapseEmpty({ ...layout, nodes, tabs: restTabs });
}

/**
 * Repoint an editor tab at a new file path (after a rename/move on disk), updating
 * its title to match. No-op for non-editor tabs or unknown ids.
 */
export function setEditorTabPath(
  layout: WorkspaceLayout,
  tabId: TabId,
  filePath: string,
  title: string,
): WorkspaceLayout {
  const tab = layout.tabs[tabId];
  if (!tab || tab.kind !== 'editor') return layout;
  return {
    ...layout,
    tabs: { ...layout.tabs, [tabId]: { ...tab, filePath, title } },
  };
}

/** Whether a tab shows a page (it carries the page's `url`) rather than a shell or a file. */
export function isPageTab(tab: Pick<Tab, 'url'>): boolean {
  return typeof tab.url === 'string';
}

/**
 * Record what a page tab shows now (its page committed a navigation or
 * changed its title). Same layout back when nothing changed.
 */
export function setPageTab(
  layout: WorkspaceLayout,
  tabId: TabId,
  patch: { url?: string; title?: string },
): WorkspaceLayout {
  const tab = layout.tabs[tabId];
  if (!tab || !isPageTab(tab)) return layout;
  const url = patch.url ?? tab.url;
  const title = patch.title?.trim() ? patch.title.trim().slice(0, 120) : tab.title;
  if (url === tab.url && title === tab.title) return layout;
  return { ...layout, tabs: { ...layout.tabs, [tabId]: { ...tab, url, title } } };
}

/** Whether a tab can be shown in an extension's view over its agent: it runs a shell. */
export function canShowView(tab: Tab): boolean {
  return (tab.kind === 'terminal' || tab.kind === 'conversation') && !!tab.ptyId;
}

/** Show a shell tab in an extension's view over its agent, or back as the terminal. */
export function setTabView(
  layout: WorkspaceLayout,
  tabId: TabId,
  view: string | null,
): WorkspaceLayout {
  const tab = layout.tabs[tabId];
  if (!tab || !canShowView(tab) || (tab.view ?? null) === view) return layout;
  const next: Tab = { ...tab };
  if (view) next.view = view;
  else delete next.view;
  return { ...layout, tabs: { ...layout.tabs, [tabId]: next } };
}

export function setActiveTab(
  layout: WorkspaceLayout,
  paneId: NodeId,
  tabId: TabId,
): WorkspaceLayout {
  const pane = getPane(layout, paneId);
  if (!pane || !pane.tabs.includes(tabId)) return layout;
  return {
    ...layout,
    nodes: { ...layout.nodes, [paneId]: { ...pane, activeTabId: tabId } },
    activePaneId: paneId,
  };
}

/**
 * Bring `tabId` to the front of its pane, leaving the active pane (and the
 * keyboard focus with it) where it is - an agent driving a browser tab must
 * not take the user's typing away (a private plan › Phase 3).
 */
export function showTab(layout: WorkspaceLayout, tabId: TabId): WorkspaceLayout {
  const paneId = paneOf(layout, tabId);
  const pane = paneId ? getPane(layout, paneId) : null;
  if (!paneId || !pane || pane.activeTabId === tabId) return layout;
  return { ...layout, nodes: { ...layout.nodes, [paneId]: { ...pane, activeTabId: tabId } } };
}

export function setActivePane(layout: WorkspaceLayout, paneId: NodeId): WorkspaceLayout {
  if (!getPane(layout, paneId) || layout.activePaneId === paneId) return layout;
  return { ...layout, activePaneId: paneId };
}

/** Replace a split's child sizes (from a resize-handle drag). */
export function resizeSplit(
  layout: WorkspaceLayout,
  splitId: NodeId,
  sizes: number[],
): WorkspaceLayout {
  const node = layout.nodes[splitId];
  if (!node || node.type !== 'split' || sizes.length !== node.children.length) return layout;
  return {
    ...layout,
    nodes: { ...layout.nodes, [splitId]: { ...node, sizes: normalizeSizes(sizes) } },
  };
}

/**
 * Normalise the tree: prune empty panes, unwrap single-child splits, flatten a
 * split nested directly inside a same-direction split, and renormalise sizes.
 * Rebuilds the nodes map from the root so orphaned nodes are dropped. Unchanged
 * panes keep their object identity (good for memoisation).
 *
 * When every pane empties (the last tab closed or transferred away), the tree
 * collapses to a single empty root pane instead of a dangling root - the
 * workspace stays mounted and renders the "No tabs open" state. The pane reuses
 * the old root's id when the root already was a pane (keeping `root:${sessionId}`
 * stable), else the last active pane's; deterministic either way, so it's safe
 * under StrictMode's double invocation.
 */
export function collapseEmpty(layout: WorkspaceLayout): WorkspaceLayout {
  const nodesOut: Record<NodeId, LayoutNode> = {};
  const newRoot = rebuild(layout.rootId, layout.nodes, nodesOut);
  if (newRoot === null) {
    const oldRoot = layout.nodes[layout.rootId];
    const id = oldRoot?.type === 'pane' ? layout.rootId : layout.activePaneId;
    const pane: PaneNode = { type: 'pane', id, tabs: [], activeTabId: '' };
    return { ...layout, nodes: { [id]: pane }, rootId: id, activePaneId: id };
  }
  const rootId = newRoot;
  let activePaneId = layout.activePaneId;
  const active = nodesOut[activePaneId];
  if (!active || active.type !== 'pane') {
    activePaneId = firstLeaf(nodesOut, rootId) ?? rootId;
  }
  return { ...layout, nodes: nodesOut, rootId, activePaneId };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 100 / Math.max(1, sizes.length));
  return sizes.map((s) => (s / total) * 100);
}

function findParent(
  layout: WorkspaceLayout,
  childId: NodeId,
): { parent: SplitNode; index: number } | null {
  for (const id in layout.nodes) {
    const node = layout.nodes[id];
    if (node.type === 'split') {
      const index = node.children.indexOf(childId);
      if (index !== -1) return { parent: node, index };
    }
  }
  return null;
}

function firstLeaf(nodes: Record<NodeId, LayoutNode>, id: NodeId): NodeId | null {
  const node = nodes[id];
  if (!node) return null;
  if (node.type === 'pane') return node.id;
  for (const child of node.children) {
    const found = firstLeaf(nodes, child);
    if (found) return found;
  }
  return null;
}

/** Recursive normaliser; returns the surviving node id, or null to prune. */
function rebuild(
  nodeId: NodeId,
  nodesIn: Record<NodeId, LayoutNode>,
  nodesOut: Record<NodeId, LayoutNode>,
): NodeId | null {
  const node = nodesIn[nodeId];
  if (!node) return null;

  if (node.type === 'pane') {
    if (node.tabs.length === 0) return null;
    nodesOut[node.id] = node;
    return node.id;
  }

  const keptChildren: NodeId[] = [];
  const keptSizes: number[] = [];
  node.children.forEach((childId, i) => {
    const survivor = rebuild(childId, nodesIn, nodesOut);
    if (survivor !== null) {
      keptChildren.push(survivor);
      keptSizes.push(node.sizes[i] ?? 0);
    }
  });

  if (keptChildren.length === 0) return null;
  // Unwrap: a split with one child is replaced by that child.
  if (keptChildren.length === 1) return keptChildren[0];

  // Flatten a same-direction child split into this one.
  const flatChildren: NodeId[] = [];
  const flatSizes: number[] = [];
  keptChildren.forEach((childId, i) => {
    const child = nodesOut[childId];
    if (child && child.type === 'split' && child.direction === node.direction) {
      const slot = keptSizes[i];
      const childTotal = child.sizes.reduce((a, b) => a + b, 0) || 1;
      child.children.forEach((grandChild, j) => {
        flatChildren.push(grandChild);
        flatSizes.push(slot * ((child.sizes[j] ?? 0) / childTotal));
      });
      delete nodesOut[childId];
    } else {
      flatChildren.push(childId);
      flatSizes.push(keptSizes[i]);
    }
  });

  const split: SplitNode = {
    type: 'split',
    id: node.id,
    direction: node.direction,
    children: flatChildren,
    sizes: normalizeSizes(flatSizes),
  };
  nodesOut[split.id] = split;
  return split.id;
}
