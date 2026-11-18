import type { ILink, Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearFileLinkCache,
  createFileLinkProvider,
  findFilePaths,
  isExistingFile,
  resolveFilePath,
  setFileLinkContext,
  setTerminalCwd,
  forgetTerminalCwd,
} from '@renderer/lib/terminal/file-links';

const paths = (text: string) => findFilePaths(text).map((m) => m.path);

describe('findFilePaths', () => {
  it('finds the paths compilers, test runners and agents print', () => {
    expect(paths('src/auth/token.service.ts:42:7 - error TS2532')).toEqual([
      'src/auth/token.service.ts',
    ]);
    expect(paths('⏺ Update(src/routes/login.tsx)')).toEqual(['src/routes/login.tsx']);
    expect(paths(' FAIL  ./lib/session.test.ts > refresh')).toEqual(['./lib/session.test.ts']);
    expect(paths('see ../shared/README.md and /etc/hosts')).toEqual([
      '../shared/README.md',
      '/etc/hosts',
    ]);
    expect(paths('edited package.json')).toEqual(['package.json']);
  });

  it('reads the position suffix in both common shapes', () => {
    expect(findFilePaths('a/b.ts:42:7')[0].position).toEqual({ line: 42, column: 7 });
    expect(findFilePaths('a/b.ts:42')[0].position).toEqual({ line: 42 });
    expect(findFilePaths('b.ts(12,5): error')[0].position).toEqual({ line: 12, column: 5 });
  });

  it('spans the position suffix, so the whole of `file:42:7` underlines', () => {
    const text = 'at src/x.ts:42:7 here';
    const [m] = findFilePaths(text);
    expect(text.slice(m.start, m.end)).toBe('src/x.ts:42:7');
  });

  it('drops a sentence-final dot', () => {
    const [m] = findFilePaths('Updated src/x.ts.');
    expect(m.path).toBe('src/x.ts');
    expect(m.end).toBe('Updated src/x.ts'.length);
  });

  it('leaves words, versions and URLs alone', () => {
    // A web link is the web-links addon's; a version number is not a file.
    expect(paths('bump to 0.4.2 now')).toEqual([]);
    expect(paths('plain words only')).toEqual([]);
    expect(paths('https://github.com/acme/production-pipeline/blob/main/a.ts')).toEqual([]);
  });
});

describe('resolveFilePath', () => {
  it('joins relative paths to the folder and normalises dots', () => {
    expect(resolveFilePath('src/a.ts', '/repo')).toBe('/repo/src/a.ts');
    expect(resolveFilePath('./a.ts', '/repo/web')).toBe('/repo/web/a.ts');
    expect(resolveFilePath('../shared/b.ts', '/repo/web')).toBe('/repo/shared/b.ts');
  });

  it('keeps absolute paths and refuses a relative one with no folder', () => {
    expect(resolveFilePath('/etc/hosts', null)).toBe('/etc/hosts');
    expect(resolveFilePath('a.ts', null)).toBeNull();
  });
});

describe('existence and the provider', () => {
  const readDir = vi.fn(async (dir: string) => ({
    entries:
      dir === '/repo/src'
        ? [
            { name: 'a.ts', path: '/repo/src/a.ts', isDirectory: false },
            { name: 'lib', path: '/repo/src/lib', isDirectory: true },
          ]
        : [],
  }));

  beforeEach(() => {
    clearFileLinkCache();
    readDir.mockClear();
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { fs: { readDir } },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('links files only - not missing paths, not folders', async () => {
    expect(await isExistingFile('/repo/src/a.ts')).toBe(true);
    expect(await isExistingFile('/repo/src/b.ts')).toBe(false);
    expect(await isExistingFile('/repo/src/lib')).toBe(false);
    // One listing per folder while cached - hovering re-asks on every move.
    expect(readDir).toHaveBeenCalledTimes(1);
  });

  /** A buffer of rows; `wrapped` marks rows soft-wrapped onto the one before.
   * A character followed by '\u0000' is wide (two cells). */
  const bufferOf = (rows: string[], wrapped: boolean[] = []) => ({
    getLine: (y: number) => {
      const row = rows[y];
      if (row === undefined) return undefined;
      return {
        isWrapped: !!wrapped[y],
        length: row.length,
        getCell: (x: number) => {
          const ch = row[x];
          if (ch === undefined) return undefined;
          if (ch === '\u0000') return { getChars: () => '', getWidth: () => 0 };
          return { getChars: () => ch, getWidth: () => (row[x + 1] === '\u0000' ? 2 : 1) };
        },
      };
    },
  });
  const termOf = (rows: string[], wrapped: boolean[] = []): Terminal =>
    ({
      element: document.createElement('div'),
      buffer: { active: bufferOf(rows, wrapped) },
    }) as unknown as Terminal;
  const termWith = (line: string): Terminal => termOf([line]);

  const linksFor = (term: Terminal, id: string, y = 1): Promise<ILink[] | undefined> =>
    new Promise((resolve) => createFileLinkProvider(id, term).provideLinks(y, resolve));

  it('keeps the click range on the path after a wide character', async () => {
    // Text indices are not cells: the emoji takes two (review, 2026-10-06).
    const off = setFileLinkContext('pty-fl-w', { cwd: '/repo', open: vi.fn() });
    const links = await linksFor(termWith('✨\u0000 src/a.ts:3'), 'pty-fl-w');
    expect(links![0].range).toEqual({ start: { x: 4, y: 1 }, end: { x: 13, y: 1 } });
    off();
  });

  it("resolves against the shell's current folder once it reported one", async () => {
    // After `cd src` a printed `a.ts` is /repo/src/a.ts, not /repo/a.ts.
    const open = vi.fn();
    const off = setFileLinkContext('pty-fl-cd', { cwd: '/', open });
    setTerminalCwd('pty-fl-cd', '/repo');
    const links = await linksFor(termWith('src/a.ts:5'), 'pty-fl-cd');
    links![0].activate({ ctrlKey: true, metaKey: false } as MouseEvent, links![0].text);
    expect(open).toHaveBeenCalledWith('/repo/src/a.ts', { line: 5 });
    forgetTerminalCwd('pty-fl-cd');
    off();
  });

  it('links a path wrapped onto the next row, from either row', async () => {
    const open = vi.fn();
    const off = setFileLinkContext('pty-fl-r', { cwd: '/repo', open });
    const term = termOf(['err src/', 'a.ts:42 x'], [false, true]);
    for (const y of [1, 2]) {
      const links = await linksFor(term, 'pty-fl-r', y);
      expect(links![0].range).toEqual({ start: { x: 5, y: 1 }, end: { x: 7, y: 2 } });
      links![0].activate({ ctrlKey: true, metaKey: false } as MouseEvent, links![0].text);
    }
    expect(open).toHaveBeenLastCalledWith('/repo/src/a.ts', { line: 42 });
    off();
  });

  it('opens an existing file at its position on a modifier click only', async () => {
    const open = vi.fn();
    const off = setFileLinkContext('pty-fl-1', { cwd: '/repo', open });
    const links = await linksFor(termWith('src/a.ts:42:7 and src/missing.ts:1'), 'pty-fl-1');
    expect(links).toHaveLength(1);
    expect(links![0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: 13, y: 1 } });

    links![0].activate(new MouseEvent('click'), links![0].text);
    expect(open).not.toHaveBeenCalled();
    links![0].activate(new MouseEvent('click', { ctrlKey: true }), links![0].text);
    expect(open).toHaveBeenCalledWith('/repo/src/a.ts', { line: 42, column: 7 });
    off();
  });

  it('links nothing for a terminal no workspace view has claimed', async () => {
    expect(await linksFor(termWith('src/a.ts'), 'pty-fl-unclaimed')).toBeUndefined();
    expect(readDir).not.toHaveBeenCalled();
  });

  it('keeps the newer context when an older view unmounts late', () => {
    const first = setFileLinkContext('pty-fl-2', { cwd: '/a', open: vi.fn() });
    const secondOpen = vi.fn();
    const second = setFileLinkContext('pty-fl-2', { cwd: '/repo', open: secondOpen });
    first();
    return linksFor(termWith('src/a.ts'), 'pty-fl-2').then((links) => {
      links![0].activate(new MouseEvent('click', { ctrlKey: true }), 'src/a.ts');
      expect(secondOpen).toHaveBeenCalledWith('/repo/src/a.ts', undefined);
      second();
    });
  });
});
