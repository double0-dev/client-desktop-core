import { afterEach, describe, expect, it } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import type { BrowserSlot } from '@renderer/lib/extension/types';
import {
  CONVERSATION_TAB_ID,
  addTab,
  collapseEmpty,
  initialLayout,
  isWorkspaceLayout,
  moveTab,
  normalizeRestoredLayout,
  paneInDirection,
  removeTab,
  resizeSplit,
  setActivePane,
  showTab,
  setActiveTab,
  setEditorTabPath,
  splitPane,
  shellPtyIds,
  unmountedSessionPtyIds,
  structuralSignature,
  syncConversationTab,
  tabInDirection,
  cycleTab,
  visibleShellPtyIds,
  type PaneNode,
  type SplitNode,
  type Tab,
  type WorkspaceLayout,
  setTabView,
  canShowView,
  setPageTab,
  isTearable,
  nextShellTitle,
} from '@renderer/lib/workspace/layout';

const term = (id: string): Tab => ({ id, kind: 'terminal', title: id, ptyId: `pty-${id}` });

const ROOT = 'root:s1';

/** Root pane with [conversation, t1]. */
function baseLayout(): WorkspaceLayout {
  return addTab(initialLayout('s1'), ROOT, term('t1'));
}

/** Row split: root pane [conversation] | pane p2 [t1]. */
function splitLayout(): WorkspaceLayout {
  return splitPane(baseLayout(), ROOT, 'right', 't1', { newPaneId: 'p2', splitId: 'sp' });
}

function pane(layout: WorkspaceLayout, id: string): PaneNode {
  const node = layout.nodes[id];
  expect(node?.type).toBe('pane');
  return node as PaneNode;
}

function split(layout: WorkspaceLayout, id: string): SplitNode {
  const node = layout.nodes[id];
  expect(node?.type).toBe('split');
  return node as SplitNode;
}

describe('addTab', () => {
  it('appends and activates the tab by default', () => {
    const l = baseLayout();
    expect(pane(l, ROOT).tabs).toEqual([CONVERSATION_TAB_ID, 't1']);
    expect(pane(l, ROOT).activeTabId).toBe('t1');
    expect(l.activePaneId).toBe(ROOT);
  });

  it('inserts at the given index', () => {
    const l = addTab(baseLayout(), ROOT, term('t2'), 1);
    expect(pane(l, ROOT).tabs).toEqual([CONVERSATION_TAB_ID, 't2', 't1']);
  });

  it('clamps an out-of-range index', () => {
    const high = addTab(baseLayout(), ROOT, term('t2'), 99);
    expect(pane(high, ROOT).tabs).toEqual([CONVERSATION_TAB_ID, 't1', 't2']);
    const low = addTab(baseLayout(), ROOT, term('t2'), -5);
    expect(pane(low, ROOT).tabs).toEqual(['t2', CONVERSATION_TAB_ID, 't1']);
  });

  it('falls back to the first leaf when the pane id is unknown', () => {
    const l = addTab(baseLayout(), 'nope', term('t2'));
    expect(pane(l, ROOT).tabs).toContain('t2');
  });
});

describe('splitPane', () => {
  it('wraps the target in a new split and moves the tab into a new pane', () => {
    const l = splitLayout();
    expect(l.rootId).toBe('sp');
    expect(split(l, 'sp').direction).toBe('row');
    expect(split(l, 'sp').children).toEqual([ROOT, 'p2']);
    expect(split(l, 'sp').sizes).toEqual([50, 50]);
    expect(pane(l, ROOT).tabs).toEqual([CONVERSATION_TAB_ID]);
    expect(pane(l, 'p2').tabs).toEqual(['t1']);
    expect(l.activePaneId).toBe('p2');
  });

  it('places the new pane before the target for left/top edges', () => {
    const l = splitPane(baseLayout(), ROOT, 'top', 't1', { newPaneId: 'p2', splitId: 'sp' });
    expect(split(l, 'sp').direction).toBe('column');
    expect(split(l, 'sp').children).toEqual(['p2', ROOT]);
  });

  it('is a no-op when a pane is split with its own sole tab', () => {
    const l = initialLayout('s1');
    expect(splitPane(l, ROOT, 'right', CONVERSATION_TAB_ID, { newPaneId: 'x', splitId: 'y' })).toBe(
      l,
    );
  });

  it('inserts as a sibling in an existing same-direction split, halving the slot', () => {
    let l = splitLayout();
    l = addTab(l, 'p2', term('t2'));
    l = splitPane(l, 'p2', 'right', 't2', { newPaneId: 'p3', splitId: 'sp2' });
    // No nested split: the new pane joins the existing row split.
    expect(l.rootId).toBe('sp');
    expect(split(l, 'sp').children).toEqual([ROOT, 'p2', 'p3']);
    expect(split(l, 'sp').sizes).toEqual([50, 25, 25]);
  });

  it('keeps tab object identity across a split', () => {
    const before = baseLayout();
    const after = splitPane(before, ROOT, 'right', 't1', { newPaneId: 'p2', splitId: 'sp' });
    expect(after.tabs.t1).toBe(before.tabs.t1);
    expect(after.tabs[CONVERSATION_TAB_ID]).toBe(before.tabs[CONVERSATION_TAB_ID]);
  });
});

describe('moveTab', () => {
  it('reorders within a pane, accounting for the index shift', () => {
    let l = addTab(baseLayout(), ROOT, term('t2'));
    l = moveTab(l, CONVERSATION_TAB_ID, ROOT, 3);
    expect(pane(l, ROOT).tabs).toEqual(['t1', 't2', CONVERSATION_TAB_ID]);
    expect(pane(l, ROOT).activeTabId).toBe(CONVERSATION_TAB_ID);
  });

  it('moves across panes and activates the target pane', () => {
    let l = splitLayout();
    l = addTab(l, ROOT, term('t2'));
    l = moveTab(l, 't2', 'p2', 0);
    expect(pane(l, 'p2').tabs).toEqual(['t2', 't1']);
    expect(pane(l, ROOT).tabs).toEqual([CONVERSATION_TAB_ID]);
    expect(l.activePaneId).toBe('p2');
  });

  it('collapses the split when the source pane empties', () => {
    const l = moveTab(splitLayout(), 't1', ROOT, 0);
    // p2 emptied → split unwraps back to the root pane.
    expect(l.rootId).toBe(ROOT);
    expect(l.nodes.sp).toBeUndefined();
    expect(l.nodes.p2).toBeUndefined();
    expect(pane(l, ROOT).tabs).toEqual(['t1', CONVERSATION_TAB_ID]);
  });
});

describe('removeTab (closeTab)', () => {
  it('closes the conversation tab while another shell exists', () => {
    const l = removeTab(baseLayout(), CONVERSATION_TAB_ID);
    expect(pane(l, ROOT).tabs).toEqual(['t1']);
    expect(l.tabs[CONVERSATION_TAB_ID]).toBeUndefined();
  });

  it('closes editor tabs', () => {
    const withEditor = addTab(initialLayout('s1'), ROOT, {
      id: 'e1',
      kind: 'editor',
      title: 'a.ts',
      filePath: '/a.ts',
    });
    expect(removeTab(withEditor, 'e1').tabs.e1).toBeUndefined();
  });

  it('closes the last tab, leaving a single empty root pane', () => {
    const l = removeTab(initialLayout('s1'), CONVERSATION_TAB_ID);
    expect(l.tabs[CONVERSATION_TAB_ID]).toBeUndefined();
    expect(l.rootId).toBe(ROOT);
    expect(l.activePaneId).toBe(ROOT);
    expect(pane(l, ROOT).tabs).toEqual([]);
    expect(pane(l, ROOT).activeTabId).toBe('');
    expect(isWorkspaceLayout(l)).toBe(true);
  });

  it('supports adding a tab back into an emptied workspace', () => {
    const empty = removeTab(initialLayout('s1'), CONVERSATION_TAB_ID);
    const l = addTab(empty, empty.activePaneId, term('t1'));
    expect(pane(l, l.rootId).tabs).toEqual(['t1']);
    expect(pane(l, l.rootId).activeTabId).toBe('t1');
  });

  it('closes a terminal tab and drops it from the tabs record', () => {
    const l = removeTab(baseLayout(), 't1');
    expect(pane(l, ROOT).tabs).toEqual([CONVERSATION_TAB_ID]);
    expect(l.tabs.t1).toBeUndefined();
  });

  it('activates a neighbour when the active tab closes', () => {
    let l = addTab(baseLayout(), ROOT, term('t2'));
    l = removeTab(l, 't2');
    expect(pane(l, ROOT).activeTabId).toBe('t1');
  });

  it('collapses the split when closing empties a pane', () => {
    const l = removeTab(splitLayout(), 't1');
    expect(l.rootId).toBe(ROOT);
    expect(l.nodes.p2).toBeUndefined();
    expect(l.activePaneId).toBe(ROOT);
  });
});

describe('collapseEmpty', () => {
  it('re-targets activePaneId onto a surviving pane', () => {
    const l = splitLayout();
    const broken = { ...l, activePaneId: 'sp' };
    expect(collapseEmpty(broken).activePaneId).toBe(ROOT);
  });

  it('keeps unchanged pane object identity', () => {
    const l = splitLayout();
    expect(collapseEmpty(l).nodes[ROOT]).toBe(l.nodes[ROOT]);
  });

  it('collapses a fully emptied tree to one empty pane, reusing the root pane id', () => {
    const l = initialLayout('s1');
    const root = l.nodes[ROOT] as PaneNode;
    const emptied = { ...l, nodes: { [ROOT]: { ...root, tabs: [] } }, tabs: {} };
    const collapsed = collapseEmpty(emptied);
    expect(collapsed.rootId).toBe(ROOT);
    expect(Object.keys(collapsed.nodes)).toEqual([ROOT]);
    expect(pane(collapsed, ROOT).tabs).toEqual([]);
    expect(pane(collapsed, ROOT).activeTabId).toBe('');
  });

  it('collapses an emptied split root to the last active pane id', () => {
    const l = splitLayout();
    const emptiedNodes = Object.fromEntries(
      Object.entries(l.nodes).map(([id, n]) => [id, n.type === 'pane' ? { ...n, tabs: [] } : n]),
    );
    const collapsed = collapseEmpty({ ...l, nodes: emptiedNodes, tabs: {}, activePaneId: 'p2' });
    expect(collapsed.rootId).toBe('p2');
    expect(collapsed.activePaneId).toBe('p2');
    expect(pane(collapsed, 'p2').tabs).toEqual([]);
  });
});

describe('structuralSignature', () => {
  it('ignores focus changes and resizes', () => {
    const l = splitLayout();
    const sig = structuralSignature(l);
    expect(structuralSignature(setActivePane(l, ROOT))).toBe(sig);
    expect(structuralSignature(setActiveTab(l, ROOT, CONVERSATION_TAB_ID))).toBe(sig);
    expect(structuralSignature(resizeSplit(l, 'sp', [30, 70]))).toBe(sig);
  });

  it('changes when tabs are added, moved, or renamed', () => {
    const l = splitLayout();
    const sig = structuralSignature(l);
    expect(structuralSignature(addTab(l, ROOT, term('t9')))).not.toBe(sig);
    expect(structuralSignature(moveTab(l, 't1', ROOT, 0))).not.toBe(sig);

    let withEditor = addTab(l, ROOT, {
      id: 'e1',
      kind: 'editor',
      title: 'a.ts',
      filePath: '/a.ts',
    });
    const editorSig = structuralSignature(withEditor);
    withEditor = setEditorTabPath(withEditor, 'e1', '/b.ts', 'b.ts');
    expect(structuralSignature(withEditor)).not.toBe(editorSig);
  });
});

describe('isWorkspaceLayout', () => {
  it('accepts layouts produced by the ops', () => {
    expect(isWorkspaceLayout(initialLayout('s1'))).toBe(true);
    expect(isWorkspaceLayout(splitLayout())).toBe(true);
  });

  it('rejects non-objects and empty shells', () => {
    expect(isWorkspaceLayout(null)).toBe(false);
    expect(isWorkspaceLayout(42)).toBe(false);
    expect(isWorkspaceLayout('layout')).toBe(false);
    expect(isWorkspaceLayout({})).toBe(false);
  });

  it('rejects an orphaned tab (in the record but in no pane)', () => {
    const l = baseLayout();
    expect(isWorkspaceLayout({ ...l, tabs: { ...l.tabs, ghost: term('ghost') } })).toBe(false);
  });

  it('rejects a dangling tab reference', () => {
    const l = baseLayout();
    const root = l.nodes[ROOT] as PaneNode;
    const nodes = { ...l.nodes, [ROOT]: { ...root, tabs: [...root.tabs, 'ghost'] } };
    expect(isWorkspaceLayout({ ...l, nodes })).toBe(false);
  });

  it('rejects a tab referenced by two panes', () => {
    const l = splitLayout();
    const p2 = l.nodes.p2 as PaneNode;
    const nodes = { ...l.nodes, p2: { ...p2, tabs: [CONVERSATION_TAB_ID] } };
    expect(isWorkspaceLayout({ ...l, nodes })).toBe(false);
  });

  it('rejects an activeTabId the pane does not hold', () => {
    const l = baseLayout();
    const root = l.nodes[ROOT] as PaneNode;
    const nodes = { ...l.nodes, [ROOT]: { ...root, activeTabId: 'nope' } };
    expect(isWorkspaceLayout({ ...l, nodes })).toBe(false);
  });

  it('rejects activePaneId pointing at a split', () => {
    expect(isWorkspaceLayout({ ...splitLayout(), activePaneId: 'sp' })).toBe(false);
  });

  it('accepts an all-tabs-closed workspace (sole empty root pane)', () => {
    expect(isWorkspaceLayout(removeTab(initialLayout('s1'), CONVERSATION_TAB_ID))).toBe(true);
  });

  it('rejects an empty pane that is not the root, or with a dangling activeTabId', () => {
    const l = splitLayout();
    const p2 = l.nodes.p2 as PaneNode;
    const tabs = { ...l.tabs };
    delete tabs.t1;
    const nodes = { ...l.nodes, p2: { ...p2, tabs: [], activeTabId: '' } };
    expect(isWorkspaceLayout({ ...l, nodes, tabs })).toBe(false);

    const empty = removeTab(initialLayout('s1'), CONVERSATION_TAB_ID);
    const root = empty.nodes[ROOT] as PaneNode;
    expect(
      isWorkspaceLayout({ ...empty, nodes: { [ROOT]: { ...root, activeTabId: 'ghost' } } }),
    ).toBe(false);
  });

  it('rejects unreachable nodes', () => {
    const l = baseLayout();
    // The orphan pane satisfies every per-node invariant; only reachability fails.
    const orphan: PaneNode = { type: 'pane', id: 'lost', tabs: ['t9'], activeTabId: 't9' };
    const broken = {
      ...l,
      nodes: { ...l.nodes, lost: orphan },
      tabs: { ...l.tabs, t9: term('t9') },
    };
    expect(isWorkspaceLayout(broken)).toBe(false);
  });

  it('rejects tabs missing their identity field', () => {
    const l = baseLayout();
    const badEditor = { ...l, tabs: { ...l.tabs, t1: { id: 't1', kind: 'editor', title: 'x' } } };
    expect(isWorkspaceLayout(badEditor)).toBe(false);
    const badTerm = { ...l, tabs: { ...l.tabs, t1: { id: 't1', kind: 'terminal', title: 'x' } } };
    expect(isWorkspaceLayout(badTerm)).toBe(false);
  });

  // a private plan › M0: a layout written by a build that renders more kinds (the
  // build with an extension's tab kinds, or a newer version)
  // must not reset the session's tabs here - the unknown tab is kept and shows a
  // placeholder (tab-kinds.ts, unavailable-tab-layer.tsx).
  it('keeps a tab of a kind this build does not render, with or without a pty id', () => {
    const l = baseLayout();
    const future = { ...l, tabs: { ...l.tabs, t1: { id: 't1', kind: 'canvas', title: 'Board' } } };
    expect(isWorkspaceLayout(future)).toBe(true);
    const withPty = {
      ...l,
      tabs: { ...l.tabs, t1: { id: 't1', kind: 'canvas', title: 'Board', ptyId: 'pty-x' } },
    };
    expect(isWorkspaceLayout(withPty)).toBe(true);
    // Still needs the fields every tab strip reads.
    const untitled = { ...l, tabs: { ...l.tabs, t1: { id: 't1', kind: 'canvas' } } };
    expect(isWorkspaceLayout(untitled)).toBe(false);
  });

  // Plan 29 › M9: a host file outside its projects keeps its host on the tab.
  it("keeps an editor tab's host, and refuses a malformed one", () => {
    const l = baseLayout();
    const editor = (hostId: unknown) => ({
      ...l,
      tabs: {
        ...l.tabs,
        t1: { id: 't1', kind: 'editor', title: 'api.py', filePath: '/usr/lib/api.py', hostId },
      },
    });
    expect(isWorkspaceLayout(editor('h1'))).toBe(true);
    expect(isWorkspaceLayout(editor(undefined))).toBe(true);
    expect(isWorkspaceLayout(editor(42))).toBe(false);
    // The same path on another machine is another tab.
    expect(structuralSignature(editor('h1') as never)).not.toBe(
      structuralSignature(editor('h2') as never),
    );
  });
});

describe('normalizeRestoredLayout', () => {
  it('returns null for garbage', () => {
    expect(normalizeRestoredLayout(null)).toBeNull();
    expect(normalizeRestoredLayout('x')).toBeNull();
    expect(normalizeRestoredLayout({})).toBeNull();
    expect(normalizeRestoredLayout({ rootId: 'r' })).toBeNull();
  });

  it('returns null when nothing renderable survives', () => {
    expect(
      normalizeRestoredLayout({
        rootId: 'r',
        activePaneId: 'r',
        nodes: { r: { type: 'pane', id: 'r', tabs: ['gone'], activeTabId: 'gone' } },
        tabs: {},
      }),
    ).toBeNull();
  });

  it('round-trips an all-tabs-closed workspace instead of resurrecting a tab', () => {
    const empty = removeTab(initialLayout('s1'), CONVERSATION_TAB_ID);
    const restored = normalizeRestoredLayout(JSON.parse(JSON.stringify(empty)));
    expect(restored).toEqual(empty);
  });

  it('returns null when repair drops every tab the blob had', () => {
    const l = initialLayout('s1');
    // The sole tab entry is malformed (no ptyId) - repair discards it, leaving
    // an empty workspace the user never saw.
    const broken = JSON.parse(JSON.stringify(l)) as { tabs: Record<string, { ptyId?: string }> };
    delete broken.tabs[CONVERSATION_TAB_ID].ptyId;
    expect(normalizeRestoredLayout(broken)).toBeNull();
  });

  it('passes a valid layout through structurally unchanged, with tab identity intact', () => {
    const l = splitLayout();
    const restored = normalizeRestoredLayout(l);
    expect(restored).not.toBeNull();
    expect(isWorkspaceLayout(restored)).toBe(true);
    // Tab objects pass through untouched - that identity is what lets the
    // terminal layer keep every shell mounted across a restore.
    expect(restored!.tabs.t1).toBe(l.tabs.t1);
    expect(restored!.tabs[CONVERSATION_TAB_ID]).toBe(l.tabs[CONVERSATION_TAB_ID]);
    expect(restored!.nodes).toEqual(l.nodes);
    expect(restored!.rootId).toBe(l.rootId);
    expect(restored!.activePaneId).toBe(l.activePaneId);
  });

  it('drops orphaned tabs instead of rejecting the layout', () => {
    const l = baseLayout();
    const restored = normalizeRestoredLayout({ ...l, tabs: { ...l.tabs, ghost: term('ghost') } });
    expect(restored).not.toBeNull();
    expect(restored!.tabs.ghost).toBeUndefined();
    expect((restored!.nodes[ROOT] as PaneNode).tabs).toEqual([CONVERSATION_TAB_ID, 't1']);
  });

  it('prunes dangling tab references and repairs activeTabId', () => {
    const l = baseLayout();
    const root = l.nodes[ROOT] as PaneNode;
    const broken = {
      ...l,
      nodes: {
        ...l.nodes,
        [ROOT]: { ...root, tabs: [...root.tabs, 'ghost'], activeTabId: 'ghost' },
      },
    };
    const restored = normalizeRestoredLayout(broken);
    expect(restored).not.toBeNull();
    expect((restored!.nodes[ROOT] as PaneNode).tabs).toEqual([CONVERSATION_TAB_ID, 't1']);
    expect((restored!.nodes[ROOT] as PaneNode).activeTabId).toBe('t1');
  });

  it('keeps the first pane holding a duplicated tab reference', () => {
    const l = splitLayout();
    const p2 = l.nodes.p2 as PaneNode;
    // t1 also (bogusly) claimed by the root pane; p2 keeps only its valid claim.
    const root = l.nodes[ROOT] as PaneNode;
    const broken = {
      ...l,
      nodes: { ...l.nodes, [ROOT]: { ...root, tabs: [...root.tabs, 't1'] }, p2 },
    };
    const restored = normalizeRestoredLayout(broken);
    expect(restored).not.toBeNull();
    expect(isWorkspaceLayout(restored)).toBe(true);
    const holders = Object.values(restored!.nodes).filter(
      (n) => n.type === 'pane' && n.tabs.includes('t1'),
    );
    expect(holders).toHaveLength(1);
  });

  it('drops unreachable nodes and their tabs', () => {
    const l = baseLayout();
    const broken = {
      ...l,
      nodes: {
        ...l.nodes,
        lost: { type: 'pane', id: 'lost', tabs: ['t9'], activeTabId: 't9' },
      },
      tabs: { ...l.tabs, t9: term('t9') },
    };
    const restored = normalizeRestoredLayout(broken);
    expect(restored).not.toBeNull();
    expect(restored!.nodes.lost).toBeUndefined();
    expect(restored!.tabs.t9).toBeUndefined();
  });

  it('re-targets a bogus activePaneId', () => {
    const restored = normalizeRestoredLayout({ ...baseLayout(), activePaneId: 'nope' });
    expect(restored).not.toBeNull();
    expect(restored!.activePaneId).toBe(ROOT);
  });

  it('repairs a tab whose record key and id disagree', () => {
    const l = baseLayout();
    const broken = { ...l, tabs: { ...l.tabs, t1: { ...l.tabs.t1, id: 'other' } } };
    const restored = normalizeRestoredLayout(broken);
    expect(restored).not.toBeNull();
    expect(restored!.tabs.t1.id).toBe('t1');
  });

  it('is deterministic (same input → same output), as the reducer initializer requires', () => {
    const l = splitLayout();
    const broken = { ...l, tabs: { ...l.tabs, ghost: term('ghost') } };
    expect(normalizeRestoredLayout(broken)).toEqual(normalizeRestoredLayout(broken));
  });
});

describe('paneInDirection', () => {
  /**
   * A 2×2 grid of panes (via three peels):
   *   ROOT (top-left) | R  (top-right)
   *   BL   (btm-left) | BR (btm-right)
   */
  function gridLayout(): WorkspaceLayout {
    let l = addTab(
      addTab(addTab(initialLayout('s1'), ROOT, term('t1')), ROOT, term('t2')),
      ROOT,
      term('t3'),
    );
    l = splitPane(l, ROOT, 'right', 't1', { newPaneId: 'R', splitId: 'spRow' });
    l = splitPane(l, ROOT, 'bottom', 't2', { newPaneId: 'BL', splitId: 'spColL' });
    l = splitPane(l, 'R', 'bottom', 't3', { newPaneId: 'BR', splitId: 'spColR' });
    return l;
  }

  it('returns null for an unsplit workspace (only one pane)', () => {
    const l = baseLayout();
    for (const dir of ['left', 'right', 'up', 'down'] as const) {
      expect(paneInDirection(l, ROOT, dir)).toBeNull();
    }
  });

  it('finds the neighbour across a row split, and nothing perpendicular', () => {
    const l = splitLayout(); // ROOT (left) | p2 (right)
    expect(paneInDirection(l, ROOT, 'right')).toBe('p2');
    expect(paneInDirection(l, 'p2', 'left')).toBe(ROOT);
    expect(paneInDirection(l, ROOT, 'left')).toBeNull();
    expect(paneInDirection(l, ROOT, 'up')).toBeNull();
    expect(paneInDirection(l, 'p2', 'down')).toBeNull();
  });

  it('walks all four directions across a 2×2 grid', () => {
    const l = gridLayout();
    expect(paneInDirection(l, ROOT, 'right')).toBe('R');
    expect(paneInDirection(l, ROOT, 'down')).toBe('BL');
    expect(paneInDirection(l, 'R', 'left')).toBe(ROOT);
    expect(paneInDirection(l, 'R', 'down')).toBe('BR');
    expect(paneInDirection(l, 'BR', 'up')).toBe('R');
    expect(paneInDirection(l, 'BR', 'left')).toBe('BL');
    expect(paneInDirection(l, 'BL', 'up')).toBe(ROOT);
    expect(paneInDirection(l, 'BL', 'right')).toBe('BR');
    // Grid edges have no neighbour outward.
    expect(paneInDirection(l, ROOT, 'up')).toBeNull();
    expect(paneInDirection(l, ROOT, 'left')).toBeNull();
    expect(paneInDirection(l, 'BR', 'right')).toBeNull();
    expect(paneInDirection(l, 'BR', 'down')).toBeNull();
  });

  it('picks the nearest pane along the axis, not a farther one', () => {
    // Three columns: ROOT | A | B (same-direction insert keeps them siblings).
    let l = addTab(addTab(initialLayout('s1'), ROOT, term('t1')), ROOT, term('t2'));
    l = splitPane(l, ROOT, 'right', 't1', { newPaneId: 'A', splitId: 'sp' });
    l = splitPane(l, 'A', 'right', 't2', { newPaneId: 'B', splitId: 'sp2' });
    expect(paneInDirection(l, ROOT, 'right')).toBe('A');
    expect(paneInDirection(l, 'B', 'left')).toBe('A');
  });

  it('returns null when the source pane id is unknown', () => {
    expect(paneInDirection(splitLayout(), 'nope', 'right')).toBeNull();
  });
});

describe('tabInDirection', () => {
  /** Root pane with [conversation, t1, t2], t1 active. */
  function threeTabs(): WorkspaceLayout {
    const l = addTab(addTab(initialLayout('s1'), ROOT, term('t1')), ROOT, term('t2'));
    return setActiveTab(l, ROOT, 't1');
  }

  it('walks to the previous/next tab in the strip', () => {
    const l = threeTabs(); // [conversation, t1, t2], active t1
    expect(tabInDirection(l, ROOT, 'left')).toBe(CONVERSATION_TAB_ID);
    expect(tabInDirection(l, ROOT, 'right')).toBe('t2');
  });

  it('does not wrap at either end of the strip', () => {
    const l = threeTabs();
    expect(tabInDirection(setActiveTab(l, ROOT, CONVERSATION_TAB_ID), ROOT, 'left')).toBeNull();
    expect(tabInDirection(setActiveTab(l, ROOT, 't2'), ROOT, 'right')).toBeNull();
  });

  it('returns null for vertical directions (the strip is horizontal)', () => {
    const l = threeTabs();
    expect(tabInDirection(l, ROOT, 'up')).toBeNull();
    expect(tabInDirection(l, ROOT, 'down')).toBeNull();
  });

  it('returns null when the pane id does not resolve to a pane', () => {
    expect(tabInDirection(threeTabs(), 'nope', 'left')).toBeNull();
    // A split node is not a pane.
    expect(tabInDirection(splitLayout(), 'sp', 'right')).toBeNull();
  });
});

describe('cycleTab', () => {
  function threeTabs(): WorkspaceLayout {
    const l = addTab(addTab(initialLayout('s1'), ROOT, term('t1')), ROOT, term('t2'));
    return setActiveTab(l, ROOT, 't1');
  }

  it('steps to the next / previous tab in the strip', () => {
    const l = threeTabs(); // [conversation, t1, t2], active t1
    expect(cycleTab(l, ROOT, 1)).toBe('t2');
    expect(cycleTab(l, ROOT, -1)).toBe(CONVERSATION_TAB_ID);
  });

  // Unlike the focus walk, which leaves the strip for the sidebar at an end.
  it('wraps at either end', () => {
    const l = threeTabs();
    expect(cycleTab(setActiveTab(l, ROOT, 't2'), ROOT, 1)).toBe(CONVERSATION_TAB_ID);
    expect(cycleTab(setActiveTab(l, ROOT, CONVERSATION_TAB_ID), ROOT, -1)).toBe('t2');
  });

  it('has nowhere to go with a single tab, or off a pane', () => {
    expect(cycleTab(initialLayout('s1'), ROOT, 1)).toBeNull();
    expect(cycleTab(threeTabs(), 'nope', 1)).toBeNull();
    expect(cycleTab(splitLayout(), 'sp', 1)).toBeNull();
  });
});

describe('visibleShellPtyIds', () => {
  it('lists only each pane’s active shell tab - hidden siblings are not on screen', () => {
    // Root pane shows the conversation (t1 sits behind it); pane p2 shows t1.
    // addTab makes the new tab active, so re-select the conversation first.
    const layout = setActiveTab(splitLayout(), ROOT, CONVERSATION_TAB_ID);
    expect(visibleShellPtyIds(layout)).toEqual(
      expect.arrayContaining(['conversation:s1', 'pty-t1']),
    );
    expect(visibleShellPtyIds(layout)).toHaveLength(2);
  });

  it('skips a pane whose active tab is an editor - no pty to mark seen', () => {
    const editor: Tab = { id: 'ed', kind: 'editor', title: 'a.ts', filePath: '/a.ts' };
    const layout = addTab(baseLayout(), ROOT, editor);
    expect(visibleShellPtyIds(layout)).toEqual([]);
  });

  it('reads the selected tab, so selecting a finished tab is what reveals it', () => {
    const layout = setActiveTab(baseLayout(), ROOT, 't1');
    expect(visibleShellPtyIds(layout)).toEqual(['pty-t1']);
  });
});

describe('shellPtyIds', () => {
  it('lists every shell tab’s pty, hidden siblings included - the status is derived from all of them', () => {
    // The conversation is selected, so t1 sits behind it: still a live shell.
    const layout = setActiveTab(baseLayout(), ROOT, CONVERSATION_TAB_ID);
    expect(visibleShellPtyIds(layout)).toEqual(['conversation:s1']);
    expect(shellPtyIds(layout)).toEqual(['conversation:s1', 'pty-t1']);
  });

  it('skips editors - no pty, nothing to derive from', () => {
    const editor: Tab = { id: 'ed', kind: 'editor', title: 'a.ts', filePath: '/a.ts' };
    expect(shellPtyIds(addTab(baseLayout(), ROOT, editor))).toEqual(['conversation:s1', 'pty-t1']);
  });

  it('skips a tab of a kind this build does not render, even with a pty id', () => {
    // a private plan › M0: such a tab owns no shell here - watching or disposing
    // its id would reach a terminal this build never started.
    const future = { id: 'f', kind: 'canvas', title: 'Board', ptyId: 'pty-f' } as unknown as Tab;
    expect(shellPtyIds(addTab(baseLayout(), ROOT, future))).toEqual(['conversation:s1', 'pty-t1']);
  });
});

describe('unmountedSessionPtyIds', () => {
  it("watches every shell of the session's last layout, not just the conversation", () => {
    // The bug: an evicted session was watched through conversation:<sid>
    // alone, so an agent working in a second tab went unseen and the quiet
    // timer settled the session idle mid-turn (2026-10-29).
    expect(unmountedSessionPtyIds('s1', baseLayout())).toEqual(['conversation:s1', 'pty-t1']);
  });

  it('leaves out a conversation tab the layout no longer has', () => {
    const closed = removeTab(baseLayout(), CONVERSATION_TAB_ID);
    expect(unmountedSessionPtyIds('s1', closed)).toEqual(['pty-t1']);
  });

  it('falls back to the eager conversation shell of a session never laid out', () => {
    expect(unmountedSessionPtyIds('s1', undefined)).toEqual(['conversation:s1']);
  });
});

describe('syncConversationTab - a relabel reaches the agent tabs', () => {
  it('renames the "+" terminals that run the agent, number kept, and leaves plain shells', () => {
    // A session labelled "Custom" before its claude command was recognised:
    // its "+" tabs read "Custom 2" / "Custom 3" until the relabel renamed them.
    let l = initialLayout('s1', 'Custom', 'claude-personal');
    l = addTab(l, ROOT, { ...term('t2'), title: 'Custom 2', startupCommand: 'claude-personal' });
    l = addTab(l, ROOT, { ...term('t3'), title: 'Custom 3', startupCommand: 'claude-personal' });
    l = addTab(l, ROOT, { ...term('t4'), title: 'Terminal 2' });
    l = addTab(l, ROOT, { ...term('t5'), title: 'Custom build', startupCommand: 'make' });
    const next = syncConversationTab(l, 'Claude Code', 'claude-personal');
    expect(next.tabs[CONVERSATION_TAB_ID].title).toBe('Claude Code');
    expect(next.tabs.t2.title).toBe('Claude Code 2');
    expect(next.tabs.t3.title).toBe('Claude Code 3');
    expect(next.tabs.t4.title).toBe('Terminal 2');
    // Not "<old> <number>": a name of its own.
    expect(next.tabs.t5.title).toBe('Custom build');
    // Settled: a second sync changes nothing.
    expect(syncConversationTab(next, 'Claude Code', 'claude-personal')).toBe(next);
  });
});

describe('runtime sessions: an extension view as the primary tab', () => {
  // `gadget` stands for any extension view (SessionViewSlot.view).
  it('a runtime session starts with a view tab that owns no shell', () => {
    const l = initialLayout('s1', 'Claude Code', undefined, { view: 'gadget' });
    expect(l.tabs[CONVERSATION_TAB_ID]).toEqual({
      id: CONVERSATION_TAB_ID,
      kind: 'gadget',
      title: 'Claude Code',
    });
    expect(shellPtyIds(l)).toEqual([]);
    expect(visibleShellPtyIds(l)).toEqual([]);
    expect(isWorkspaceLayout(l)).toBe(true);
  });

  it('the view tab cannot be closed - it is the session', () => {
    const l = addTab(
      initialLayout('s1', 'Gadget', undefined, { view: 'gadget' }),
      ROOT,
      term('t1'),
    );
    expect(removeTab(l, CONVERSATION_TAB_ID)).toBe(l);
    // Its terminals close as usual.
    expect(removeTab(l, 't1')).not.toBe(l);
  });

  it('a saved view layout survives the restore check', () => {
    const l = initialLayout('s1', 'Gadget', undefined, { view: 'gadget' });
    expect(normalizeRestoredLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
  });

  it('an edit renames the view tab and never gives it a command', () => {
    const l = initialLayout('s1', 'Gadget', undefined, { view: 'gadget' });
    const next = syncConversationTab(l, 'Gemini CLI', 'npx -y @google/gemini-cli');
    expect(next.tabs[CONVERSATION_TAB_ID]).toEqual({
      id: CONVERSATION_TAB_ID,
      kind: 'gadget',
      title: 'Gemini CLI',
    });
  });
});

describe("setTabView (an extension's view over a tab's agent)", () => {
  it('flips a shell tab to the view and back, and persists it in the signature', () => {
    const base = initialLayout('s1', 'Claude Code', 'claude');
    const viewed = setTabView(base, CONVERSATION_TAB_ID, 'gadget');
    expect(viewed.tabs[CONVERSATION_TAB_ID].view).toBe('gadget');
    expect(structuralSignature(viewed)).not.toBe(structuralSignature(base));
    const back = setTabView(viewed, CONVERSATION_TAB_ID, null);
    expect('view' in back.tabs[CONVERSATION_TAB_ID]).toBe(false);
    // No change → the same object.
    expect(setTabView(back, CONVERSATION_TAB_ID, null)).toBe(back);
  });

  it('leaves tabs without a shell alone', () => {
    const runtimeSession = initialLayout('s2', 'OpenCode', undefined, { view: 'gadget' });
    expect(canShowView(runtimeSession.tabs[CONVERSATION_TAB_ID])).toBe(false);
    expect(setTabView(runtimeSession, CONVERSATION_TAB_ID, 'gadget')).toBe(runtimeSession);
    expect(setTabView(runtimeSession, 'nope', 'gadget')).toBe(runtimeSession);
  });
});

// Page tabs: `webpage` stands in for the kind an extension registers
// (`BrowserSlot.tabKind`); a page tab is known by its URL in any build.
describe('page tabs', () => {
  afterEach(() => resetRendererExtensionForTest());
  const page = (id: string, url = 'http://localhost:5173'): Tab => ({
    id,
    kind: 'webpage',
    title: 'localhost:5173',
    url,
  });

  it('a page tab owns no shell and is not torn off', () => {
    const l = addTab(baseLayout(), ROOT, page('b1'));
    expect(shellPtyIds(l)).toEqual(['conversation:s1', 'pty-t1']);
    expect(isTearable(l.tabs.b1)).toBe(false);
    expect(isWorkspaceLayout(l)).toBe(true);
  });

  it('survives a restore with its URL, and an empty URL is the new-tab page', () => {
    const l = addTab(addTab(baseLayout(), ROOT, page('b1')), ROOT, page('b2', ''));
    expect(normalizeRestoredLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
  });

  it('a page entry without a URL is dropped on restore where its kind is rendered', () => {
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      browser: { tabKind: 'webpage' } as BrowserSlot,
    });
    const l = addTab(baseLayout(), ROOT, page('b1'));
    const raw = JSON.parse(JSON.stringify(l));
    delete raw.tabs.b1.url;
    const restored = normalizeRestoredLayout(raw)!;
    expect(restored.tabs.b1).toBeUndefined();
    expect(restored.tabs.t1).toBeDefined();
  });

  it('setPageTab records a navigation and the page title', () => {
    const l = addTab(baseLayout(), ROOT, page('b1'));
    const next = setPageTab(l, 'b1', {
      url: 'http://localhost:5173/checkout',
      title: ' Checkout · acme ',
    });
    expect(next.tabs.b1).toMatchObject({
      url: 'http://localhost:5173/checkout',
      title: 'Checkout · acme',
    });
    // A blank title keeps the old one; no change hands back the same layout.
    expect(setPageTab(next, 'b1', { title: '  ' })).toBe(next);
    expect(setPageTab(next, 'b1', { url: 'http://localhost:5173/checkout' })).toBe(next);
    // Only page tabs.
    expect(setPageTab(next, 't1', { url: 'http://x' })).toBe(next);
  });

  it('a navigation is not a structural change - it saves on the debounce', () => {
    const l = addTab(baseLayout(), ROOT, page('b1'));
    const next = setPageTab(l, 'b1', { url: 'http://localhost:5173/orders' });
    expect(structuralSignature(next)).toBe(structuralSignature(l));
  });

  it('page titles never take a terminal number', () => {
    const l = addTab(baseLayout(), ROOT, { ...page('b1'), title: 'Storybook' });
    expect(nextShellTitle(l.tabs, 'Storybook')).toBe('Storybook');
  });
});

describe('showTab', () => {
  it('brings a tab to the front of its pane without moving the active pane', () => {
    const base = initialLayout('s1');
    const withB = addTab(base, 'root:s1', { id: 'b', kind: 'webpage', title: 'App', url: '' });
    const split = splitPane(withB, 'root:s1', 'right', 'b', { newPaneId: 'p2', splitId: 'sp' });
    const two = addTab(split, 'p2', { id: 'c', kind: 'webpage', title: 'Other', url: '' });
    const focused = setActivePane(two, 'root:s1');
    const shown = showTab(focused, 'b');
    expect((shown.nodes.p2 as { activeTabId: string }).activeTabId).toBe('b');
    expect(shown.activePaneId).toBe('root:s1');
    expect(showTab(shown, 'b')).toBe(shown);
  });
});
