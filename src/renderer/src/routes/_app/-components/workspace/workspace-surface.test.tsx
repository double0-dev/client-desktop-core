import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStatusBar } from '@renderer/routes/_app/-components/workspace/workspace-surface';
import { GitContext, type GitStatusValue } from '@renderer/lib/git/context';
import type { GitStatus } from '@renderer/lib/git/types';
import { fakeLayoutContext, withLayout } from '@renderer/test-support';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';

/**
 * The status bar's git segment. It reports the checkout the workspace is
 * pointed at - a session named "auth work" sitting on `fix-auth-tokens` has to
 * read `fix-auth-tokens`, because that is what a commit from here lands on.
 */

const REPO: GitStatus = {
  repo: true,
  branch: 'fix-auth-tokens',
  detached: false,
  upstream: 'origin/fix-auth-tokens',
  ahead: 0,
  behind: 0,
  files: [],
  userName: 'Emma Wilson',
  userEmail: 'emmaw@acme.dev',
  mergeMsg: null,
};

function renderBar(status: GitStatus | null) {
  render(
    <GitContext.Provider value={{ status } as unknown as GitStatusValue}>
      <WorkspaceStatusBar sessionPath="/Users/emmaw/code/production-pipeline/.worktree/fix-auth" />
    </GitContext.Provider>,
    { wrapper: withLayout(fakeLayoutContext()) },
  );
}

describe('the workspace status bar', () => {
  it('names the checked-out branch, not the session', () => {
    renderBar(REPO);
    expect(screen.getByTitle('fix-auth-tokens')).toHaveTextContent('fix-auth-tokens');
  });

  it('re-reads the branch when the checkout moves under the session', () => {
    // A `git checkout` in one of the session's terminals refreshes the git
    // status; the bar has no name of its own to fall back on and must follow.
    const { rerender } = render(
      <GitContext.Provider value={{ status: REPO } as unknown as GitStatusValue}>
        <WorkspaceStatusBar sessionPath={null} />
      </GitContext.Provider>,
      { wrapper: withLayout(fakeLayoutContext()) },
    );
    rerender(
      <GitContext.Provider
        value={{ status: { ...REPO, branch: 'main' } } as unknown as GitStatusValue}
      >
        <WorkspaceStatusBar sessionPath={null} />
      </GitContext.Provider>,
    );
    expect(screen.getByTitle('main')).toBeInTheDocument();
    expect(screen.queryByTitle('fix-auth-tokens')).not.toBeInTheDocument();
  });

  it('says so on a detached HEAD, which has no branch to name', () => {
    renderBar({ ...REPO, branch: null, detached: true });
    expect(screen.getByTitle('detached HEAD')).toBeInTheDocument();
  });

  it('drops the segment outside a repo and while the status loads', () => {
    // Nothing is checked out, so an empty branch chip next to a git icon would
    // only read as a bug. The rest of the bar still renders.
    renderBar({ ...REPO, repo: false, branch: null });
    expect(document.querySelector('.lucide-git-branch')).toBeNull();
    expect(screen.getByText('1 terminal')).toBeInTheDocument();

    renderBar(null);
    expect(document.querySelector('.lucide-git-branch')).toBeNull();
  });
});

describe("the workspace status bar's extension items", () => {
  afterEach(() => resetRendererExtensionForTest());

  it('shows none without an extension', () => {
    // The core build's bar ends with the Inputs list: nothing after it.
    renderBar(REPO);
    expect(screen.queryByTestId('gadget-item')).toBeNull();
  });

  it("renders the extension's items for the focused tab and the session's folder", () => {
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      statusBarItems: [
        ({ focusedPtyId, sessionPath }) => (
          <span data-testid="gadget-item">{`${focusedPtyId ?? 'none'} ${sessionPath ?? '-'}`}</span>
        ),
      ],
    });
    render(
      <GitContext.Provider value={{ status: REPO } as unknown as GitStatusValue}>
        <WorkspaceStatusBar sessionPath="/Users/emmaw/code/acme" />
      </GitContext.Provider>,
      { wrapper: withLayout(fakeLayoutContext()) },
    );
    const item = screen.getByTestId('gadget-item');
    // fakeLayoutContext's one tab is the conversation shell: the item speaks for it.
    expect(item).toHaveTextContent('conversation:session-1 /Users/emmaw/code/acme');
  });
});
