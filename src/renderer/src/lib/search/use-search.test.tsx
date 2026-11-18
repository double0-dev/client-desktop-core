import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';
import { HostIndexNotes } from '@renderer/routes/_app/-components/search-everywhere/host-index-notes';
import { useFileIndex } from './use-search';

/**
 * The palette's file index (plan 29 › M5): a remote host's files land after
 * the local list, and main's `search:indexChanged` makes an open palette ask
 * again; a closed one does not listen.
 */

const file = (name: string, hostId: string | null = null) => ({
  path: `/w/${name}`,
  name,
  projectId: 'p',
  projectName: 'acme',
  hostId,
});

describe('useFileIndex', () => {
  it('asks again when a host’s index lands, only while open', async () => {
    let answer: unknown = { files: [file('main.ts')], pending: ['h1'], unreachable: [] };
    const listFiles = vi.fn(async () => answer);
    let changed: (() => void) | null = null;
    const off = vi.fn();
    stubApi({
      search: {
        listFiles,
        onIndexChanged: vi.fn((cb: () => void) => {
          changed = cb;
          return off;
        }),
      },
    });
    const { result, rerender } = renderHook(({ open }) => useFileIndex(open), {
      initialProps: { open: true },
    });
    await waitFor(() => expect(result.current.pending).toEqual(['h1']));
    answer = { files: [file('main.ts'), file('app.ts', 'h1')], pending: [], unreachable: [] };
    act(() => changed?.());
    await waitFor(() => expect(result.current.files).toHaveLength(2));
    expect(result.current.pending).toEqual([]);
    rerender({ open: false });
    expect(off).toHaveBeenCalled();
  });

  it('reads an older answer with no host fields as having none', async () => {
    stubApi({ search: { listFiles: vi.fn(async () => ({ files: [file('a.ts')] })) } });
    const { result } = renderHook(() => useFileIndex(true));
    await waitFor(() => expect(result.current.files).toHaveLength(1));
    expect(result.current).toMatchObject({ pending: [], unreachable: [] });
  });
});

describe('HostIndexNotes', () => {
  const label = (id: string) => (id === 'h1' ? 'build-box' : 'gpu-box');

  it('says which host is indexing and which is away', () => {
    render(
      <HostIndexNotes index={{ files: [], pending: ['h1'], unreachable: ['h2'] }} label={label} />,
    );
    const notes = screen.getByTestId('search-host-index');
    expect(notes).toHaveTextContent('Indexing build-box…');
    expect(notes).toHaveTextContent('gpu-box is unreachable - showing the last list');
  });

  it('shows nothing when every host is indexed', () => {
    const { container } = render(
      <HostIndexNotes index={{ files: [], pending: [], unreachable: [] }} label={label} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
