import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitPullRequest } from 'lucide-react';
import type { ReactNode } from 'react';
import { DetachedWindow } from '@renderer/routes/_app/-components/workspace/detached-window';
import type { DetachedWindowPayload } from '@renderer/lib/transfer';
import type { GitStatus } from '@renderer/lib/git/types';
import { stubApi } from '@renderer/test-support';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import type { RailTool, SessionDrawerProps } from '@renderer/lib/extension/types';
import { GitStatusProvider } from '@renderer/routes/_app/-components/workspace/git-status-provider';
import { takeWorktreeReveal } from '@renderer/lib/worktree-reveal';

/**
 * The torn-off SESSION window carries the session-changes drawer, exactly like
 * the in-app workspace: the pane strip's file-diff toggle exists there, opens
 * the drawer, and its footer hands off to this window's own git tool. A
 * lone-terminal window has no session (and no git context), so it gets none of
 * this - the regression these guard is the drawer quietly existing only in the
 * main window, which is where it started. The drawer and the git tool are an
 * extension's: here they are stand-ins registered the way an extension
 * registers them, and a build without one shows neither.
 */

/** A stand-in for Pro's review drawer: its header, close and footer link. */
function FakeDrawer({ onClose, onOpenTool }: SessionDrawerProps) {
  return (
    <section>
      <h2>Session changes</h2>
      <button type="button" aria-label="Close session changes" onClick={onClose} />
      <button type="button" onClick={onOpenTool}>
        Open in Changes
      </button>
    </section>
  );
}

function PassThrough({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** The official build's git client, as far as this window's wiring sees it. */
function withGitClient(): void {
  const changesTool: RailTool = {
    id: 'changes',
    icon: GitPullRequest,
    label: 'Changes',
    Provider: PassThrough,
    DockPanel: () => <div data-testid="changes-dock-panel" />,
    View: () => <div data-testid="changes-view" />,
  };
  installRendererExtension({
    edition: 'pro',
    railTools: [changesTool],
    git: {
      tool: 'changes',
      Provider: GitStatusProvider,
      Drawer: FakeDrawer,
    },
  });
}

// The real body mounts xterm terminals; all the drawer wiring needs from it is
// the strip's toggle button, so mirror just that contract (same conditional as
// PaneTabStrip: no callback → no button). It also probes the layout the way
// the strip's "+" does - what a new terminal tab is titled and will run - so
// the session context handed to this window's provider can be checked.
vi.mock('@renderer/routes/_app/-components/workspace/workspace-body', async () => {
  const { useWorkspaceLayout } = await import('@renderer/lib/workspace/layout-context');
  const { allTabs } = await import('@renderer/lib/workspace/layout');
  return {
    WorkspaceBody: ({
      changesDrawerOpen,
      onToggleChangesDrawer,
    }: {
      changesDrawerOpen?: boolean;
      onToggleChangesDrawer?: () => void;
    }) => {
      const { layout, addTerminal } = useWorkspaceLayout();
      return (
        <div data-testid="workspace-body">
          {onToggleChangesDrawer && (
            <button
              type="button"
              aria-label="Session changes"
              aria-pressed={changesDrawerOpen}
              onClick={onToggleChangesDrawer}
            />
          )}
          <button type="button" aria-label="Add terminal" onClick={() => addTerminal()} />
          <ul>
            {allTabs(layout).map((t) => (
              <li key={t.id} data-testid={`tab-${t.kind}`}>
                {t.title}|{t.startupCommand ?? ''}
              </li>
            ))}
          </ul>
        </div>
      );
    },
  };
});
vi.mock('@renderer/routes/_app/-components/workspace/commands-dock', () => ({
  BottomPanel: () => null,
}));
vi.mock('@renderer/routes/_app/-components/workspace/workspace-shortcuts', () => ({
  WorkspaceShortcuts: () => null,
}));
// The session's live row, as the shared collection would serve it. Empty by
// default (projectId/worktree resolve to their null defaults); the "+" tests
// seed the torn-off session's row.
const { liveRows } = vi.hoisted(() => ({ liveRows: [] as unknown[] }));
vi.mock('@renderer/lib/collections', () => ({ agentSessionsCollection: { get: () => undefined } }));
// "+" pulls an archived session back out of the archive on its way through the
// provider; nothing here archives one, so it's a no-op.
vi.mock('@renderer/lib/session/unarchive', () => ({ unarchiveSession: vi.fn(() => false) }));
vi.mock('@tanstack/react-db', () => ({ useLiveQuery: () => ({ data: liveRows }) }));

const ROOT = '/repo/acme';

const STATUS: GitStatus = {
  repo: true,
  branch: 'fix-auth-tokens',
  detached: false,
  upstream: 'origin/fix-auth-tokens',
  ahead: 0,
  behind: 0,
  files: [],
  userName: 'Emma Wilson',
  userEmail: 'emmaw@example.com',
  mergeMsg: null,
};

const EMPTY_REFS = {
  repo: true,
  branches: [],
  remotes: [],
  worktrees: [],
  stashes: [],
  tags: [],
  fetchedAt: null,
};

function install() {
  return stubApi({
    git: {
      status: vi.fn(async () => ({ status: STATUS })),
      watch: vi.fn(async () => ({ ok: true })),
      unwatch: vi.fn(async () => ({ ok: true })),
      onChanged: vi.fn(() => () => {}),
      numstat: vi.fn(async () => ({ entries: [] })),
      refs: vi.fn(async () => ({ refs: EMPTY_REFS })),
      log: vi.fn(async () => ({ log: { repo: true, commits: [] } })),
      refsTrack: vi.fn(async () => ({ track: {} })),
      logTotal: vi.fn(async () => ({ total: 0 })),
      pruneRemotes: vi.fn(async () => ({ pruned: [] })),
      fetch: vi.fn(async () => ({ ok: true })),
      locate: vi.fn(async () => ({ sha: 'a1b2c3d', index: 0 })),
    },
    integrations: {
      getAll: vi.fn(async () => ({ states: null })),
      onChanged: vi.fn(() => () => {}),
      commitAvatars: vi.fn(async () => ({ avatars: {} })),
    },
    session: { syncLayout: vi.fn() },
    tab: { syncLayout: vi.fn() },
  });
}

const SESSION_PAYLOAD: DetachedWindowPayload = {
  kind: 'session',
  session: {
    kind: 'session',
    projectId: null,
    sessionId: 'session-1',
    label: 'auth work',
    projectName: 'acme',
    layout: null,
    cwd: ROOT,
    commandDock: null,
  },
};

const TAB_PAYLOAD: DetachedWindowPayload = {
  kind: 'detached',
  tab: { kind: 'terminal', termId: 'term-1', title: 'Terminal', cwd: ROOT },
};

beforeEach(() => {
  localStorage.clear();
  liveRows.length = 0;
});
afterEach(() => resetRendererExtensionForTest());

describe('the detached session window', () => {
  it('offers the session-changes toggle and opens the drawer with it', async () => {
    install();
    withGitClient();
    const user = userEvent.setup();
    render(<DetachedWindow payload={SESSION_PAYLOAD} />);

    const toggle = screen.getByRole('button', { name: 'Session changes' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);

    expect(screen.getByText('Session changes')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Close session changes' }));
    expect(screen.queryByText('Session changes')).not.toBeInTheDocument();
  });

  it('hands the drawer footer off to this window’s Changes overlay', async () => {
    install();
    withGitClient();
    const user = userEvent.setup();
    render(<DetachedWindow payload={SESSION_PAYLOAD} />);

    await user.click(screen.getByRole('button', { name: 'Session changes' }));
    await user.click(screen.getByRole('button', { name: /Open in Changes/ }));

    // The overlay opens IN THIS WINDOW (no hand-off to the app window exists
    // here), with the session's branch reveal requested - the same flow the
    // app window runs.
    expect(screen.getByTestId('changes-view')).toBeInTheDocument();
    expect(screen.getByTestId('changes-dock-panel')).toBeInTheDocument();
    // The reveal Pro's provider consumes (it selects the session's branch).
    expect(takeWorktreeReveal(ROOT)).toBe(true);
  });

  it('has no drawer toggle and no git tool where no extension registered one', async () => {
    // Nothing registered: the status-only provider, no git client.
    install();
    render(<DetachedWindow payload={SESSION_PAYLOAD} />);
    expect(screen.queryByRole('button', { name: 'Session changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
  });

  it('gives a lone terminal window no toggle - there is no session to diff', () => {
    install();
    render(<DetachedWindow payload={TAB_PAYLOAD} />);
    expect(screen.queryByRole('button', { name: 'Session changes' })).not.toBeInTheDocument();
  });
});

describe('what the torn-off session window’s "+" opens', () => {
  // The session row as the app window sees it - the same context its provider
  // gets (agent label, start command, "run on new terminals").
  const ROW = {
    id: 'session-1',
    projectId: 'project-1',
    label: 'auth work',
    agent: 'Claude Code',
    startCommand: 'claude',
    runOnNewTerminal: true,
    worktreePath: null,
    status: 'idle',
  };

  it('inherits the session’s start command, like the app window', async () => {
    liveRows.push(ROW);
    install();
    const user = userEvent.setup();
    render(<DetachedWindow payload={SESSION_PAYLOAD} />);

    // A never-opened session arrives with no live layout; its fallback
    // conversation tab is bare until the row titles + commands it.
    await waitFor(() =>
      expect(screen.getByTestId('tab-conversation')).toHaveTextContent('Claude Code|claude'),
    );
    await user.click(screen.getByRole('button', { name: 'Add terminal' }));
    await waitFor(() =>
      expect(screen.getByTestId('tab-terminal')).toHaveTextContent('Claude Code 2|claude'),
    );
  });

  it('opens a plain shell when the session opted out of running it on new terminals', async () => {
    liveRows.push({ ...ROW, runOnNewTerminal: false });
    install();
    const user = userEvent.setup();
    render(<DetachedWindow payload={SESSION_PAYLOAD} />);

    await waitFor(() =>
      expect(screen.getByTestId('tab-conversation')).toHaveTextContent('Claude Code|claude'),
    );
    await user.click(screen.getByRole('button', { name: 'Add terminal' }));
    await waitFor(() => expect(screen.getByTestId('tab-terminal')).toHaveTextContent('Terminal|'));
  });

  it('gives a lone terminal window no session context to inherit', async () => {
    liveRows.push(ROW);
    install();
    const user = userEvent.setup();
    render(<DetachedWindow payload={TAB_PAYLOAD} />);

    await user.click(screen.getByRole('button', { name: 'Add terminal' }));
    await waitFor(() => expect(screen.getAllByTestId('tab-terminal')).toHaveLength(2));
    expect(screen.getAllByTestId('tab-terminal')[1]).toHaveTextContent('Terminal 2|');
  });
});
