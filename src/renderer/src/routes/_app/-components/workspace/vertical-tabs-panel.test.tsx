import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { VerticalTabsPanel } from '@renderer/routes/_app/-components/workspace/vertical-tabs-panel';
import type { WorkspaceLayout } from '@renderer/lib/workspace/layout';
import { clearTerminalBusy, setTerminalBusy } from '@renderer/lib/terminal/busy';
import { fakeLayoutContext, withLayout } from '@renderer/test-support';

/**
 * The Tabs tool window lists the same tabs as the pane strips and carries the
 * same live signals: the band and the status dot (design: `Label/Tab status
 * dots`, TABS TOOL WINDOW).
 */

const LAYOUT: WorkspaceLayout = {
  rootId: 'p1',
  nodes: { p1: { type: 'pane', id: 'p1', tabs: ['claude', 'shell', 'file'], activeTabId: 'file' } },
  tabs: {
    claude: { id: 'claude', kind: 'conversation', title: 'Claude Code', ptyId: 'pty-claude' },
    shell: { id: 'shell', kind: 'terminal', title: 'pnpm test', ptyId: 'pty-shell' },
    file: { id: 'file', kind: 'editor', title: 'auth.ts', filePath: '/repo/acme/auth.ts' },
  },
  activePaneId: 'p1',
};

function renderPanel() {
  const ctx = fakeLayoutContext('session-1', { layout: LAYOUT, dirtyTabs: new Set(['file']) });
  return render(<VerticalTabsPanel cwd="/repo/acme" />, { wrapper: withLayout(ctx) });
}

const row = (title: string): HTMLElement => screen.getByRole('tab', { name: new RegExp(title) });
const dotOf = (title: string): HTMLElement | null =>
  row(title).querySelector<HTMLElement>('[data-tab-status]');

afterEach(() => {
  clearTerminalBusy('pty-claude');
  clearTerminalBusy('pty-shell');
});

describe('VerticalTabsPanel status dot', () => {
  it('marks each busy row with its own dot and band', () => {
    renderPanel();
    act(() => {
      setTerminalBusy('pty-claude', 'needs-input');
      setTerminalBusy('pty-shell', 'running');
    });
    expect(dotOf('Claude Code')).toHaveClass('bg-warning');
    expect(row('Claude Code')).toHaveClass('live-band-needs-input');
    expect(dotOf('pnpm test')).toHaveClass('bg-success');
    expect(row('pnpm test')).toHaveClass('live-band-running');
  });

  it('shows no dot on a quiet terminal', () => {
    renderPanel();
    expect(dotOf('Claude Code')).toBeNull();
    expect(dotOf('pnpm test')).toBeNull();
  });

  it('keeps the dot out of the close slot, which the unsaved dot owns', () => {
    // The close button holds its space while hidden, so status dots line up in
    // one column and an editor's unsaved dot in the next.
    renderPanel();
    act(() => setTerminalBusy('pty-claude', 'running'));
    const dot = dotOf('Claude Code')!;
    expect(dot.nextElementSibling).toBe(screen.getByRole('button', { name: 'Close Claude Code' }));
    expect(dotOf('auth.ts')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close auth.ts (unsaved)' })).toBeInTheDocument();
  });
});
