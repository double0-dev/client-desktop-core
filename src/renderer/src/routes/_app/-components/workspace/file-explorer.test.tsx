import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorer } from '@renderer/routes/_app/-components/workspace/file-explorer';
import { REVEAL_IN_OS_LABEL } from '@renderer/lib/reveal-in-os';
import {
  fakeFs,
  fakeLayoutContext,
  stubApi,
  withLayout,
  type FsTree,
} from '@renderer/test-support';
import { noteWatchMode, resetWatchModesForTest } from '@renderer/lib/workspace/watch-mode';
import { registerHostSource, resetHostSourceForTest } from '@renderer/lib/hosts/host-directory';
import {
  applyHostStatuses,
  resetHostStatusesForTest,
  type HostStatus,
} from '@renderer/lib/hosts/host-status';

// Which machine the tree is on (lib/hosts/host-of-path.ts) - local unless a
// test says otherwise.
const host = vi.hoisted(() => ({ id: null as string | null }));
vi.mock('@renderer/lib/hosts/host-of-path', () => ({ currentHostOfPath: () => host.id }));

/**
 * The file explorer is the widest surface over the fs bridge: lazy directory
 * reads, per-directory error rows, inline create/rename, and opening files into
 * editor tabs. It is driven here against an in-memory filesystem.
 */

const ROOT = '/repo';
const user = userEvent.setup({ pointerEventsCheck: 0 });

const TREE: FsTree = {
  src: {
    'index.ts': 'export {};\n',
    lib: { 'utils.ts': 'export const a = 1;\n' },
  },
  'README.md': '# production-pipeline\n',
};

let fs: ReturnType<typeof fakeFs>;
let ctx: ReturnType<typeof fakeLayoutContext>;

/** Mount the explorer over `tree`, waiting for the root read to land. */
async function mount(tree: FsTree = TREE, props: Record<string, unknown> = {}) {
  fs = fakeFs(ROOT, tree);
  stubApi({ fs: fs.api });
  ctx = fakeLayoutContext();
  const result = render(<FileExplorer rootPath={ROOT} {...props} />, { wrapper: withLayout(ctx) });
  await waitFor(() => expect(fs.api.readDir).toHaveBeenCalledWith(ROOT));
  return result;
}

beforeEach(() => {
  window.localStorage.clear();
  host.id = null;
  resetWatchModesForTest();
});

describe('rendering the root', () => {
  it('lists the root’s entries, directories first', async () => {
    await mount();
    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('names the tree after the root folder', async () => {
    await mount();
    expect(screen.getByText('repo')).toBeInTheDocument();
  });

  it('reads only the root until a folder is expanded', async () => {
    await mount();
    expect(fs.api.readDir).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
  });

  it('shows an empty root as empty rather than blank', async () => {
    await mount({});
    expect(await screen.findByText('empty')).toBeInTheDocument();
  });

  it('surfaces a root that cannot be read', async () => {
    fs = fakeFs(ROOT, {});
    fs.api.readDir.mockResolvedValueOnce({ error: 'EACCES: permission denied', code: 'EACCES' });
    stubApi({ fs: fs.api });
    render(<FileExplorer rootPath={ROOT} />, { wrapper: withLayout(fakeLayoutContext()) });
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
  });
});

describe('expanding folders', () => {
  it('reads a folder’s children on first expand', async () => {
    await mount();
    await user.click(await screen.findByText('src'));
    expect(await screen.findByText('index.ts')).toBeInTheDocument();
    expect(fs.api.readDir).toHaveBeenCalledWith(`${ROOT}/src`);
  });

  it('collapses again without re-reading', async () => {
    await mount();
    const src = await screen.findByText('src');
    await user.click(src);
    await screen.findByText('index.ts');
    const readsAfterExpand = fs.api.readDir.mock.calls.length;

    await user.click(src);
    await waitFor(() => expect(screen.queryByText('index.ts')).not.toBeInTheDocument());

    await user.click(src);
    await screen.findByText('index.ts');
    expect(fs.api.readDir).toHaveBeenCalledTimes(readsAfterExpand);
  });

  it('expands nested folders', async () => {
    await mount();
    await user.click(await screen.findByText('src'));
    await user.click(await screen.findByText('lib'));
    expect(await screen.findByText('utils.ts')).toBeInTheDocument();
  });

  it('shows a per-directory error inline, leaving the rest usable', async () => {
    await mount();
    fs.api.readDir.mockResolvedValueOnce({ error: 'EACCES: denied', code: 'EACCES' });
    await user.click(await screen.findByText('src'));
    expect(await screen.findByText(/denied/)).toBeInTheDocument();
    // The root's other entries are untouched.
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('remembers which folders were open across a remount', async () => {
    await mount();
    await user.click(await screen.findByText('src'));
    await screen.findByText('index.ts');

    // Same root, fresh mount: the persisted tree state re-expands it.
    const second = fakeFs(ROOT, TREE);
    stubApi({ fs: second.api });
    render(<FileExplorer rootPath={ROOT} />, { wrapper: withLayout(fakeLayoutContext()) });
    await waitFor(() => expect(second.api.readDir).toHaveBeenCalledWith(`${ROOT}/src`));
  });
});

describe('opening files', () => {
  it('opens a file into an editor tab', async () => {
    await mount();
    await user.click(await screen.findByText('README.md'));
    expect(ctx.openFile).toHaveBeenCalledWith(`${ROOT}/README.md`);
  });

  it('does not open a folder as a file', async () => {
    await mount();
    await user.click(await screen.findByText('src'));
    expect(ctx.openFile).not.toHaveBeenCalled();
  });
});

describe('creating entries', () => {
  it('creates a file from the folder’s inline action', async () => {
    await mount();
    const row = (await screen.findByText('src')).closest('[data-slot],div') as HTMLElement;
    await user.hover(row);
    await user.click(screen.getByRole('button', { name: 'New file in src' }));

    const input = await screen.findByPlaceholderText('file name');
    await user.type(input, 'new-file.ts{Enter}');

    await waitFor(() => expect(fs.api.createFile).toHaveBeenCalledWith(`${ROOT}/src/new-file.ts`));
  });

  it('creates a folder from the folder’s inline action', async () => {
    await mount();
    await user.hover(await screen.findByText('src'));
    await user.click(screen.getByRole('button', { name: 'New folder in src' }));

    await user.type(await screen.findByPlaceholderText('folder name'), 'nested{Enter}');
    await waitFor(() => expect(fs.api.createDir).toHaveBeenCalledWith(`${ROOT}/src/nested`));
  });

  it('abandons the draft on Escape', async () => {
    await mount();
    await user.hover(await screen.findByText('src'));
    await user.click(screen.getByRole('button', { name: 'New file in src' }));

    await user.type(await screen.findByPlaceholderText('file name'), 'never{Escape}');
    expect(fs.api.createFile).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByPlaceholderText('file name')).not.toBeInTheDocument());
  });

  it('ignores an empty name', async () => {
    await mount();
    await user.hover(await screen.findByText('src'));
    await user.click(screen.getByRole('button', { name: 'New file in src' }));
    await user.type(await screen.findByPlaceholderText('file name'), '{Enter}');
    expect(fs.api.createFile).not.toHaveBeenCalled();
  });
});

describe('the context menu', () => {
  const openMenuOn = async (label: string): Promise<void> => {
    await user.pointer({ keys: '[MouseRight]', target: await screen.findByText(label) });
    await screen.findByRole('menu');
  };

  it('offers rename and delete on a file', async () => {
    await mount();
    await openMenuOn('README.md');
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText(/Rename/)).toBeInTheDocument();
    expect(within(menu).getByText(/Delete/)).toBeInTheDocument();
  });

  it('reveals a file in the OS file manager', async () => {
    await mount();
    await openMenuOn('README.md');
    await user.click(within(screen.getByRole('menu')).getByText(REVEAL_IN_OS_LABEL));
    expect(fs.api.showInFolder).toHaveBeenCalledWith(`${ROOT}/README.md`);
  });

  it('reveals a folder in the OS file manager', async () => {
    await mount();
    await openMenuOn('src');
    await user.click(within(screen.getByRole('menu')).getByText(REVEAL_IN_OS_LABEL));
    expect(fs.api.showInFolder).toHaveBeenCalledWith(`${ROOT}/src`);
  });

  const stubClipboard = (): ReturnType<typeof vi.fn> => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  };

  it('copies the absolute path of a file', async () => {
    const writeText = stubClipboard();
    await mount();
    await openMenuOn('README.md');
    await user.click(within(screen.getByRole('menu')).getByText('Copy path'));
    expect(writeText).toHaveBeenCalledWith(`${ROOT}/README.md`);
  });

  it('copies a folder path relative to the explorer root', async () => {
    const writeText = stubClipboard();
    await mount();
    await openMenuOn('src');
    await user.click(within(screen.getByRole('menu')).getByText('Copy relative path'));
    expect(writeText).toHaveBeenCalledWith('src');
  });

  it('says so when the item to reveal is gone', async () => {
    // Deleted outside the app since the tree was read - the file manager
    // would otherwise open nowhere, silently.
    await mount();
    fs.api.showInFolder.mockResolvedValueOnce({
      error: '"README.md" no longer exists',
      code: 'ENOENT',
    });
    await openMenuOn('README.md');
    await user.click(within(screen.getByRole('menu')).getByText(REVEAL_IN_OS_LABEL));
    expect(await screen.findByText('Could not open the folder')).toBeInTheDocument();
  });

  /** Open the rename editor on `label` and replace the name.
   *
   * The new name is pasted rather than typed: per-character simulation into
   * this input drops the first keystroke (the row re-renders between the clear
   * and the first key), which is a harness artefact, not app behaviour. */
  const renameTo = async (label: string, next: string): Promise<void> => {
    await openMenuOn(label);
    await user.click(within(screen.getByRole('menu')).getByText(/Rename/));
    const input = (await screen.findByDisplayValue(label)) as HTMLInputElement;
    await user.clear(input);
    await user.paste(next);
    expect(input.value, 'the rename input did not take the new name').toBe(next);
    await user.keyboard('{Enter}');
  };

  it('renames through the fs bridge', async () => {
    await mount();
    await renameTo('README.md', 'DOCS.md');
    await waitFor(() =>
      expect(fs.api.rename).toHaveBeenCalledWith(`${ROOT}/README.md`, `${ROOT}/DOCS.md`),
    );
  });

  it('repoints open editor tabs after a rename', async () => {
    // An editor left pointing at the old path would save to a file that no
    // longer exists.
    await mount();
    await renameTo('README.md', 'DOCS.md');
    await waitFor(() =>
      expect(ctx.remapEditorPaths).toHaveBeenCalledWith(`${ROOT}/README.md`, `${ROOT}/DOCS.md`),
    );
  });

  it('does not touch the filesystem when the name is unchanged', async () => {
    await mount();
    await renameTo('README.md', 'README.md');
    await waitFor(() => expect(screen.queryByDisplayValue('README.md')).not.toBeInTheDocument());
    expect(fs.api.rename).not.toHaveBeenCalled();
  });

  it('hides "New session here" when the host does not offer it', async () => {
    // Detached windows pass no handler.
    await mount(TREE);
    await openMenuOn('src');
    expect(within(screen.getByRole('menu')).queryByText(/New session/)).not.toBeInTheDocument();
  });

  it('offers "New session here" on a folder when the host does', async () => {
    const onNewSessionAt = vi.fn();
    await mount(TREE, { onNewSessionAt });
    await openMenuOn('src');
    await user.click(within(screen.getByRole('menu')).getByText(/New session/));
    expect(onNewSessionAt).toHaveBeenCalledWith(`${ROOT}/src`);
  });
});

describe('keyboard navigation', () => {
  // The explorer is a focus region (⇧⌘Arrow lands here): ↑/↓ walk rows, →/←
  // expand/collapse, and only Enter opens - arrowing over files must never
  // open them, or walking a folder would spray editor tabs.
  const focusedKey = (): string | null =>
    document.activeElement?.getAttribute('data-focus-key') ?? null;

  it('↓/↑ walk the visible rows, → opens a folder or steps into it, ← collapses or climbs', async () => {
    await mount();
    await screen.findByText('src');
    screen.getByTitle(ROOT).focus();
    expect(focusedKey()).toBe(ROOT);

    await user.keyboard('{ArrowDown}');
    expect(focusedKey()).toBe(`${ROOT}/src`);

    // → on a collapsed folder expands it (loading its children)…
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByText('index.ts')).toBeInTheDocument();
    expect(focusedKey()).toBe(`${ROOT}/src`);
    // …and on an open one steps into its first child (directories first).
    await user.keyboard('{ArrowRight}');
    expect(focusedKey()).toBe(`${ROOT}/src/lib`);
    await user.keyboard('{ArrowDown}');
    expect(focusedKey()).toBe(`${ROOT}/src/index.ts`);

    // ← on a file climbs to its folder; ← on an open folder collapses it.
    await user.keyboard('{ArrowLeft}');
    expect(focusedKey()).toBe(`${ROOT}/src`);
    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
    expect(focusedKey()).toBe(`${ROOT}/src`);

    // ↑ at the top stays put - the list never wraps.
    await user.keyboard('{ArrowUp}');
    expect(focusedKey()).toBe(ROOT);
    await user.keyboard('{ArrowUp}');
    expect(focusedKey()).toBe(ROOT);
    expect(ctx.openFile).not.toHaveBeenCalled();
  });

  it('opens a file only on Enter, never by arrowing onto it', async () => {
    await mount();
    await screen.findByText('README.md');
    screen.getByTitle(ROOT).focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(focusedKey()).toBe(`${ROOT}/README.md`);
    expect(ctx.openFile).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(ctx.openFile).toHaveBeenCalledWith(`${ROOT}/README.md`);
    expect(ctx.openFile).toHaveBeenCalledTimes(1);
  });

  it('is a focus region whose current item is the row the keyboard last landed on', async () => {
    const { container } = await mount();
    await screen.findByText('README.md');
    const region = container.querySelector('[data-focus-region="explorer"]');
    expect(region).not.toBeNull();
    // Before any keyboard use, re-entering the region lands on the root row.
    expect(region!.querySelector('[data-focus-current="true"]')).toHaveAttribute(
      'data-focus-key',
      ROOT,
    );
    screen.getByTitle(ROOT).focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(region!.querySelector('[data-focus-current="true"]')).toHaveAttribute(
      'data-focus-key',
      `${ROOT}/README.md`,
    );
  });
});

describe('a tree on a remote host', () => {
  const openMenuOn = async (label: string): Promise<void> => {
    const row = await screen.findByText(label);
    await user.pointer({ keys: '[MouseRight]', target: row });
    await screen.findByRole('menu');
  };

  // Nothing on this machine to reveal, and d0-preview serves local files only.
  it('offers no reveal in the OS file manager, and previews through the host (plan 29 › M6)', async () => {
    host.id = 'build-box';
    await mount({ ...TREE, 'index.html': '<p>x</p>' });
    await openMenuOn('index.html');
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByText(REVEAL_IN_OS_LABEL)).toBeNull();
    // `d0-preview://` reads a host file through the host now.
    expect(within(menu).getByText('Open in browser tab')).toBeInTheDocument();
    expect(within(menu).getByText(/Rename/)).toBeInTheDocument();
  });

  /**
   * A relaunch restores the explorer while its host is still connecting (or
   * the host was down): the reads answer EHOSTDOWN. Once the host is
   * connected the tree reads again - root and the folders it had open -
   * instead of staying on "Host is unreachable" for good.
   */
  it('reads the tree again once its host is connected', async () => {
    host.id = 'build-box';
    window.localStorage.clear();
    resetHostStatusesForTest();
    fs = fakeFs(ROOT, TREE);
    const down = { error: 'Host is unreachable', code: 'EHOSTDOWN' };
    fs.api.readDir.mockResolvedValueOnce(down);
    stubApi({ fs: fs.api });
    render(<FileExplorer rootPath={ROOT} />, { wrapper: withLayout(fakeLayoutContext()) });
    expect(await screen.findByText('Host is unreachable')).toBeInTheDocument();
    const status = (state: HostStatus['state']) =>
      ({
        id: 'build-box',
        state,
        message: null,
        details: null,
        facts: null,
        since: null,
      }) as HostStatus;
    // Another host connecting is not this one.
    act(() => applyHostStatuses([status('connecting'), { ...status('connected'), id: 'gpu-box' }]));
    expect(fs.api.readDir).toHaveBeenCalledTimes(1);
    // Still connecting: said as it is, not as a host that is down.
    expect(screen.getByText('Connecting to the server…')).toBeInTheDocument();
    act(() => applyHostStatuses([status('connected')]));
    expect(await screen.findByText('README.md')).toBeInTheDocument();
    expect(screen.queryByText('Host is unreachable')).toBeNull();
    resetHostStatusesForTest();
  });

  it('says when the host polls the tree instead of watching it', async () => {
    host.id = 'build-box';
    await mount();
    expect(screen.queryByTestId('explorer-watch-mode')).toBeNull();
    act(() => noteWatchMode(ROOT, 'poll'));
    expect(await screen.findByText('polling (large tree)')).toBeInTheDocument();
  });
});

// Plan 29 › M8: files dragged in from the desktop. The explorer had no drop
// target at all before - now every root takes one (a local copy, an upload
// for a host's root), and the renderer only hands main the dropped paths.
describe('dropping files from this computer', () => {
  const DESKTOP = '/Users/emmaw/Desktop';
  const file = (name: string) => new File(['x'], name);
  const files = (...names: string[]) => ({
    types: ['Files'],
    files: names.map(file),
    dropEffect: 'none',
  });

  async function mountWithFiles(tree: FsTree = TREE) {
    fs = fakeFs(ROOT, tree);
    const api = stubApi({
      fs: fs.api,
      files: { pathOf: (f: File) => `${DESKTOP}/${f.name}`, thisMachine: () => 'darwin-arm64' },
    });
    ctx = fakeLayoutContext();
    render(<FileExplorer rootPath={ROOT} />, { wrapper: withLayout(ctx) });
    await screen.findByText('src');
    return api;
  }

  const folderRow = (name: string): HTMLElement =>
    screen.getByRole('button', { name }).closest('[data-drop-dir]') as HTMLElement;

  it('highlights the folder under a drag of files, and nothing for other drags', async () => {
    await mountWithFiles();
    const src = folderRow('src');
    fireEvent.dragOver(screen.getByRole('button', { name: 'src' }), {
      dataTransfer: files('a.txt'),
    });
    expect(src).toHaveAttribute('data-dropping', 'true');
    fireEvent.dragLeave(screen.getByTestId('explorer-tree'), {
      dataTransfer: files('a.txt'),
      relatedTarget: document.body,
    });
    expect(src).not.toHaveAttribute('data-dropping');
    // A drag of text (or a tab) is not a drop of files.
    fireEvent.dragOver(screen.getByRole('button', { name: 'src' }), {
      dataTransfer: { types: ['text/plain'], files: [] },
    });
    expect(src).not.toHaveAttribute('data-dropping');
  });

  it('copies dropped files into the folder under the drop, by path - and opens it', async () => {
    await mountWithFiles();
    fireEvent.drop(screen.getByRole('button', { name: 'src' }), {
      dataTransfer: files('notes.md', 'logo.svg'),
    });
    await waitFor(() =>
      expect(fs.api.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          paths: [`${DESKTOP}/notes.md`, `${DESKTOP}/logo.svg`],
          destDir: `${ROOT}/src`,
          onClash: 'ask',
        }),
      ),
    );
    expect(await screen.findByText('notes.md')).toBeInTheDocument();
    expect(screen.getByText('logo.svg')).toBeInTheDocument();
  });

  it('drops onto a file row into that file’s folder, and onto empty space into the root', async () => {
    await mountWithFiles();
    fireEvent.drop(screen.getByRole('button', { name: 'README.md' }), {
      dataTransfer: files('a.txt'),
    });
    await waitFor(() =>
      expect(fs.api.upload).toHaveBeenLastCalledWith(expect.objectContaining({ destDir: ROOT })),
    );
    await waitFor(() => expect(screen.queryByTestId('explorer-upload')).toBeNull());
    fireEvent.drop(screen.getByTestId('explorer-tree'), { dataTransfer: files('b.txt') });
    await waitFor(() =>
      expect(fs.api.upload).toHaveBeenLastCalledWith(expect.objectContaining({ destDir: ROOT })),
    );
  });

  it('asks once when a name is taken and sends the choice for the batch', async () => {
    await mountWithFiles({ ...TREE, 'notes.md': 'mine' });
    fireEvent.drop(screen.getByTestId('explorer-tree'), { dataTransfer: files('notes.md') });
    // Earlier tests' imperative dialogs may still be mounted: find this one by name.
    const dialog = await screen.findByRole('dialog', { name: '“notes.md” is already in repo' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep both' }));
    await waitFor(() =>
      expect(fs.api.upload).toHaveBeenLastCalledWith(
        expect.objectContaining({ onClash: 'keep-both' }),
      ),
    );
    expect(await screen.findByText('notes.md (2)')).toBeInTheDocument();
    expect(fs.state['notes.md']).toBe('mine');
  });

  it('cancelling the clash prompt copies nothing', async () => {
    await mountWithFiles({ ...TREE, 'notes.md': 'mine' });
    fireEvent.drop(screen.getByTestId('explorer-tree'), { dataTransfer: files('notes.md') });
    const dialog = await screen.findByRole('dialog', { name: '“notes.md” is already in repo' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('explorer-upload')).toBeNull());
    expect(fs.api.upload).toHaveBeenCalledTimes(1);
    expect(fs.state['notes.md']).toBe('mine');
  });

  it("onto a host's root: uploads, shows the progress in the footer, and Cancel stops it", async () => {
    // The official build's hosts store, as core's host directory reads it.
    const id = 'host-1';
    const hosts = [{ id, label: 'build-box' }];
    registerHostSource({ list: () => hosts, subscribe: () => () => {} });
    host.id = id;
    try {
      await mountWithFiles();
      let finish: (v: Record<string, unknown>) => void = () => {};
      fs.api.upload.mockImplementationOnce(
        () => new Promise<Record<string, unknown>>((r) => (finish = r)),
      );
      fireEvent.drop(screen.getByTestId('explorer-tree'), {
        dataTransfer: files('a.bin', 'b.bin'),
      });
      const footer = await screen.findByTestId('explorer-upload');
      expect(footer).toHaveTextContent('Preparing the upload to build-box…');
      const { uploadId } = fs.api.upload.mock.calls[0][0];
      act(() =>
        fs.uploadProgress({
          uploadId,
          done: 1,
          total: 2,
          bytes: 1.5 * 1024 * 1024,
          totalBytes: 4 * 1024 * 1024,
        }),
      );
      expect(footer).toHaveTextContent('Uploading 2 files to build-box - 1.5 of 4.0 MB');
      await user.click(within(footer).getByRole('button', { name: 'Cancel' }));
      expect(fs.api.uploadCancel).toHaveBeenCalledWith(uploadId);
      await act(async () =>
        finish({ ok: false, cancelled: true, copied: ['a.bin'], skipped: [], errors: [] }),
      );
      await waitFor(() => expect(screen.queryByTestId('explorer-upload')).toBeNull());
      // A cancel the user asked for is not reported as a failure.
      expect(screen.queryByRole('dialog', { name: /left out|not copied|Could not/ })).toBeNull();
    } finally {
      resetHostSourceForTest();
    }
  });

  it('reports what was left out once the copy ends', async () => {
    await mountWithFiles();
    fs.api.upload.mockResolvedValueOnce({
      ok: true,
      copied: ['site/index.html'],
      skipped: [{ path: 'site/current', reason: 'a link - not copied' }],
      errors: [],
    });
    fireEvent.drop(screen.getByTestId('explorer-tree'), { dataTransfer: files('site') });
    const dialog = await screen.findByRole('dialog', { name: 'Some items were left out' });
    expect(dialog).toHaveTextContent('site/current - a link - not copied');
  });
});

// Rows drag out of the tree onto a terminal, which types their paths
// (lib/terminal/file-drop.ts) - and a row dragged within the tree is no
// upload of files.
describe('dragging rows out', () => {
  const dragStart = (el: HTMLElement) => {
    const data: Record<string, string> = {};
    const dataTransfer = {
      setData: (t: string, v: string) => (data[t] = v),
      effectAllowed: 'none',
    };
    fireEvent.dragStart(el, { dataTransfer });
    return { data, dataTransfer };
  };

  it('carries a file row’s path and the machine it lives on', async () => {
    await mount();
    const { data, dataTransfer } = dragStart(screen.getByRole('button', { name: 'README.md' }));
    expect(JSON.parse(data['application/x-double0-explorer-paths'])).toEqual({
      hostId: null,
      paths: [`${ROOT}/README.md`],
    });
    expect(data['text/plain']).toBe(`${ROOT}/README.md`);
    expect(dataTransfer.effectAllowed).toBe('copy');
  });

  it('carries a folder row’s path too', async () => {
    await mount();
    const row = screen.getByRole('button', { name: 'src' }).closest('[data-drop-dir]');
    const { data } = dragStart(row as HTMLElement);
    expect(data['text/plain']).toBe(`${ROOT}/src`);
  });
});
