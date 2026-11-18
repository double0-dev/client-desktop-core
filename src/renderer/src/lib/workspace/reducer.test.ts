import { describe, expect, it } from 'vitest';
import {
  addTab,
  initialLayout,
  nextShellTitle,
  type PaneNode,
  type Tab,
} from '@renderer/lib/workspace/layout';
import { workspaceReducer, type WorkspaceAction } from '@renderer/lib/workspace/reducer';

const term = (id: string): Tab => ({ id, kind: 'terminal', title: id, ptyId: `pty-${id}` });

const ROOT = 'root:s1';

describe('workspaceReducer', () => {
  it('addTab inserts and activates the tab', () => {
    const next = workspaceReducer(initialLayout('s1'), {
      type: 'addTab',
      paneId: ROOT,
      tab: term('t1'),
    });
    expect((next.nodes[ROOT] as PaneNode).tabs).toEqual(['conversation', 't1']);
    expect((next.nodes[ROOT] as PaneNode).activeTabId).toBe('t1');
  });

  it('split uses the pre-minted ids, so the same action yields the same state', () => {
    const state = addTab(initialLayout('s1'), ROOT, term('t1'));
    const action: WorkspaceAction = {
      type: 'split',
      targetPaneId: ROOT,
      edge: 'right',
      tabId: 't1',
      newPaneId: 'minted-pane',
      splitId: 'minted-split',
    };
    const first = workspaceReducer(state, action);
    const second = workspaceReducer(state, action);
    // StrictMode double-invokes the reducer; both runs must agree exactly.
    expect(first).toEqual(second);
    expect(first.rootId).toBe('minted-split');
    expect((first.nodes['minted-pane'] as PaneNode).tabs).toEqual(['t1']);
  });

  it('splitNewTerminal adds the tab and splits it onto the edge in one action', () => {
    const next = workspaceReducer(initialLayout('s1'), {
      type: 'splitNewTerminal',
      paneId: ROOT,
      edge: 'bottom',
      tab: term('t1'),
      newPaneId: 'np',
      splitId: 'sp',
    });
    expect(next.rootId).toBe('sp');
    expect((next.nodes.np as PaneNode).tabs).toEqual(['t1']);
    expect((next.nodes[ROOT] as PaneNode).tabs).toEqual(['conversation']);
  });

  it('closeTab removes the tab; moveTab relocates it', () => {
    let state = addTab(initialLayout('s1'), ROOT, term('t1'));
    state = workspaceReducer(state, { type: 'moveTab', tabId: 't1', toPaneId: ROOT, index: 0 });
    expect((state.nodes[ROOT] as PaneNode).tabs).toEqual(['t1', 'conversation']);
    state = workspaceReducer(state, { type: 'closeTab', tabId: 't1' });
    expect(state.tabs.t1).toBeUndefined();
  });

  it('syncConversation updates the primary tab in place, no-ops when unchanged', () => {
    const state = addTab(initialLayout('s1', 'Claude Code', 'claude'), ROOT, term('t1'));
    const next = workspaceReducer(state, {
      type: 'syncConversation',
      title: 'Codex',
      startupCommand: 'codex',
    });
    expect(next.tabs.conversation).toMatchObject({ title: 'Codex', startupCommand: 'codex' });
    // Other tabs (their own template commands) are untouched.
    expect(next.tabs.t1).toBe(state.tabs.t1);
    // Same values again → identical state, so dispatching is loop-safe.
    expect(
      workspaceReducer(next, { type: 'syncConversation', title: 'Codex', startupCommand: 'codex' }),
    ).toBe(next);
  });

  it('nextShellTitle: bare base when free, else smallest free number ≥ 2', () => {
    // A Claude Code session: primary "Claude Code" doesn't take "Terminal", so a
    // plain shell (run-on-new-terminal opted out) gets the bare title + its icon.
    const state = initialLayout('s1', 'Claude Code', 'claude');
    expect(nextShellTitle(state.tabs, 'Terminal')).toBe('Terminal');
    expect(nextShellTitle(state.tabs, 'Claude Code')).toBe('Claude Code 2');
    const crowded = addTab(
      addTab(state, ROOT, { id: 'a', kind: 'terminal', title: 'Terminal', ptyId: 'p1' }),
      ROOT,
      { id: 'b', kind: 'terminal', title: 'Terminal 3', ptyId: 'p2' },
    );
    // 1 (bare) and 3 are open → the freed middle number is reused.
    expect(nextShellTitle(crowded.tabs, 'Terminal')).toBe('Terminal 2');
    // Editor tabs never take numbers.
    const withEditor = addTab(state, ROOT, {
      id: 'e',
      kind: 'editor',
      title: 'Terminal',
      filePath: '/p/Terminal',
    });
    expect(nextShellTitle(withEditor.tabs, 'Terminal')).toBe('Terminal');
  });

  it('setActiveTab / setActivePane only change focus', () => {
    const state = addTab(initialLayout('s1'), ROOT, term('t1'));
    const next = workspaceReducer(state, {
      type: 'setActiveTab',
      paneId: ROOT,
      tabId: 'conversation',
    });
    expect((next.nodes[ROOT] as PaneNode).activeTabId).toBe('conversation');
    expect(next.tabs).toEqual(state.tabs);
    // Already-active pane → same state object (no spurious re-render).
    expect(workspaceReducer(next, { type: 'setActivePane', paneId: ROOT })).toBe(next);
  });

  it('renameEditorTab repoints an editor tab and ignores terminals', () => {
    let state = addTab(initialLayout('s1'), ROOT, {
      id: 'e1',
      kind: 'editor',
      title: 'a.ts',
      filePath: '/p/a.ts',
    });
    state = workspaceReducer(state, {
      type: 'renameEditorTab',
      tabId: 'e1',
      filePath: '/p/b.ts',
      title: 'b.ts',
    });
    expect(state.tabs.e1).toMatchObject({ filePath: '/p/b.ts', title: 'b.ts' });
    expect(
      workspaceReducer(state, {
        type: 'renameEditorTab',
        tabId: 'conversation',
        filePath: '/x',
        title: 'x',
      }),
    ).toBe(state);
  });

  it('resize replaces and normalises a split’s sizes', () => {
    const withSplit = workspaceReducer(addTab(initialLayout('s1'), ROOT, term('t1')), {
      type: 'split',
      targetPaneId: ROOT,
      edge: 'right',
      tabId: 't1',
      newPaneId: 'np',
      splitId: 'sp',
    });
    const next = workspaceReducer(withSplit, { type: 'resize', splitId: 'sp', sizes: [30, 70] });
    expect(next.nodes.sp).toMatchObject({ sizes: [30, 70] });
    // Mismatched length is ignored.
    expect(workspaceReducer(next, { type: 'resize', splitId: 'sp', sizes: [100] })).toBe(next);
  });
});
