import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';

/**
 * The once-ever kept-running banner: shows what the daemon kept across the
 * last quit, Settings opens Settings › Sessions (where the Keep-running switch
 * lives) and hides it, × hides it.
 */

const S1 = '11111111-1111-4111-8111-111111111111';

async function mount(answer: { terminalIds: string[] } | null) {
  stubApi({
    sessions: {
      setKeepRunning: vi.fn(),
      stopAll: vi.fn(),
      launchNotice: vi.fn(async () => answer),
    },
    layout: { list: vi.fn(async () => []), save: vi.fn() },
  });
  const openSettings = await import('@renderer/lib/settings/open-settings');
  const opener = vi.fn();
  openSettings.registerSettingsOpener(opener);
  const { KeptRunningBanner } = await import('./kept-running-banner');
  render(<KeptRunningBanner />);
  await act(async () => {});
  return { opener };
}

describe('KeptRunningBanner', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('renders nothing when nothing was kept across the last quit', async () => {
    await mount(null);
    expect(screen.queryByTestId('kept-running-banner')).not.toBeInTheDocument();
  });

  it('says how many sessions kept running, and that the tabs have them back', async () => {
    await mount({ terminalIds: [`conversation:${S1}`, `commands:${S1}:dev`] });
    const banner = screen.getByTestId('kept-running-banner');
    expect(banner).toHaveTextContent('1 session kept running while double0 was closed');
    expect(banner).toHaveTextContent('Every tab picked its terminal up again');
  });

  it('Settings opens Settings › Sessions and hides the banner', async () => {
    const { opener } = await mount({ terminalIds: [`conversation:${S1}`] });
    await userEvent.click(screen.getByRole('button', { name: /Sessions settings/ }));
    expect(opener).toHaveBeenCalledWith('sessions');
    expect(screen.queryByTestId('kept-running-banner')).not.toBeInTheDocument();
  });

  it('× hides it', async () => {
    const { opener } = await mount({ terminalIds: [`conversation:${S1}`] });
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss kept-running notice' }));
    expect(screen.queryByTestId('kept-running-banner')).not.toBeInTheDocument();
    expect(opener).not.toHaveBeenCalled();
  });
});
