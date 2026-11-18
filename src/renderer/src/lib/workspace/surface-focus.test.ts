import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialLayout, addTab, setActiveTab } from '@renderer/lib/workspace/layout';
import { focusActiveTab, registerEditorFocus } from '@renderer/lib/workspace/surface-focus';

/**
 * Focus returning to the surface from a sidebar region: the active pane's tab
 * must take the caret explicitly, since no layout change fires the surface's
 * own focus effects then.
 */

const terminals = new Map<string, { term: { focus: ReturnType<typeof vi.fn> } }>();
vi.mock('@renderer/lib/terminal/pool', () => ({
  getPooledTerminal: (id: string) => terminals.get(id),
}));

beforeEach(() => terminals.clear());

describe('focusActiveTab', () => {
  it('focuses the active pane’s terminal through the pool', () => {
    const layout = initialLayout('s1', 'Claude Code', 'claude');
    const pane = layout.nodes[layout.activePaneId];
    const tab = pane.type === 'pane' ? layout.tabs[pane.activeTabId] : undefined;
    const focus = vi.fn();
    terminals.set(tab!.ptyId!, { term: { focus } });
    expect(focusActiveTab(layout)).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it('reports false when the terminal is not pooled (not mounted yet)', () => {
    expect(focusActiveTab(initialLayout('s1', 'Claude Code', 'claude'))).toBe(false);
  });

  it('focuses an editor tab through its registered callback, until it unregisters', () => {
    let layout = initialLayout('s1', 'Claude Code', 'claude');
    layout = addTab(layout, layout.activePaneId, {
      id: 'ed1',
      kind: 'editor',
      title: 'auth.ts',
      filePath: '/repo/auth.ts',
    });
    layout = setActiveTab(layout, layout.activePaneId, 'ed1');
    const focus = vi.fn();
    const off = registerEditorFocus('ed1', focus);
    expect(focusActiveTab(layout)).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    off();
    // Unmounted (or still loading): nothing to focus.
    expect(focusActiveTab(layout)).toBe(false);
  });
});
