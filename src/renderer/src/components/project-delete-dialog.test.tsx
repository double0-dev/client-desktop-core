import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  confirmProjectDelete,
  type ProjectDeleteSessionRow,
} from '@renderer/components/project-delete-dialog';

const user = userEvent.setup({ pointerEventsCheck: 0 });

const WT1 = '/Users/emmaw/code/production-pipeline/.worktree/fix-auth-tokens';
const WT2 = '/Users/emmaw/code/production-pipeline/.worktree/add-retry-to-sync';

const SESSIONS: ProjectDeleteSessionRow[] = [
  { label: 'Fix auth tokens', agent: 'Claude Code', worktreePath: WT1, busy: 'running' },
  { label: 'Add retry to sync', agent: 'Claude Code', worktreePath: WT2, busy: null },
  { label: 'Terminal', agent: 'Terminal', worktreePath: null, busy: null },
];

const open = (
  overrides: Partial<Parameters<typeof confirmProjectDelete>[0]> = {},
): ReturnType<typeof confirmProjectDelete> =>
  confirmProjectDelete({ projectName: 'acme', sessions: SESSIONS, ...overrides });

/** The two opt-in checkboxes, in render order. */
const boxes = (): HTMLElement[] => within(screen.getByRole('dialog')).getAllByRole('checkbox');
const removeBox = (): HTMLElement => boxes()[0];
const branchBox = (): HTMLElement => boxes()[1];

const del = (): Promise<HTMLElement> => screen.findByRole('button', { name: /Delete project/ });

afterEach(async () => {
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

describe('what the dialog shows', () => {
  it('lists every session and counts the busy ones', async () => {
    const answer = open();
    expect(
      await screen.findByText(/3 sessions will be deleted - 1 is still busy/),
    ).toBeInTheDocument();
    expect(screen.getByText('Fix auth tokens')).toBeInTheDocument();
    expect(screen.getByText('Add retry to sync')).toBeInTheDocument();
    expect(screen.getByText('Terminal')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('shows each worktree by its shortened path', async () => {
    const answer = open();
    expect(await screen.findByText('.worktree/fix-auth-tokens')).toHaveAttribute('title', WT1);
    expect(screen.getByText('.worktree/add-retry-to-sync')).toHaveAttribute('title', WT2);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('omits the busy count when nothing is busy', async () => {
    const answer = open({
      sessions: SESSIONS.map((s) => ({ ...s, busy: null })),
    });
    expect(await screen.findByText(/3 sessions will be deleted$/)).toBeInTheDocument();
    expect(screen.queryByText(/still busy/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('hides the worktree card and options when no session has a worktree', async () => {
    const answer = open({
      sessions: [{ label: 'Terminal', agent: 'Terminal', worktreePath: null, busy: null }],
    });
    await screen.findByRole('dialog');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/worktree/)).not.toBeInTheDocument();

    // Without worktrees there's no cleanup to opt into.
    await user.click(await del());
    await expect(answer).resolves.toEqual({ removeWorktrees: false, deleteBranches: false });
  });
});

describe('default choices', () => {
  it('removes the worktrees and deletes their branches', async () => {
    const answer = open();
    await screen.findByRole('dialog');
    expect(removeBox()).toHaveAttribute('aria-checked', 'true');
    expect(branchBox()).toHaveAttribute('aria-checked', 'true');

    await user.click(await del());
    await expect(answer).resolves.toEqual({ removeWorktrees: true, deleteBranches: true });
  });

  it('keeps the branches when their box is un-ticked', async () => {
    const answer = open();
    await screen.findByRole('dialog');
    await user.click(branchBox());
    expect(branchBox()).toHaveAttribute('aria-checked', 'false');

    await user.click(await del());
    await expect(answer).resolves.toEqual({ removeWorktrees: true, deleteBranches: false });
  });
});

describe('the branch option is gated on removing the worktrees', () => {
  it('disables the branch box while the worktrees are kept', async () => {
    const answer = open();
    await screen.findByRole('dialog');
    await user.click(removeBox());
    expect(removeBox()).toHaveAttribute('aria-checked', 'false');
    expect(branchBox()).toBeDisabled();

    await user.click(await del());
    await expect(answer).resolves.toEqual({ removeWorktrees: false, deleteBranches: false });
  });

  it('drops the default branch choice when the worktrees are un-ticked', async () => {
    const answer = open();
    await screen.findByRole('dialog');
    expect(branchBox()).toHaveAttribute('aria-checked', 'true');

    await user.click(removeBox());
    expect(branchBox()).toHaveAttribute('aria-checked', 'false');

    await user.click(await del());
    await expect(answer).resolves.toEqual({ removeWorktrees: false, deleteBranches: false });
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
});
