import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';

/**
 * Settings → General → RESET (design `Screen/Settings - General · Import,
 * export & reset (scrolled)` and `· Reset confirm`). The row's button never
 * resets by itself: it opens the confirm dialog, and only the destructive
 * "Reset settings" action runs the reset - Cancel and Escape leave every
 * setting alone.
 */

const { resetAppSettings } = vi.hoisted(() => ({ resetAppSettings: vi.fn() }));
vi.mock('@renderer/lib/settings/settings-reset', () => ({ resetAppSettings }));

// The JSON editor pulls Monaco in; it stays closed here.
vi.mock('@renderer/routes/_app/-components/settings/settings-json-dialog', () => ({
  SettingsJsonDialog: () => null,
}));

// Radix pins `pointer-events: none` on the body while the confirm is open.
const user = userEvent.setup({ pointerEventsCheck: 0 });

beforeEach(() => {
  resetAppSettings.mockClear();
  stubApi({ getAppVersion: vi.fn(async () => '0.1.0') });
});

async function renderSection(): Promise<void> {
  const { GeneralSettingsSection } =
    await import('@renderer/routes/_app/-components/settings/general-section');
  render(<GeneralSettingsSection />);
}

describe('GeneralSettingsSection - extension rows', () => {
  // The official build's switches (crash reports) are its own rows; the core
  // build reports nothing anywhere and shows no such switch.
  it('renders the rows an installed extension adds, and none without one', async () => {
    vi.resetModules();
    await renderSection();
    expect(screen.queryByRole('switch', { name: 'Send crash reports' })).toBeNull();
    cleanup();

    vi.resetModules();
    const { installRendererExtension } = await import('@renderer/lib/extension/registry');
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      generalRows: [() => <p>An extension row</p>],
    });
    await renderSection();
    expect(screen.getByText('An extension row')).toBeInTheDocument();
  });
});

describe('GeneralSettingsSection - export text', () => {
  // The row names what an export holds: core's rows, plus what the extension's
  // sections add - never words for rows this build cannot write.
  it("names core's rows, and the extension's only where it adds them", async () => {
    vi.resetModules();
    await renderSection();
    expect(
      screen.getByText(
        'Every setting, plus projects, sessions and workspace layouts - one readable JSON file. Account tokens and SSH keys stay on this machine.',
      ),
    ).toBeInTheDocument();
    cleanup();

    vi.resetModules();
    const { installRendererExtension } = await import('@renderer/lib/extension/registry');
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      dataTransfer: {
        sections: ['notes'],
        describes: 'saved notes',
        collect: async () => ({}),
        apply: async () => ({ counts: {}, summary: [], errors: [] }),
      },
    });
    await renderSection();
    expect(
      screen.getByText(
        /^Every setting, plus projects, sessions, saved notes and workspace layouts/,
      ),
    ).toBeInTheDocument();
  });
});

describe('GeneralSettingsSection - reset', () => {
  it('asks before resetting and resets only on the destructive action', async () => {
    await renderSection();
    expect(screen.getByText('Reset all settings')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Reset all settings?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(resetAppSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Reset…' }));
    const again = await screen.findByRole('dialog');
    await user.click(within(again).getByRole('button', { name: 'Reset settings' }));
    expect(resetAppSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('GeneralSettingsSection - account', () => {
  // Read through the same module graph renderSection imports (an earlier test
  // resets modules, and a fresh graph has a fresh registry).
  const registry = () => import('@renderer/lib/extension/registry');
  afterEach(async () => (await registry()).resetRendererExtensionForTest());

  // Login is Pro (a private plan › decision 15): the core
  // build has no account, so no ACCOUNT block and no sign-out button.
  it('shows no account in the core build', async () => {
    await renderSection();
    expect(screen.queryByText('ACCOUNT')).toBeNull();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
    expect(screen.getByText('APPLICATION')).toBeInTheDocument();
  });

  it("shows Pro's account block where Pro registered sign-in", async () => {
    (await registry()).installRendererExtension({
      edition: 'pro',
      railTools: [],
      auth: {
        status: async () => 'signed-in',
        SignInScreen: () => null,
        AccountSection: () => <h3>ACCOUNT</h3>,
      },
    });
    await renderSection();
    expect(screen.getByText('ACCOUNT')).toBeInTheDocument();
  });
});

describe('GeneralSettingsSection - open-source licences', () => {
  // MIT, BSD, Apache and MPL ask the binary to carry each package's licence
  // (a private plan › E): the build writes the notices, this row
  // is where a user finds them.
  const NOTICES = {
    version: 1 as const,
    packages: [
      {
        name: 'drizzle-orm',
        version: '1.0.0',
        license: 'Apache-2.0',
        files: [{ name: 'LICENSE', text: 1 }],
      },
      { name: 'react', version: '19.1.0', license: 'MIT', files: [{ name: 'LICENSE', text: 0 }] },
    ],
    texts: ['MIT License - react text', 'Apache License - drizzle text'],
  };

  it('opens the list and shows the picked package’s licence text, filtered by the search', async () => {
    stubApi({
      getAppVersion: vi.fn(async () => '0.1.0'),
      notices: {
        list: vi.fn(async () => ({ ok: true, notices: NOTICES })),
        openPlatform: vi.fn(async () => true),
      },
    });
    await renderSection();
    await user.click(screen.getByRole('button', { name: 'View…' }));
    const dialog = await screen.findByRole('dialog');
    // The first package is shown at once.
    expect(await within(dialog).findByText('Apache License - drizzle text')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /react/ }));
    expect(within(dialog).getByText('MIT License - react text')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: 'Search packages' }), 'apache');
    const list = within(dialog).getByRole('list', { name: 'Packages' });
    expect(within(list).queryByText('react')).toBeNull();
    expect(within(list).getByText('drizzle-orm')).toBeInTheDocument();
    expect(within(dialog).getByText('1 of 2')).toBeInTheDocument();
  });

  it('opens Electron’s and Chromium’s own licence files, and says so when a build has none', async () => {
    const openPlatform = vi.fn(async (which: string) => which === 'electron');
    stubApi({
      getAppVersion: vi.fn(async () => '0.1.0'),
      notices: { list: vi.fn(async () => ({ ok: true, notices: NOTICES })), openPlatform },
    });
    await renderSection();
    await user.click(screen.getByRole('button', { name: 'View…' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Electron licence' }));
    expect(openPlatform).toHaveBeenLastCalledWith('electron');
    expect(within(dialog).queryByText('Not found in this build.')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Chromium licences' }));
    expect(await within(dialog).findByText('Not found in this build.')).toBeInTheDocument();
  });

  it('says a development build has no list instead of showing an empty one', async () => {
    // stubApi's default: no notices file (`pnpm dev` writes none).
    await renderSection();
    await user.click(screen.getByRole('button', { name: 'View…' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/This build has no licence list/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('list', { name: 'Packages' })).toBeNull();
  });
});
