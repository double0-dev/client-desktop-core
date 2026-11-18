import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LayoutGeometry } from '@renderer/routes/_app/-components/workspace/layout-geometry';
import type { WorkspaceLayout } from '@renderer/lib/workspace/layout';
import { fakeLayoutContext, withLayout } from '@renderer/test-support';

/**
 * An emptied pane shows the "No tabs open" state with a New terminal button
 * (design: `Screen/Workspace - No Tabs`).
 */

// What `collapseEmpty` leaves once the last tab closes: one empty root pane.
const EMPTY: WorkspaceLayout = {
  rootId: 'root:session-1',
  nodes: { 'root:session-1': { type: 'pane', id: 'root:session-1', tabs: [], activeTabId: '' } },
  tabs: {},
  activePaneId: 'root:session-1',
};

function renderGeometry(layout: WorkspaceLayout) {
  const ctx = fakeLayoutContext('session-1', { layout });
  render(
    <LayoutGeometry
      registerPane={() => () => {}}
      cwd="/repo/acme"
      isWorktree={false}
      onOpenTabInWindow={() => {}}
      hideTabStrips
    />,
    { wrapper: withLayout(ctx) },
  );
  return ctx;
}

describe('LayoutGeometry empty pane', () => {
  it('opens a terminal in the emptied pane from the New terminal button', async () => {
    const ctx = renderGeometry(EMPTY);
    expect(screen.getByRole('heading', { name: 'No tabs open' })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'New terminal' }));

    expect(ctx.addTerminal).toHaveBeenCalledTimes(1);
    expect(ctx.addTerminal).toHaveBeenCalledWith('root:session-1');
  });

  it('keeps the button clickable inside the pointer-events-none geometry layer', () => {
    // jsdom does not apply pointer-events, so this is the only guard: without
    // the opt-in the whole geometry layer lets clicks fall through to the
    // (empty) terminal layer and the button looks right but never fires.
    renderGeometry(EMPTY);
    expect(screen.getByRole('button', { name: 'New terminal' })).toHaveClass('pointer-events-auto');
  });

  it('shows no empty state while the pane has tabs', () => {
    renderGeometry({
      rootId: 'p1',
      nodes: { p1: { type: 'pane', id: 'p1', tabs: ['shell'], activeTabId: 'shell' } },
      tabs: { shell: { id: 'shell', kind: 'terminal', title: 'Terminal', ptyId: 'pty-shell' } },
      activePaneId: 'p1',
    });
    expect(screen.queryByRole('button', { name: 'New terminal' })).toBeNull();
  });
});
