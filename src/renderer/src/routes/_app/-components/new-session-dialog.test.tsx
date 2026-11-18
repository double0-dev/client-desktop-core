import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetHostStatusesForTest } from '@renderer/lib/hosts/host-status';

import {
  NewSessionDialog,
  type EditableSession,
} from '@renderer/routes/_app/-components/new-session-dialog';

/**
 * The session name is optional when CREATING - an unnamed session auto-names
 * itself from its terminal title (see lib/session/auto-name.ts) - but stays
 * required when EDITING, where a session always has a label to keep.
 */

/** Radix blanks body pointer-events while the dialog is open. */
const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

function renderCreate() {
  const onLaunch = vi.fn();
  render(<NewSessionDialog open onOpenChange={() => {}} onLaunch={onLaunch} />);
  return { onLaunch };
}

const EDIT_SESSION: EditableSession = {
  label: 'fix-auth',
  agent: 'Claude Code',
  startCommand: 'claude',
};

describe('NewSessionDialog - the core build', () => {
  it('offers no runtime choice: a session runs in a terminal', async () => {
    // An extension's runtime choice is tested with that extension.
    const user = setup();
    const { onLaunch } = renderCreate();
    // The dialog has no choice group of its own: any would be an extension's.
    expect(screen.queryByRole('radiogroup')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Launch session/ }));
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: null, openInView: false }),
    );
  });
});

describe('NewSessionDialog - optional name', () => {
  it('launches without a name', async () => {
    const user = setup();
    const { onLaunch } = renderCreate();

    const launch = screen.getByRole('button', { name: /Launch session/ });
    expect(launch).toBeEnabled();
    await user.click(launch);

    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ name: '' }));
  });

  it('still passes a typed name through trimmed', async () => {
    const user = setup();
    const { onLaunch } = renderCreate();

    await user.click(screen.getByPlaceholderText('fix-auth-tokens'));
    await user.paste('  fix auth tokens  ');
    await user.click(screen.getByRole('button', { name: /Launch session/ }));

    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ name: 'fix auth tokens' }));
  });

  it('marks the name Optional when creating - alongside the start command tag', () => {
    renderCreate();
    expect(screen.getAllByText('Optional')).toHaveLength(2);
  });

  it('editing still requires a name, and drops the Optional tag', async () => {
    const user = setup();
    const onSave = vi.fn();
    render(
      <NewSessionDialog open onOpenChange={() => {}} editSession={EDIT_SESSION} onSave={onSave} />,
    );

    // Only the start command keeps its tag while editing.
    expect(screen.getAllByText('Optional')).toHaveLength(1);
    await user.clear(screen.getByPlaceholderText('fix-auth-tokens'));

    expect(screen.getByRole('button', { name: /Save changes/ })).toBeDisabled();
  });
});

describe('NewSessionDialog - worktree setup prefill (Settings → Worktrees)', () => {
  const SETUP = {
    projectName: 'production-pipeline',
    setup: {
      worktreeCopyPaths: ['.env', '.env.local', 'dist/'],
      worktreeSetupCommand: 'pnpm install',
    },
  };

  it('explains what the worktree gets and prefills the setup command', async () => {
    const user = setup();
    const onLaunch = vi.fn();
    render(
      <NewSessionDialog open onOpenChange={() => {}} onLaunch={onLaunch} worktreeSetup={SETUP} />,
    );
    expect(
      screen.getByText(
        /production-pipeline copies 3 ignored entries \(\.env, \.env\.local, …\) and runs pnpm install first/,
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: /create a git worktree/i }));
    expect((screen.getByLabelText('Setup command') as HTMLInputElement).value).toBe('pnpm install');
    await user.click(screen.getByRole('button', { name: /launch session/i }));
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: true, setupCommand: 'pnpm install' }),
    );
  });

  it('says nothing and starts empty for a project that is not set up', async () => {
    const user = setup();
    render(
      <NewSessionDialog
        open
        onOpenChange={() => {}}
        onLaunch={vi.fn()}
        worktreeSetup={{
          projectName: 'acme',
          setup: { worktreeCopyPaths: [], worktreeSetupCommand: null },
        }}
      />,
    );
    expect(screen.queryByText(/Settings → Worktrees/)).toBeNull();
    await user.click(screen.getByRole('switch', { name: /create a git worktree/i }));
    expect((screen.getByLabelText('Setup command') as HTMLInputElement).value).toBe('');
  });
});

describe('NewSessionDialog - a project on a remote host', () => {
  afterEach(() => {
    resetHostStatusesForTest();
    // Later suites read the bundled list (no bridge).
    delete (window as { api?: unknown }).api;
  });

  // M2: git runs on the host through main, so a remote project's session gets
  // the same worktree flow as a local one.
  it('offers the worktree like a local project', async () => {
    const user = setup();
    const onLaunch = vi.fn();
    render(<NewSessionDialog open onOpenChange={() => {}} onLaunch={onLaunch} hostId="h1" />);
    const toggle = screen.getByRole('switch', { name: /create a git worktree/i });
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: /launch session/i }));
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ worktree: true }));
  });
});

describe('NewSessionDialog - agent label of a typed start command', () => {
  async function launchWith(command: string) {
    const user = setup();
    const { onLaunch } = renderCreate();
    await user.clear(screen.getByLabelText('Start command'));
    await user.paste(command);
    await user.click(screen.getByRole('button', { name: /Launch session/ }));
    return onLaunch;
  }

  it('labels a Claude wrapper command as Claude Code', async () => {
    // `claude-personal` matches no chip; it used to launch as "Custom", so the
    // tab lost the Claude icon and "+" terminals read "Custom 2".
    const onLaunch = await launchWith('claude-personal');
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ startCommand: 'claude-personal', agentLabel: 'Claude Code' }),
    );
  });

  it('still labels any other command as Custom', async () => {
    const onLaunch = await launchWith('npm run dev');
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ agentLabel: 'Custom' }));
  });

  it('re-resolves a stored Custom label on save, even with the command unchanged', async () => {
    // A session launched as "Custom" before wrappers were recognised: saving it
    // from the Edit dialog is how it picks up the Claude label.
    const user = setup();
    const onSave = vi.fn();
    render(
      <NewSessionDialog
        open
        onOpenChange={() => {}}
        editSession={{ label: 'fix-auth', agent: 'Custom', startCommand: 'claude-personal' }}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ agentLabel: 'Claude Code' }));
  });

  it('keeps a named label on save when the command is unchanged', async () => {
    // A deleted template's name is still the session's label - a rename must
    // not re-derive it.
    const user = setup();
    const onSave = vi.fn();
    render(
      <NewSessionDialog
        open
        onOpenChange={() => {}}
        editSession={{ label: 'fix-auth', agent: 'My Rig', startCommand: 'claude-personal' }}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ agentLabel: 'My Rig' }));
  });
});
