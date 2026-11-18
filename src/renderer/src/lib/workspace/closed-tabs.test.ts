import { describe, expect, it } from 'vitest';
import {
  CLOSED_TAB_LIMIT,
  popClosed,
  rememberClosed,
  reopenTarget,
  type ClosedTab,
} from '@renderer/lib/workspace/closed-tabs';
import { addTab, initialLayout, type Tab } from '@renderer/lib/workspace/layout';

const ROOT = 'root:s1';
const editor = (id: string, filePath = `/repo/${id}.ts`): Tab => ({
  id,
  kind: 'editor',
  title: id,
  filePath,
});
const entry = (tab: Tab, paneId = ROOT, index = 1): ClosedTab => ({ tab, paneId, index });

describe('rememberClosed', () => {
  it('keeps editor and browser tabs, newest last', () => {
    let stack = rememberClosed([], entry(editor('a')));
    stack = rememberClosed(stack, entry({ id: 'b', kind: 'webpage', title: 'b', url: '' }));
    expect(stack.map((e) => e.tab.id)).toEqual(['a', 'b']);
  });

  // A closed shell's process is gone; a "reopened" one would be a new shell,
  // and one whose start command launches an agent would start a new agent.
  it('never keeps a terminal or conversation tab', () => {
    const shell: Tab = { id: 't', kind: 'terminal', title: 't', ptyId: 'pty-t' };
    const convo: Tab = { id: 'c', kind: 'conversation', title: 'c', ptyId: 'pty-c' };
    expect(rememberClosed(rememberClosed([], entry(shell)), entry(convo))).toEqual([]);
  });

  it('keeps only the newest entries past the limit', () => {
    let stack: ClosedTab[] = [];
    for (let i = 0; i < CLOSED_TAB_LIMIT + 5; i++)
      stack = rememberClosed(stack, entry(editor(`f${i}`)));
    expect(stack).toHaveLength(CLOSED_TAB_LIMIT);
    expect(stack[0].tab.id).toBe('f5');
    expect(stack.at(-1)?.tab.id).toBe(`f${CLOSED_TAB_LIMIT + 4}`);
  });
});

describe('popClosed', () => {
  it('takes the newest entry and leaves the rest', () => {
    const stack = [entry(editor('a')), entry(editor('b'))];
    const { entry: top, rest } = popClosed(stack);
    expect(top?.tab.id).toBe('b');
    expect(rest.map((e) => e.tab.id)).toEqual(['a']);
    expect(popClosed([])).toEqual({ entry: null, rest: [] });
  });
});

describe('reopenTarget', () => {
  it('puts the tab back in its pane at its old place, under a fresh id', () => {
    const layout = addTab(initialLayout('s1'), ROOT, editor('x'));
    const target = reopenTarget(layout, entry(editor('old'), ROOT, 1), 'new-id');
    expect(target).toEqual({
      paneId: ROOT,
      index: 1,
      tab: { ...editor('old'), id: 'new-id' },
    });
  });

  it('clamps the place to the strip as it is now', () => {
    const target = reopenTarget(initialLayout('s1'), entry(editor('a'), ROOT, 7), 'n');
    expect(target.index).toBe(1); // [conversation] → after it
  });

  // Its split may have collapsed since: the active pane takes it.
  it('falls back to the active pane when its pane is gone', () => {
    const layout = initialLayout('s1');
    const target = reopenTarget(layout, entry(editor('a'), 'gone-pane', 0), 'n');
    expect(target.paneId).toBe(layout.activePaneId);
    expect(target.index).toBeUndefined();
  });
});
