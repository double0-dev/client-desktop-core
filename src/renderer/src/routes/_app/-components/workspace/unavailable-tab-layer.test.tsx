import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Tab, WorkspaceLayout } from '@renderer/lib/workspace/layout';
import { UnavailableTabLayer } from './unavailable-tab-layer';

// A tab of a kind this build does not render (a private plan › M0) shows a note
// over its pane while it is the pane's active tab - never a blank pane.

function layoutWith(tabs: Tab[], active: string): WorkspaceLayout {
  return {
    rootId: 'p1',
    activePaneId: 'p1',
    nodes: { p1: { id: 'p1', type: 'pane', tabs: tabs.map((t) => t.id), activeTabId: active } },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
  } as unknown as WorkspaceLayout;
}

const rects = new Map([['p1', { x: 0, y: 0, width: 800, height: 600 }]]);
const unknownTab = { id: 'u', kind: 'canvas', title: 'Board' } as unknown as Tab;
const terminal: Tab = { id: 't', kind: 'terminal', title: 'Terminal', ptyId: 'pty-t' };

describe('UnavailableTabLayer', () => {
  it('covers the pane while an unknown-kind tab is the active one', () => {
    render(
      <UnavailableTabLayer
        layout={layoutWith([terminal, unknownTab], 'u')}
        rects={rects}
        version={1}
        onActivatePane={vi.fn()}
      />,
    );
    expect(screen.getByTestId('unavailable-tab')).toBeInTheDocument();
    expect(screen.getByText('Not available in this build')).toBeInTheDocument();
  });

  it('shows nothing while a tab this build renders is active', () => {
    render(
      <UnavailableTabLayer
        layout={layoutWith([terminal, unknownTab], 't')}
        rects={rects}
        version={1}
        onActivatePane={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('unavailable-tab')).toBeNull();
  });

  it('renders nothing at all for a layout of known kinds', () => {
    const { container } = render(
      <UnavailableTabLayer
        layout={layoutWith([terminal], 't')}
        rects={rects}
        version={1}
        onActivatePane={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
