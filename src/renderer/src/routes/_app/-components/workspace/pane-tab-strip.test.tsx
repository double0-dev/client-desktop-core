import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaneTabStrip } from '@renderer/routes/_app/-components/workspace/pane-tab-strip';
import type { PaneNode, Tab } from '@renderer/lib/workspace/layout';
import {
  clearTerminalBusy,
  markTerminalSeen,
  noteTerminalFinished,
  setTerminalBusy,
} from '@renderer/lib/terminal/busy';
import { REVEAL_IN_OS_LABEL } from '@renderer/lib/reveal-in-os';
import { stubApi } from '@renderer/test-support';

/**
 * The live band on a tab (design: `Label/Live rows`): a tab whose terminal is
 * busy is washed with its status colour, in step with the terminal-busy
 * registry - so a running `pnpm test` in a background tab is visible from the
 * strip. Editor tabs have no terminal and never band.
 */

const TABS: Record<string, Tab> = {
  claude: { id: 'claude', kind: 'conversation', title: 'Claude Code', ptyId: 'pty-claude' },
  shell: { id: 'shell', kind: 'terminal', title: 'pnpm test', ptyId: 'pty-shell' },
  file: { id: 'file', kind: 'editor', title: 'auth.ts', filePath: '/repo/acme/auth.ts' },
};
const PANE: PaneNode = {
  type: 'pane',
  id: 'p1',
  tabs: ['claude', 'shell', 'file'],
  activeTabId: 'claude',
};

function renderStrip(dirtyTabs: ReadonlySet<string> = new Set()) {
  return render(
    <PaneTabStrip
      pane={PANE}
      tabs={TABS}
      isActivePane
      dirtyTabs={dirtyTabs}
      cwd="/repo/acme"
      isWorktree={false}
      onSelectTab={vi.fn()}
      onCloseTab={vi.fn()}
      onCloseTabs={vi.fn()}
      onOpenInWindow={vi.fn()}
      onAddTerminal={vi.fn()}
      onAddTemplateTerminal={vi.fn()}
      onSplit={vi.fn()}
    />,
  );
}

const tab = (title: string): HTMLElement => screen.getByRole('tab', { name: new RegExp(title) });

afterEach(() => {
  clearTerminalBusy('pty-claude');
  clearTerminalBusy('pty-shell');
});

describe('PaneTabStrip live band', () => {
  it('bands a tab while its terminal is busy, in its status colour', () => {
    renderStrip();
    expect(tab('Claude Code')).not.toHaveClass('live-band');
    act(() => setTerminalBusy('pty-claude', 'running'));
    expect(tab('Claude Code')).toHaveClass('live-band', 'live-band-running');
    act(() => setTerminalBusy('pty-claude', 'needs-input'));
    expect(tab('Claude Code')).toHaveClass('live-band', 'live-band-needs-input');
    expect(tab('Claude Code')).not.toHaveClass('live-band-running');
    act(() => setTerminalBusy('pty-claude', null));
    expect(tab('Claude Code')).not.toHaveClass('live-band');
  });

  it('bands a background tab on its own, independent of the active one', () => {
    renderStrip();
    act(() => setTerminalBusy('pty-shell', 'running'));
    expect(tab('pnpm test')).toHaveClass('live-band-running');
    expect(tab('Claude Code')).not.toHaveClass('live-band');
  });

  it('never bands an editor tab', () => {
    renderStrip();
    act(() => setTerminalBusy('pty-claude', 'running'));
    expect(tab('auth.ts')).not.toHaveClass('live-band');
  });
});

/**
 * The tab's status dot (design: WorkspaceTab `status-dot`, `Label/Tab status
 * dots`): the session/project-row dot for one terminal, from the same state
 * that bands the tab.
 */
const dotOf = (title: string): HTMLElement | null =>
  tab(title).querySelector<HTMLElement>('[data-tab-status]');

describe('PaneTabStrip status dot', () => {
  it('follows the terminal through running, needs-input and back to nothing', () => {
    renderStrip();
    expect(dotOf('Claude Code')).toBeNull();
    act(() => setTerminalBusy('pty-claude', 'running'));
    expect(dotOf('Claude Code')).toHaveClass('bg-success', 'status-dot-live');
    act(() => setTerminalBusy('pty-claude', 'needs-input'));
    expect(dotOf('Claude Code')).toHaveClass('bg-warning', 'status-dot-live');
    expect(dotOf('Claude Code')).not.toHaveClass('bg-success');
    act(() => setTerminalBusy('pty-claude', null));
    expect(dotOf('Claude Code')).toBeNull();
  });

  it('keeps a still blue dot on a background tab that finished, until it is viewed', () => {
    renderStrip();
    act(() => setTerminalBusy('pty-shell', 'running'));
    act(() => noteTerminalFinished('pty-shell'));
    expect(dotOf('pnpm test')).toHaveClass('bg-info');
    expect(dotOf('pnpm test')).not.toHaveClass('status-dot-live');
    act(() => markTerminalSeen('pty-shell'));
    expect(dotOf('pnpm test')).toBeNull();
  });

  it('sits after the label and before the close button', () => {
    // The project-row position: the close button keeps its own slot, so the
    // dot never reads as the unsaved-file dot that lives inside it.
    renderStrip();
    act(() => setTerminalBusy('pty-claude', 'running'));
    const dot = dotOf('Claude Code')!;
    expect(dot.previousElementSibling).toHaveTextContent('Claude Code');
    expect(dot.nextElementSibling).toBe(screen.getByRole('button', { name: 'Close Claude Code' }));
  });

  it('never puts a status dot on an editor tab, even an unsaved one', () => {
    renderStrip(new Set(['file']));
    act(() => setTerminalBusy('pty-claude', 'running'));
    expect(dotOf('auth.ts')).toBeNull();
    // The unsaved dot is still there - inside the close button, not beside it.
    expect(screen.getByRole('button', { name: 'Close auth.ts (unsaved)' })).toBeInTheDocument();
  });
});

describe('PaneTabStrip context menu', () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const openMenuOn = async (title: string): Promise<HTMLElement> => {
    await user.pointer({ keys: '[MouseRight]', target: tab(title) });
    return screen.findByRole('menu');
  };

  it('reveals an editor tab’s file in the OS file manager', async () => {
    const api = stubApi();
    renderStrip();
    const menu = await openMenuOn('auth.ts');
    await user.click(within(menu).getByText(REVEAL_IN_OS_LABEL));
    expect(api.fs.showInFolder).toHaveBeenCalledWith('/repo/acme/auth.ts');
  });

  it('offers no OS reveal on a terminal tab - it has no file', async () => {
    stubApi();
    renderStrip();
    const menu = await openMenuOn('pnpm test');
    expect(within(menu).queryByText(REVEAL_IN_OS_LABEL)).not.toBeInTheDocument();
  });
});

describe('PaneTabStrip agent tabs', () => {
  const AGENT_TABS: Record<string, Tab> = {
    claude: TABS.claude,
    opencode: { id: 'opencode', kind: 'terminal', title: 'OpenCode 2', ptyId: 'pty-oc' },
    codex: { id: 'codex', kind: 'terminal', title: 'Codex', ptyId: 'pty-codex' },
    shell: TABS.shell,
  };
  const renderAgents = (onAddTemplateTerminal = vi.fn()) =>
    render(
      <PaneTabStrip
        pane={{
          type: 'pane',
          id: 'p1',
          tabs: ['claude', 'opencode', 'codex', 'shell'],
          activeTabId: 'claude',
        }}
        tabs={AGENT_TABS}
        isActivePane
        dirtyTabs={new Set()}
        cwd="/repo/acme"
        isWorktree={false}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onCloseTabs={vi.fn()}
        onOpenInWindow={vi.fn()}
        onAddTerminal={vi.fn()}
        onAddTemplateTerminal={onAddTemplateTerminal}
        onSplit={vi.fn()}
      />,
    );
  const iconOf = (title: string): Element | null => tab(title).querySelector('svg');

  it('gives Codex and OpenCode tabs their own agent glyph, as a Claude Code tab has', () => {
    // Codex and OpenCode tabs showed the plain terminal icon while Claude's had a glyph.
    renderAgents();
    expect(iconOf('OpenCode 2')).toHaveClass('lucide-code-xml');
    expect(iconOf('Codex')).toHaveClass('lucide-bot');
    expect(iconOf('Claude Code')).toHaveClass('lucide-sparkles');
    expect(iconOf('pnpm test')).toHaveClass('lucide-square-terminal');
  });

  it('offers OpenCode when the "+" is held, and opens a tab running it', async () => {
    vi.useFakeTimers();
    const onAddTemplateTerminal = vi.fn();
    renderAgents(onAddTemplateTerminal);
    const plus = screen.getByRole('button', { name: 'New terminal' });
    fireEvent.pointerDown(plus, { button: 0 });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.pointerUp(plus);
    vi.useRealTimers();
    const item = await screen.findByRole('menuitem', { name: 'OpenCode' });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(item);
    expect(onAddTemplateTerminal).toHaveBeenCalledWith('OpenCode', 'opencode');
  });
});
