import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';

vi.mock('@tanstack/react-db', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-db')>()),
  useLiveQuery: () => ({ data: [] }),
}));
import { NewProjectDialog } from './new-project-dialog';

/** Radix blanks body pointer-events while the dialog is open. */
const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

const nameField = () => screen.getByLabelText('Project name') as HTMLInputElement;

/**
 * The core build: every project lives on this computer (an extension's
 * machine picker is tested with that extension).
 */
describe('NewProjectDialog - the name follows the picked folder', () => {
  beforeEach(() => {
    stubApi({ selectDirectory: vi.fn(async () => '/Users/emmaw/Code/production-pipeline') });
  });

  it('fills the name from a folder picked on this computer', async () => {
    const user = setup();
    render(<NewProjectDialog open onOpenChange={() => {}} onCreate={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Browse/ }));
    expect(nameField().value).toBe('production-pipeline');
  });

  it('never overwrites a name the user typed', async () => {
    const user = setup();
    render(<NewProjectDialog open onOpenChange={() => {}} onCreate={() => {}} />);
    await user.click(nameField());
    await user.paste('pipeline-v2');
    await user.click(screen.getByRole('button', { name: /Browse/ }));
    expect(nameField().value).toBe('pipeline-v2');
  });

  it('offers no machine to pick', () => {
    render(<NewProjectDialog open onOpenChange={() => {}} onCreate={() => {}} />);
    // The dialog has no choice group of its own: any would be a machine picker.
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});
