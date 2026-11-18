import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';

/**
 * Settings › Editor › Language servers per machine (plan 29 › M9): this
 * computer's list, a machine picker with each host - pickable while connected
 * with a daemon that announces `lsp` - and a host's list, installs and
 * uninstalls going to THAT host.
 */

const user = userEvent.setup({ pointerEventsCheck: 0 });

const host = (id: string, label: string) => ({
  id,
  label,
  target: `emmaw@${label}`,
  port: null,
  forwardAgent: false,
  useInstalledNode: false,
  addedAt: 1,
});

const status = (id: string, state: string, caps: string[]) => ({
  id,
  state,
  message: null,
  details: null,
  facts: null,
  since: null,
  caps,
});

const row = (id: string, name: string, s: string, extra: object = {}) => ({
  id,
  name,
  extensions: [id === 'python' ? 'py' : id],
  status: s,
  ...extra,
});

const LOCAL = [row('python', 'Python', 'installed', { version: '1.1.411' })];
const BUILD_BOX = [
  row('python', 'Python', 'available', { approxMb: 19 }),
  row('go', 'Go', 'on-path', { path: '/home/emmaw/go/bin/gopls' }),
];

const list = vi.fn(async (hostId?: string | null) => ({
  languages: hostId === 'h1' ? BUILD_BOX : LOCAL,
}));
const install = vi.fn(async () => ({ ok: true as const }));
const uninstall = vi.fn(async () => ({ ok: true as const }));

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  window.localStorage.setItem(
    'double0-hosts',
    JSON.stringify([host('h1', 'build-box'), host('h2', 'old-box'), host('h3', 'away-box')]),
  );
  list.mockClear();
  install.mockClear();
  uninstall.mockClear();
  stubApi({
    ls: { list, install, uninstall, onProgress: vi.fn(() => () => undefined) },
    hosts: {
      sync: vi.fn(async () => true),
      statuses: vi.fn(async () => [
        status('h1', 'connected', ['remote', 'files', 'lsp']),
        status('h2', 'connected', ['remote', 'files']),
        status('h3', 'unreachable', ['remote', 'files', 'lsp']),
      ]),
      onChanged: vi.fn(() => () => undefined),
    },
  });
});

/** The hosts as the official build's store serves them (one array: a stable snapshot). */
const HOSTS = [
  { id: 'h1', label: 'build-box' },
  { id: 'h2', label: 'old-box' },
  { id: 'h3', label: 'away-box' },
];

async function renderSection() {
  // The remote hosts are Pro (a private plan › M7): the section shows host rows
  // where they are registered, reading the core host directory.
  const { installRendererExtension } = await import('@renderer/lib/extension/registry');
  installRendererExtension((await import('@renderer/test-support')).bridgeSlots());
  const directory = await import('@renderer/lib/hosts/host-directory');
  directory.registerHostSource({ list: () => HOSTS, subscribe: () => () => {} });
  const { EditorSettingsSection } =
    await import('@renderer/routes/_app/-components/settings/editor-section');
  render(<EditorSettingsSection />);
  return screen.findByRole('radiogroup', { name: 'Machine' });
}

describe('Language servers per machine', () => {
  it("lists this computer's servers first, with each host in the machine picker", async () => {
    const picker = await renderSection();
    expect(within(picker).getByRole('radio', { name: 'This computer' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(await screen.findByText('Installed v1.1.411')).toBeInTheDocument();
    // An older runtime and an unreachable host are listed, not pickable.
    const old = within(picker).getByRole('radio', { name: 'old-box' });
    await waitFor(() => expect(old).toBeDisabled());
    expect(old).toHaveAttribute(
      'title',
      'Update the runtime on old-box to use language servers there',
    );
    expect(within(picker).getByRole('radio', { name: 'away-box' })).toBeDisabled();
    expect(within(picker).getByRole('radio', { name: 'build-box' })).toBeEnabled();
  });

  it("shows a host's servers and installs on that host, never here", async () => {
    const picker = await renderSection();
    const buildBox = within(picker).getByRole('radio', { name: 'build-box' });
    await waitFor(() => expect(buildBox).toBeEnabled());
    await user.click(buildBox);
    await waitFor(() => expect(list).toHaveBeenCalledWith('h1'));
    expect(await screen.findByText('/home/emmaw/go/bin/gopls')).toBeInTheDocument();
    expect(screen.getByText(/Servers for files on build-box run there/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Install \(~19 MB\)/ }));
    expect(install).toHaveBeenCalledWith('python', 'h1');
  });

  it('uninstalls on this computer when it is picked', async () => {
    await renderSection();
    await user.click(await screen.findByRole('button', { name: 'Uninstall' }));
    expect(uninstall).toHaveBeenCalledWith('python', null);
  });
});
