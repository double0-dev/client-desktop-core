import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';

/**
 * The file editor's language-server banner and host files (plan 29 › M9): a
 * file on a host asks THAT host's servers and installs there (never on this
 * computer); a host whose daemon predates `lsp` shows no banner; a host file
 * outside every project root (a definition in its `site-packages`) is read
 * through that host and opened read-only.
 */

const user = userEvent.setup({ pointerEventsCheck: 0 });

/** The path's host, as the projects table says (`/home/emmaw/acme` is on h1). */
vi.mock('@renderer/lib/hosts/host-of-path', () => ({
  currentHostOfPath: (path: string | null | undefined) =>
    path?.startsWith('/home/emmaw/acme') ? 'h1' : null,
}));
/** The Monaco view is not under test: a stand-in that reports its props. */
const views: Array<Record<string, unknown>> = [];
vi.mock('@renderer/components/monaco-editor', async () => {
  const React = await import('react');
  return {
    MonacoEditorView: React.forwardRef(function View(props: Record<string, unknown>) {
      views.push(props);
      return <div data-testid="monaco" />;
    }),
  };
});

const list = vi.fn(async (hostId?: string | null) => ({
  languages: [
    {
      id: 'python',
      name: 'Python',
      extensions: ['py'],
      status: hostId ? 'available' : 'installed',
      approxMb: 19,
    },
  ],
}));
const install = vi.fn(async () => ({ ok: true as const }));
const readFile = vi.fn(async () => ({ content: 'print(1)\n', mtimeMs: 1 }));
const readFileOnHost = vi.fn(async () => ({ content: 'def get(url): ...\n', mtimeMs: 1 }));
let caps: string[] = ['remote', 'lsp'];
let hostState = 'connected';

/** The official build's hosts store, as the host directory serves it. */
const BUILD_BOX = [{ id: 'h1', label: 'build-box' }];

beforeEach(() => {
  vi.resetModules();
  views.length = 0;
  window.localStorage.clear();
  window.localStorage.setItem(
    'double0-hosts',
    JSON.stringify([
      {
        id: 'h1',
        label: 'build-box',
        target: 'emmaw@build-box',
        port: null,
        forwardAgent: false,
        useInstalledNode: false,
        addedAt: 1,
      },
    ]),
  );
  list.mockClear();
  install.mockClear();
  readFile.mockClear();
  readFileOnHost.mockClear();
  caps = ['remote', 'lsp'];
  hostState = 'connected';
  stubApi({
    fs: { readFile, readFileOnHost, onChanged: vi.fn(() => () => undefined) },
    ls: { list, install, uninstall: vi.fn(), onProgress: vi.fn(() => () => undefined) },
    hosts: {
      sync: vi.fn(async () => true),
      statuses: vi.fn(async () => [
        {
          id: 'h1',
          state: hostState,
          message: null,
          details: null,
          facts: null,
          since: null,
          caps,
        },
      ]),
      onChanged: vi.fn(() => () => undefined),
    },
  });
});

// Core reads the hosts bridge through the extension's slot: install it into
// the registry the fresh module copies import (after the reset above).
beforeEach(async () => {
  const { installRendererExtension } = await import('@renderer/lib/extension/registry');
  const { bridgeSlots } = await import('@renderer/test-support');
  installRendererExtension(bridgeSlots());
});

async function renderEditor(filePath: string, hostId: string | null = null) {
  // The official build's hosts store, as core's host directory reads it.
  (await import('@renderer/lib/hosts/host-directory')).registerHostSource({
    list: () => BUILD_BOX,
    subscribe: () => () => {},
  });
  const { FileEditor } = await import('@renderer/routes/_app/-components/workspace/file-editor');
  // After resetModules: the harness's context must be the editor's own copy.
  const { fakeLayoutContext, withLayout } = await import('@renderer/test-support');
  render(<FileEditor filePath={filePath} hostId={hostId} tabId="t1" active />, {
    wrapper: withLayout(fakeLayoutContext()),
  });
  await screen.findByTestId('monaco');
}

describe('FileEditor on a remote host', () => {
  it("offers the host's server for a host file and installs it there", async () => {
    await renderEditor('/home/emmaw/acme/app.py');
    expect(
      await screen.findByText('Install the Python language server on build-box (~19 MB).'),
    ).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith('h1');
    await user.click(screen.getByRole('button', { name: 'Install' }));
    expect(install).toHaveBeenCalledWith('python', 'h1');
  });

  it('shows no banner for a host whose daemon predates lsp', async () => {
    caps = ['remote', 'files'];
    await renderEditor('/home/emmaw/acme/app.py');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/language server on build-box/)).not.toBeInTheDocument();
    expect(list).not.toHaveBeenCalledWith('h1');
  });

  it('reads a host file outside the projects through that host, read-only, with no server', async () => {
    const site = '/usr/lib/python3/dist-packages/requests/api.py';
    await renderEditor(site, 'h1');
    expect(readFileOnHost).toHaveBeenCalledWith('h1', site);
    expect(readFile).not.toHaveBeenCalled();
    expect(
      await screen.findByText('build-box · outside the project - opened read-only.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(views.at(-1)).toMatchObject({ readOnly: true, hostId: 'h1', lspRoot: null }),
    );
  });

  /**
   * A relaunch restores the tab while its host is still connecting: the read
   * answers EHOSTDOWN. Once the host is connected the file loads - before,
   * the tab stayed on "Host is unreachable" for good.
   */
  it('loads a file that failed while its host was away once the host is connected', async () => {
    hostState = 'connecting';
    readFile.mockResolvedValueOnce({
      error: 'Host is unreachable',
      code: 'EHOSTDOWN',
    } as unknown as { content: string; mtimeMs: number });
    // The official build's hosts store, as core's host directory reads it.
    (await import('@renderer/lib/hosts/host-directory')).registerHostSource({
      list: () => BUILD_BOX,
      subscribe: () => () => {},
    });
    const { FileEditor } = await import('@renderer/routes/_app/-components/workspace/file-editor');
    const { fakeLayoutContext, withLayout } = await import('@renderer/test-support');
    render(<FileEditor filePath="/home/emmaw/acme/app.py" tabId="t1" active />, {
      wrapper: withLayout(fakeLayoutContext()),
    });
    expect(await screen.findByText('Host is unreachable')).toBeInTheDocument();
    expect(readFile).toHaveBeenCalledTimes(1);
    // The hosts bridge is Pro's (a private plan › M7): stubbed here, untyped in core.
    const hosts = (window.api as unknown as { hosts: { onChanged: unknown } }).hosts;
    const onChanged = hosts.onChanged as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const push = onChanged.mock.calls[0][0] as (list: unknown[]) => void;
    act(() =>
      push([
        {
          id: 'h1',
          state: 'connected',
          message: null,
          details: null,
          facts: null,
          since: null,
          caps,
        },
      ]),
    );
    await screen.findByTestId('monaco');
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
