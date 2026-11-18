import { describe, expect, it } from 'vitest';
import {
  noteFocusedTab,
  recentFocusedTabs,
  resetRecentTabsForTests,
  resolveReviewTarget,
} from '@renderer/lib/review/review-target';
import type { Tab, WorkspaceLayout } from '@renderer/lib/workspace/layout';

function layout(tabs: Tab[], activeTabId = tabs[0]?.id): WorkspaceLayout {
  return {
    rootId: 'p',
    activePaneId: 'p',
    nodes: { p: { type: 'pane', id: 'p', tabs: tabs.map((t) => t.id), activeTabId } },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
  };
}

const conversation: Tab = {
  id: 'conversation',
  kind: 'conversation',
  title: 'Claude Code',
  ptyId: 'conversation:s1',
  startupCommand: 'claude',
};
const codex: Tab = {
  id: 't2',
  kind: 'terminal',
  title: 'Codex',
  ptyId: 'pty-2',
  startupCommand: 'codex',
};
const shell: Tab = { id: 't3', kind: 'terminal', title: 'Terminal', ptyId: 'pty-3' };
const editor: Tab = { id: 'e1', kind: 'editor', title: 'auth.ts', filePath: '/w/auth.ts' };

describe('resolveReviewTarget', () => {
  it('sends to the focused tab when it launched an agent', () => {
    expect(resolveReviewTarget('s1', layout([conversation, codex], 't2'), null)).toEqual({
      key: 'cli:pty-2',
      label: 'Codex',
    });
  });

  it('falls back to the conversation tab when a shell or editor is focused', () => {
    const expected = { key: 'cli:conversation:s1', label: 'Claude Code' };
    expect(resolveReviewTarget('s1', layout([conversation, shell], 't3'), null)).toEqual(expected);
    expect(resolveReviewTarget('s1', layout([conversation, editor], 'e1'), null)).toEqual(expected);
  });

  it('still targets a plain Terminal session’s conversation tab (claude may run there)', () => {
    const plain: Tab = { ...conversation, title: 'Terminal', startupCommand: undefined };
    expect(resolveReviewTarget('s1', layout([plain]), null)?.key).toBe('cli:conversation:s1');
  });

  it('sends a runtime session’s review to its agent, by session id', () => {
    // The primary tab holds the runtime's view (`gadget` stands for any).
    const primary: Tab = { id: 'conversation', kind: 'gadget', title: 'OpenCode' };
    expect(resolveReviewTarget('s1', layout([primary, shell]), 'gadget-runtime')).toEqual({
      key: 's1',
      label: 'OpenCode',
    });
  });

  it('sends to the last focused agent tab while a page tab holds focus', () => {
    // Commenting in a page tab focuses it - the review must still reach the
    // agent you were talking to, not the session's first one.
    const browser: Tab = {
      id: 'b1',
      kind: 'webpage',
      title: 'localhost',
      url: 'http://localhost/',
    };
    const l = layout([conversation, codex, browser], 'b1');
    expect(resolveReviewTarget('s1', l, null, ['t2', 'conversation'])?.key).toBe('cli:pty-2');
    expect(resolveReviewTarget('s1', l, null, ['conversation', 't2'])?.key).toBe(
      'cli:conversation:s1',
    );
  });

  it('skips a recent plain shell and a closed tab for the next agent tab', () => {
    const l = layout([conversation, codex, editor], 'e1');
    expect(resolveReviewTarget('s1', l, null, ['gone', 't3', 't2'])?.key).toBe('cli:pty-2');
  });

  it('counts a shell where an agent reports through markers (claude typed by hand)', () => {
    const l = layout([conversation, shell, editor], 'e1');
    expect(resolveReviewTarget('s1', l, null, ['t3'])?.key).toBe('cli:conversation:s1');
    expect(resolveReviewTarget('s1', l, null, ['t3'], (id) => id === 'pty-3')?.key).toBe(
      'cli:pty-3',
    );
  });

  it('has no target without a shell tab or a layout', () => {
    expect(resolveReviewTarget('s1', layout([editor]), null)).toBeNull();
    expect(resolveReviewTarget('s1', null, null)).toBeNull();
  });
});

describe('noteFocusedTab', () => {
  it('keeps shells newest first, per session, and ignores other kinds', () => {
    resetRecentTabsForTests();
    noteFocusedTab('s1', conversation);
    noteFocusedTab('s1', codex);
    noteFocusedTab('s1', editor);
    noteFocusedTab('s1', conversation);
    noteFocusedTab('s2', shell);
    expect(recentFocusedTabs('s1')).toEqual(['conversation', 't2']);
    expect(recentFocusedTabs('s2')).toEqual(['t3']);
  });
});
