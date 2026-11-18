import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { confirmWorktreeSessionDelete } from '@renderer/components/worktree-delete-dialog';
import type { BusyTab } from '@renderer/lib/terminal/busy';

const user = userEvent.setup({ pointerEventsCheck: 0 });

const WORKTREE = '/Users/emmaw/code/production-pipeline/.worktree/fix-flaky-tests';

const open = (
  overrides: Partial<Parameters<typeof confirmWorktreeSessionDelete>[0]> = {},
): ReturnType<typeof confirmWorktreeSessionDelete> =>
  confirmWorktreeSessionDelete({ worktreePath: WORKTREE, branch: 'fix-flaky-tests', ...overrides });

/** The two opt-in checkboxes, in render order. */
const boxes = (): HTMLElement[] => within(screen.getByRole('dialog')).getAllByRole('checkbox');
const removeBox = (): HTMLElement => boxes()[0];
const branchBox = (): HTMLElement => boxes()[1];

const del = (): Promise<HTMLElement> => screen.findByRole('button', { name: /Delete session/ });

afterEach(async () => {
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

describe('what the dialog shows', () => {
  it('shortens the worktree path to its .worktree segment', async () => {
    const answer = open();
    expect(await screen.findByText('.worktree/fix-flaky-tests')).toBeInTheDocument();
    // The full path stays available as the title attribute.
    expect(screen.getByText('.worktree/fix-flaky-tests')).toHaveAttribute('title', WORKTREE);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('shows the full path when it is not under a .worktree dir', async () => {
    const answer = open({ worktreePath: '/tmp/detached-tree' });
    expect(await screen.findByText('/tmp/detached-tree')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('names the branch in the delete-branch option', async () => {
    const answer = open();
    expect(await screen.findByText(/Delete the branch/)).toHaveTextContent(
      'Delete the branch “fix-flaky-tests”',
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('lists busy tabs when the session still has work in flight', async () => {
    const busyTabs: BusyTab[] = [
      { title: 'Claude Code', status: 'needs-input' },
      { title: 'zsh', status: 'running' },
    ];
    const answer = open({ busyTabs });
    expect(await screen.findByText(/2 tabs are/)).toBeInTheDocument();
    expect(screen.getByText('Needs input')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('omits the busy card when nothing is busy', async () => {
    const answer = open({ busyTabs: [] });
    await screen.findByRole('dialog');
    expect(screen.queryByText(/still busy/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });
});

describe('default choices', () => {
  it('removes the worktree and deletes its branch', async () => {
    // The branch was created for the session, so it goes with it unless the
    // user un-ticks it.
    const answer = open();
    await screen.findByRole('dialog');
    expect(removeBox()).toHaveAttribute('aria-checked', 'true');
    expect(branchBox()).toHaveAttribute('aria-checked', 'true');

    await user.click(await del());
    await expect(answer).resolves.toEqual({ removeWorktree: true, deleteBranch: true });
  });

  it('keeps the branch when its box is un-ticked', async () => {
    const answer = open();
    await screen.findByRole('dialog');
    await user.click(branchBox());
    expect(branchBox()).toHaveAttribute('aria-checked', 'false');

    await user.click(await del());
    await expect(answer).resolves.toEqual({ removeWorktree: true, deleteBranch: false });
  });
});

describe('the branch option is gated on removing the worktree', () => {
  it('disables the branch box while the worktree is kept', async () => {
    const answer = open();
    await screen.findByRole('dialog');
    await user.click(removeBox());
    expect(removeBox()).toHaveAttribute('aria-checked', 'false');
    expect(branchBox()).toBeDisabled();

    await user.click(await del());
    await expect(answer).resolves.toEqual({ removeWorktree: false, deleteBranch: false });
  });

  it('disables it when the session has no branch', async () => {
    // git refuses to delete a branch checked out in a worktree, and there is no
    // branch to delete here anyway.
    const answer = open({ branch: null });
    await screen.findByRole('dialog');
    expect(branchBox()).toBeDisabled();
    await user.click(await del());
    await expect(answer).resolves.toEqual({ removeWorktree: true, deleteBranch: false });
  });

  it('drops the default branch choice when the worktree is un-ticked', async () => {
    // "Delete branch" starts ticked; untick "remove worktree": the resolved
    // choice must not still ask for a branch delete that git would refuse.
    const answer = open();
    await screen.findByRole('dialog');
    expect(branchBox()).toHaveAttribute('aria-checked', 'true');

    await user.click(removeBox());
    expect(branchBox()).toHaveAttribute('aria-checked', 'false');

    await user.click(await del());
    await expect(answer).resolves.toEqual({ removeWorktree: false, deleteBranch: false });
  });
});

describe('the label rows toggle their checkbox', () => {
  it('toggles the worktree option from its text', async () => {
    const answer = open();
    expect(await screen.findByText('Remove the worktree folder from disk')).toBeInTheDocument();
    await user.click(screen.getByText('Remove the worktree folder from disk'));
    expect(removeBox()).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('does not toggle the branch option while it is disabled', async () => {
    const answer = open({ branch: null });
    await screen.findByRole('dialog');
    await user.click(screen.getByText(/Delete the branch/));
    expect(branchBox()).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });
});

describe('cancelling', () => {
  it('resolves null from the Cancel action', async () => {
    const answer = open();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toBeNull();
  });

  it('resolves null on Escape', async () => {
    const answer = open();
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await expect(answer).resolves.toBeNull();
  });

  it('reports the choice exactly once', async () => {
    const answer = open();
    await user.click(await del());
    await expect(answer).resolves.toEqual({ removeWorktree: true, deleteBranch: true });
    await user.keyboard('{Escape}');
    await expect(answer).resolves.toEqual({ removeWorktree: true, deleteBranch: true });
  });
});
