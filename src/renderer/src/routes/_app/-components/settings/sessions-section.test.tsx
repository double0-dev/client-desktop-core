import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';

/**
 * Settings → Sessions (design `Screen/Settings - Sessions` + the
 * `Label/Settings · Sessions` states board). The delete rule is the one
 * setting here that loses anything, so a change that would delete archived
 * sessions at once asks first - and Cancel leaves the rule as it was.
 */

const DAY = 24 * 60 * 60 * 1000;
const { sessions } = vi.hoisted(() => ({ sessions: { rows: [] as Record<string, unknown>[] } }));
vi.mock('@renderer/lib/collections', () => ({ agentSessionsCollection: {} }));
vi.mock('@tanstack/react-db', () => ({ useLiveQuery: () => ({ data: sessions.rows }) }));

// Radix pins `pointer-events: none` on the body while the confirm is open.
const user = userEvent.setup({ pointerEventsCheck: 0 });

function archived(label: string, archivedAgoMs: number) {
  return {
    id: label,
    label,
    status: 'archived',
    updatedAt: new Date(),
    archivedAt: new Date(Date.now() - archivedAgoMs),
  };
}

const stopAll = vi.fn(async () => true);

// An imperative dialog unmounts its root 250 ms after it closes: wait it out,
// or React runs that update after this file's environment is gone and fails
// whichever file the worker runs next (CLAUDE.md › Testing gotchas).
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 300));
});

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
  stubAll();
  sessions.rows = [];
  stopAll.mockClear();
});

function stubAll() {
  stubApi({ sessions: { setKeepRunning: vi.fn(async () => {}), stopAll } });
}

async function renderSection() {
  const [{ SessionsSettingsSection }, store] = await Promise.all([
    import('@renderer/routes/_app/-components/settings/sessions-section'),
    import('@renderer/lib/settings/session-cleanup-settings'),
  ]);
  render(<SessionsSettingsSection />);
  return store;
}

const deleteSwitch = () => screen.getByRole('switch', { name: 'Delete archived sessions' });

describe('SessionsSettingsSection', () => {
  it('ships with archiving on and deleting off, the delete follow-ups inert', async () => {
    await renderSection();
    expect(screen.getByRole('switch', { name: 'Archive inactive sessions' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(deleteSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Delete after amount')).toBeDisabled();
    expect(screen.getByLabelText('Delete after unit')).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Remove its worktree too' })).toBeDisabled();
    expect(screen.getByLabelText('Archive after amount')).toBeEnabled();
  });

  it('turns deletion on without asking when nothing has expired', async () => {
    sessions.rows = [archived('fix-auth-tokens', 2 * DAY)];
    const store = await renderSection();
    await user.click(deleteSwitch());
    expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(store.getSessionCleanupSettings().autoDelete).toBe(true);
    expect(screen.getByLabelText('Delete after amount')).toBeEnabled();
  });

  it('asks before turning on a rule that deletes at once, and Cancel keeps it off', async () => {
    sessions.rows = [archived('fix-auth-tokens', 42 * DAY), archived('recent', 2 * DAY)];
    const store = await renderSection();
    await user.click(deleteSwitch());
    const dialog = await waitFor(() => {
      const d = document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
      expect(d).not.toBeNull();
      return d!;
    });
    expect(dialog).toHaveTextContent('Delete 1 archived session now?');
    // Only the expired one is named - the two-day-old one is kept.
    expect(dialog).toHaveTextContent(
      '“fix-auth-tokens” has been in the archive longer than 30 days',
    );
    expect(dialog).not.toHaveTextContent('recent');
    // Asking must not have applied the rule already.
    expect(store.getSessionCleanupSettings().autoDelete).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(deleteSwitch()).toHaveAttribute('aria-checked', 'false'));
    expect(store.getSessionCleanupSettings().autoDelete).toBe(false);
  });

  it('turns it on once confirmed', async () => {
    sessions.rows = [archived('fix-auth-tokens', 42 * DAY)];
    const store = await renderSection();
    await user.click(deleteSwitch());
    await user.click(await screen.findByRole('button', { name: /Turn on and delete/ }));
    await waitFor(() => expect(store.getSessionCleanupSettings().autoDelete).toBe(true));
  });

  it('asks again when shortening the time would delete more', async () => {
    sessions.rows = [archived('fix-auth-tokens', 10 * DAY)];
    const store = await renderSection();
    await user.click(deleteSwitch()); // nothing is 30 days old - no question
    expect(store.getSessionCleanupSettings().autoDelete).toBe(true);

    const amount = screen.getByLabelText('Delete after amount');
    await user.clear(amount);
    await user.paste('7');
    await user.tab();
    const dialog = await screen.findByText('Delete 1 archived session now?');
    expect(dialog).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(amount).toHaveValue('30'));
    expect(store.getSessionCleanupSettings().deleteAfter).toEqual({ amount: 30, unit: 'days' });
  });

  it('commits the amount on blur, clamped - never per keystroke', async () => {
    const store = await renderSection();
    const amount = screen.getByLabelText('Archive after amount');
    await user.clear(amount);
    await user.paste('5000');
    // Still typing: the rule has not moved (an interim "3" of "30" must never act).
    expect(store.getSessionCleanupSettings().archiveAfter.amount).toBe(7);
    await user.tab();
    expect(store.getSessionCleanupSettings().archiveAfter).toEqual({ amount: 999, unit: 'days' });
    expect(amount).toHaveValue('999');

    await user.selectOptions(screen.getByLabelText('Archive after unit'), 'hours');
    expect(store.getSessionCleanupSettings().archiveAfter).toEqual({ amount: 999, unit: 'hours' });
  });

  it('dims the archive time while archiving is off', async () => {
    await renderSection();
    await user.click(screen.getByRole('switch', { name: 'Archive inactive sessions' }));
    expect(screen.getByLabelText('Archive after amount')).toBeDisabled();
  });

  describe('after quit (a private plan)', () => {
    const keepSwitch = () =>
      screen.getByRole('switch', { name: 'Keep sessions running after quit' });

    it('keeps sessions running by default and turns the choice off on a click', async () => {
      await renderSection();
      const daemon = await import('@renderer/lib/settings/session-daemon-settings');
      expect(keepSwitch()).toHaveAttribute('aria-checked', 'true');
      await user.click(keepSwitch());
      expect(keepSwitch()).toHaveAttribute('aria-checked', 'false');
      expect(daemon.getSessionDaemonSettings().keepRunning).toBe(false);
    });

    it('stops every session only after the confirm, and Cancel stops nothing', async () => {
      await renderSection();
      await user.click(screen.getByRole('button', { name: 'Stop all' }));
      const dialog = await waitFor(() => {
        const d = document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
        expect(d).not.toBeNull();
        return d!;
      });
      expect(dialog).toHaveTextContent('Stop all sessions?');
      expect(stopAll).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() =>
        expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull(),
      );
      expect(stopAll).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Stop all' }));
      await user.click(await screen.findByRole('button', { name: 'Stop all sessions' }));
      await waitFor(() => expect(stopAll).toHaveBeenCalledTimes(1));
      // This machine only.
      expect(stopAll).toHaveBeenCalledWith(null);
    });

    // Stop all is per machine (plan 28 › spec 16): one row for this computer
    // and one per server, each stopping only its own machine's sessions.
    it('offers one Stop all per machine, each scoped to its host', async () => {
      window.localStorage.setItem(
        'double0-hosts',
        JSON.stringify([
          {
            id: 'build-box',
            label: 'Build box',
            target: 'emmaw@build-box',
            port: null,
            forwardAgent: false,
            useInstalledNode: false,
            addedAt: 1,
          },
        ]),
      );
      // The remote hosts are Pro (a private plan › M7): registered here, read
      // through the core host directory.
      const { installRendererExtension } = await import('@renderer/lib/extension/registry');
      installRendererExtension((await import('@renderer/test-support')).bridgeSlots());
      const hosts = [{ id: 'build-box', label: 'Build box' }];
      (await import('@renderer/lib/hosts/host-directory')).registerHostSource({
        list: () => hosts,
        subscribe: () => () => {},
      });
      const hostStatus = await import('@renderer/lib/hosts/host-status');
      const status = (state: 'connected' | 'unreachable') => ({
        id: 'build-box',
        state,
        message: null,
        details: null,
        facts: null,
        since: null,
      });
      hostStatus.applyHostStatuses([status('unreachable')]);
      await renderSection();
      expect(screen.getByText('Stop all on this machine')).toBeInTheDocument();
      expect(screen.getByText('Stop all on Build box')).toBeInTheDocument();
      let buttons = screen.getAllByRole('button', { name: 'Stop all' });
      expect(buttons).toHaveLength(2);
      // An unreachable host's sessions cannot be stopped: no button to press.
      expect(buttons[1]).toBeDisabled();
      expect(buttons[0]).toBeEnabled();
      act(() => hostStatus.applyHostStatuses([status('connected')]));
      buttons = screen.getAllByRole('button', { name: 'Stop all' });
      expect(buttons[1]).toBeEnabled();
      await user.click(buttons[1]);
      await user.click(await screen.findByRole('button', { name: 'Stop all on Build box' }));
      await waitFor(() => expect(stopAll).toHaveBeenCalledWith('build-box'));
      expect(stopAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('OLDER VERSIONS', () => {
    const OLD = '/tmp/d/daemon-v1-0.7.6.sock';
    const rows = (busy: number, terminals = 3) => [
      {
        socketPath: '/tmp/d/daemon-v1-0.7.7.sock',
        buildId: '0.7.7',
        current: true,
        terminals: 2,
        busy: 0,
      },
      { socketPath: OLD, buildId: '0.7.6', current: false, terminals, busy },
    ];

    it('is not there while no older version holds a terminal', async () => {
      stubApi({
        sessions: {
          setKeepRunning: vi.fn(async () => {}),
          stopAll,
          daemons: vi.fn(async () => rows(0, 0)),
        },
      });
      await renderSection();
      await act(async () => {});
      expect(screen.queryByText('OLDER VERSIONS')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Move now' })).toBeNull();
    });

    it('moves at once when nothing there is working', async () => {
      const moveDaemon = vi.fn(async () => ({ moved: 3, busy: 0, unresumable: 0, kept: 0 }));
      stubApi({
        sessions: {
          setKeepRunning: vi.fn(async () => {}),
          stopAll,
          daemons: vi.fn(async () => rows(0)),
          moveDaemon,
        },
      });
      await renderSection();
      expect(await screen.findByText('Still running on 0.7.6')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Move now' }));
      await waitFor(() => expect(moveDaemon).toHaveBeenCalledWith(OLD));
      expect(moveDaemon).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    });

    it('asks before restarting working sessions, and Cancel moves nothing', async () => {
      const moveDaemon = vi.fn(async (_path: string, includeBusy?: boolean) =>
        includeBusy
          ? { moved: 3, busy: 0, unresumable: 0, kept: 0 }
          : { moved: 0, busy: 1, unresumable: 0, kept: 0 },
      );
      stubApi({
        sessions: {
          setKeepRunning: vi.fn(async () => {}),
          stopAll,
          daemons: vi.fn(async () => rows(1)),
          moveDaemon,
        },
      });
      await renderSection();
      expect(
        await screen.findByText(/3 terminals kept running through an update - 1 working now/),
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Move now' }));
      // An imperative dialog mounts its own root: query off document.
      const open = () =>
        document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
      const dialog = await waitFor(() => {
        expect(open()).not.toBeNull();
        return open()!;
      });
      expect(dialog).toHaveTextContent('Restart 1 session on this version?');
      expect(dialog).toHaveTextContent('working or waiting on you');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(open()).toBeNull());
      expect(moveDaemon).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole('button', { name: 'Move now' }));
      await user.click(await screen.findByRole('button', { name: 'Move anyway' }));
      await waitFor(() => expect(moveDaemon).toHaveBeenLastCalledWith(OLD, true));
    });
  });
});
