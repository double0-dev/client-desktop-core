import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BusyTabsCard,
  confirmCloseBusyTab,
  confirmCloseBusyTabs,
  confirmDeleteBusySession,
} from '@renderer/components/busy-tabs-dialog';
import type { BusyTab } from '@renderer/lib/terminal/busy';

const user = userEvent.setup({ pointerEventsCheck: 0 });

const agentTab: BusyTab = { title: 'Claude Code', status: 'running' };
const askingTab: BusyTab = { title: 'Claude Code', status: 'needs-input' };
const shellTab: BusyTab = { title: 'zsh', status: 'running' };

afterEach(async () => {
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

describe('BusyTabsCard', () => {
  it('uses singular wording for one tab', () => {
    render(<BusyTabsCard tabs={[agentTab]} />);
    expect(screen.getByText(/1 tab is/)).toBeInTheDocument();
  });

  it('uses plural wording and lists every tab', () => {
    render(<BusyTabsCard tabs={[agentTab, shellTab]} />);
    expect(screen.getByText(/2 tabs are/)).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('zsh')).toBeInTheDocument();
  });

  it('labels each tab by its status', () => {
    render(<BusyTabsCard tabs={[askingTab, shellTab]} />);
    expect(screen.getByText('Needs input')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });
});

describe('confirmCloseBusyTab - one tab', () => {
  it('says the agent is working when it is mid-turn', async () => {
    const answer = confirmCloseBusyTab({ tab: agentTab });
    expect(await screen.findByText(/Claude Code is still working in this tab/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('says the agent is waiting when it asked a question', async () => {
    const answer = confirmCloseBusyTab({ tab: askingTab });
    expect(
      await screen.findByText(/Claude Code is waiting for your input in this tab/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('uses neutral wording for a plain shell', async () => {
    const answer = confirmCloseBusyTab({ tab: shellTab });
    expect(await screen.findByText(/This tab is still busy/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('shows the question the agent is blocked on', async () => {
    const answer = confirmCloseBusyTab({
      tab: askingTab,
      detail: 'Do you want to proceed with the migration?',
    });
    expect(
      await screen.findByText('Do you want to proceed with the migration?'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await answer;
  });

  it('resolves true when closing anyway', async () => {
    const answer = confirmCloseBusyTab({ tab: agentTab });
    await user.click(await screen.findByRole('button', { name: /Close tab/ }));
    await expect(answer).resolves.toBe(true);
  });

  it('resolves false when cancelled', async () => {
    const answer = confirmCloseBusyTab({ tab: agentTab });
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toBe(false);
  });

  it('resolves false on Escape - the default is to keep the work running', async () => {
    const answer = confirmCloseBusyTab({ tab: agentTab });
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await expect(answer).resolves.toBe(false);
  });
});

describe('confirmCloseBusyTabs - bulk close', () => {
  it('lists every busy tab being closed', async () => {
    const answer = confirmCloseBusyTabs({ tabs: [agentTab, shellTab] });
    expect(await screen.findByText('Close tabs?')).toBeInTheDocument();
    expect(screen.getByText(/2 tabs are/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Close tabs/ }));
    await expect(answer).resolves.toBe(true);
  });

  it('resolves false when cancelled', async () => {
    const answer = confirmCloseBusyTabs({ tabs: [agentTab] });
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toBe(false);
  });
});

describe('confirmDeleteBusySession', () => {
  it('warns that deleting ends the busy tabs', async () => {
    const answer = confirmDeleteBusySession({ tabs: [agentTab] });
    expect(await screen.findByText('Delete session?')).toBeInTheDocument();
    expect(screen.getByText(/still has busy tabs/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Delete session/ }));
    await expect(answer).resolves.toBe(true);
  });

  it('resolves false when cancelled', async () => {
    const answer = confirmDeleteBusySession({ tabs: [agentTab] });
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toBe(false);
  });
});
