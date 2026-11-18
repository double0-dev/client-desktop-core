import { describe, expect, it } from 'vitest';

import { uriOf, type UriLike } from '@renderer/lib/remote-uri';
import { editorOpenTarget } from './editor-open-target';

/**
 * Where a go-to-definition into a file that is not open lands (plan 29 spec
 * › 4.3). A minimal URI stand-in: the real class is exercised in lsp-uri.test.
 */
const Uri = {
  file: (path: string): UriLike => ({ scheme: 'file', authority: '', path, fsPath: path }),
  from: (c: { scheme: string; authority?: string; path?: string }): UriLike => ({
    scheme: c.scheme,
    authority: c.authority ?? '',
    path: c.path ?? '',
    fsPath: c.authority ? `//${c.authority}${c.path}` : (c.path ?? ''),
  }),
};

/** build-box (h1) holds the acme project. */
const hostOfPath = (path: string) => (path.startsWith('/home/emmaw/acme') ? 'h1' : null);

describe('editorOpenTarget', () => {
  it('opens a local file by its path', () => {
    expect(editorOpenTarget(Uri.file('/Users/emmaw/acme/src/a.ts'), hostOfPath)).toEqual({
      path: '/Users/emmaw/acme/src/a.ts',
    });
  });

  it("opens a host file inside one of that host's projects by its path alone", () => {
    expect(editorOpenTarget(uriOf(Uri, 'h1', '/home/emmaw/acme/lib/b.py'), hostOfPath)).toEqual({
      path: '/home/emmaw/acme/lib/b.py',
    });
  });

  /** Without the host the path would name a file on THIS machine. */
  it('keeps the host for its file outside every project root (its site-packages)', () => {
    const site = '/usr/lib/python3/dist-packages/requests/api.py';
    expect(editorOpenTarget(uriOf(Uri, 'h1', site), hostOfPath)).toEqual({
      path: site,
      hostId: 'h1',
    });
    // The same path under another host's project still names THAT host.
    expect(editorOpenTarget(uriOf(Uri, 'h2', '/home/emmaw/acme/x.py'), hostOfPath)).toEqual({
      path: '/home/emmaw/acme/x.py',
      hostId: 'h2',
    });
  });

  it('ignores anything that is not a file', () => {
    expect(
      editorOpenTarget({ scheme: 'untitled', authority: '', path: 'a', fsPath: 'a' }, hostOfPath),
    ).toBeNull();
  });
});
