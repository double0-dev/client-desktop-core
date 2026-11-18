import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { RotateCcw } from 'lucide-react';
import { alertDialog, confirmDialog } from '@renderer/components/ui/confirm-dialog';

/**
 * These dialogs mount their own one-off React roots into document.body rather
 * than rendering into an RTL container, so the tests query the whole document
 * and wait for the root to tear itself down between cases.
 *
 * Radix marks the body `pointer-events: none` while a modal is open, which
 * user-event's pointer check refuses to click through in jsdom - hence the
 * disabled check.
 */
const user = userEvent.setup({ pointerEventsCheck: 0 });

afterEach(async () => {
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

describe('confirmDialog', () => {
  it('shows the title and description', async () => {
    const answer = confirmDialog({ title: 'Delete file?', description: 'This cannot be undone.' });
    expect(await screen.findByText('Delete file?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('resolves true when the confirming action is taken', async () => {
    const answer = confirmDialog({ title: 'Delete file?' });
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));
    await expect(answer).resolves.toBe(true);
  });

  it('resolves false when cancelled', async () => {
    const answer = confirmDialog({ title: 'Delete file?' });
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toBe(false);
  });

  it('resolves false on Escape - dismissing is never a confirmation', async () => {
    const answer = confirmDialog({ title: 'Delete file?' });
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await expect(answer).resolves.toBe(false);
  });

  it('uses custom action labels', async () => {
    const answer = confirmDialog({
      title: 'Remove worktree?',
      confirmLabel: 'Remove anyway',
      cancelLabel: 'Keep it',
    });
    await user.click(await screen.findByRole('button', { name: 'Remove anyway' }));
    await expect(answer).resolves.toBe(true);
  });

  it('renders no description element when none is given', async () => {
    const answer = confirmDialog({ title: 'Delete file?' });
    await screen.findByRole('dialog');
    expect(screen.getByRole('dialog').textContent).toBe('Delete file?CancelConfirm');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('focuses the confirming action so Enter takes it', async () => {
    const answer = confirmDialog({ title: 'Delete file?' });
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    await waitFor(() => expect(confirm).toHaveFocus());
    await user.keyboard('{Enter}');
    await expect(answer).resolves.toBe(true);
  });

  it('reports the choice exactly once', async () => {
    // Clicking a button also fires Radix's onOpenChange(false); the guard must
    // keep that from resolving a second, contradictory answer.
    const answer = confirmDialog({ title: 'Delete file?' });
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    await user.click(confirm);
    await expect(answer).resolves.toBe(true);
    // The dialog is gone; a stray Escape afterwards changes nothing.
    await user.keyboard('{Escape}');
    await expect(answer).resolves.toBe(true);
  });

  it('shows the warning badge and repeats the glyph on the action when given an icon', async () => {
    // Without an icon the dialog is the plain title/description/footer shell.
    const plain = confirmDialog({ title: 'Delete file?' });
    expect((await screen.findByRole('dialog')).querySelectorAll('svg')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await plain;
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const answer = confirmDialog({
      title: 'Reset all settings?',
      confirmLabel: 'Reset settings',
      destructive: true,
      icon: RotateCcw,
    });
    const dialog = await screen.findByRole('dialog');
    // Badge beside the title + the glyph inside the confirming action.
    expect(dialog.querySelectorAll('svg')).toHaveLength(2);
    const confirm = screen.getByRole('button', { name: 'Reset settings' });
    expect(confirm.querySelector('svg')).not.toBeNull();
    await user.click(confirm);
    await expect(answer).resolves.toBe(true);
  });

  it('supports two dialogs in sequence', async () => {
    const first = confirmDialog({ title: 'First?' });
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));
    await expect(first).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const second = confirmDialog({ title: 'Second?' });
    expect(await screen.findByText('Second?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(second).resolves.toBe(false);
  });
});

describe('alertDialog', () => {
  it('offers only a dismissing action', async () => {
    const done = alertDialog({ title: 'Could not remove the worktree' });
    await screen.findByRole('dialog');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await done;
  });

  it('resolves when acknowledged', async () => {
    const done = alertDialog({ title: 'Heads up', description: 'The branch was not deleted.' });
    expect(await screen.findByText('The branch was not deleted.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await expect(done).resolves.toBeUndefined();
  });

  it('resolves on Escape too', async () => {
    const done = alertDialog({ title: 'Heads up' });
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await expect(done).resolves.toBeUndefined();
  });

  it('uses a custom dismiss label', async () => {
    const done = alertDialog({ title: 'Heads up', dismissLabel: 'Got it' });
    await user.click(await screen.findByRole('button', { name: 'Got it' }));
    await done;
  });
});
