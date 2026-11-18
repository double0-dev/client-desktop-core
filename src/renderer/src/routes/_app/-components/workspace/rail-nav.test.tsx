import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RailNav } from '@renderer/routes/_app/-components/workspace/rail-nav';
import { GitContext, type GitStatusValue } from '@renderer/lib/git/context';
import { setRailOrder } from '@renderer/lib/rail-order';

/**
 * The rail's count bubbles in the core build: Sessions (agents running right
 * now, from the workspace) - the number shown, and the "nothing pending ⇒
 * bare icon" rule that keeps a quiet rail quiet. Pro tools' bubbles are
 * tested beside them in pro/.
 */

/** A git context carrying `n` changed files and `ahead` commits its upstream
 * lacks - the badge only reads those. */
function gitWith(
  changedFiles: number,
  ahead = 0,
  upstream: string | null = 'origin/main',
): GitStatusValue {
  return {
    status: {
      files: Array.from({ length: changedFiles }, (_, i) => ({ path: `f${i}.ts` })),
      detached: false,
      upstream,
      ahead,
    },
  } as unknown as GitStatusValue;
}

function renderRail({
  runningSessions = 0,
  changedFiles = 0,
  ahead = 0,
  upstream = 'origin/main' as string | null,
}: {
  runningSessions?: number;
  changedFiles?: number;
  ahead?: number;
  upstream?: string | null;
} = {}) {
  return render(
    <GitContext.Provider value={gitWith(changedFiles, ahead, upstream)}>
      <RailNav
        dockPanels={[]}
        openOverlay={null}
        explorerOpen={false}
        bottomPanelOpen={false}
        runningSessions={runningSessions}
        projectId={null}
        onToggleDock={() => {}}
        onToggleBottomPanel={() => {}}
      />
    </GitContext.Provider>,
  );
}

/** The count bubble inside a rail tab, or null when the tab shows none. */
function badgeOf(tab: string): HTMLElement | null {
  const button = screen.getByRole('button', { name: tab });
  return within(button).queryByRole('status');
}

describe('rail count badges', () => {
  it('shows how many sessions are running', () => {
    renderRail({ runningSessions: 2 });
    expect(badgeOf('Sessions')).toHaveTextContent('2');
  });

  it('labels the sessions bubble for screen readers, singular and plural', () => {
    const { unmount } = renderRail({ runningSessions: 1 });
    expect(badgeOf('Sessions')).toHaveAccessibleName('1 running session');
    unmount();
    renderRail({ runningSessions: 3 });
    expect(badgeOf('Sessions')).toHaveAccessibleName('3 running sessions');
  });

  it('leaves the Sessions tab a bare icon when nothing is running', () => {
    // Every session idle is the common case - a permanent "0" would be noise.
    renderRail({ runningSessions: 0, changedFiles: 4 });
    expect(badgeOf('Sessions')).toBeNull();
  });

  it('shows no icon for a stored tool no extension registered', () => {
    // A rail order saved by a build with an extension names its tools; with no
    // registration there is no icon. `gadget` stands for any extension tool.
    setRailOrder({ top: ['gadget', 'projects', 'sessions'], bottom: [] });
    renderRail({ runningSessions: 1, changedFiles: 4 });
    expect(screen.queryByRole('button', { name: 'Gadget' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
  });

  it('caps a very large count so the bubble cannot swallow the rail', () => {
    renderRail({ runningSessions: 120 });
    expect(badgeOf('Sessions')).toHaveTextContent('99+');
  });
});
