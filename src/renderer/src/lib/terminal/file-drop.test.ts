import { describe, expect, it } from 'vitest';
import {
  EXPLORER_DRAG_MIME,
  acceptsTerminalDrag,
  decodeExplorerDrag,
  droppedPathsText,
  encodeExplorerDrag,
  quoteDroppedPath,
  terminalDragKind,
  terminalDropPaths,
} from './file-drop';

describe('terminalDragKind', () => {
  it('tells an explorer row from OS files and ignores other drags', () => {
    expect(terminalDragKind([EXPLORER_DRAG_MIME, 'text/plain'])).toBe('explorer');
    expect(terminalDragKind(['Files'])).toBe('os');
    expect(terminalDragKind(['text/plain'])).toBeNull();
    expect(terminalDragKind(null)).toBeNull();
  });
});

describe('acceptsTerminalDrag', () => {
  it("refuses OS files over a host's terminal - their paths are this computer's", () => {
    expect(acceptsTerminalDrag('os', null)).toBe(true);
    expect(acceptsTerminalDrag('os', 'h1')).toBe(false);
    expect(acceptsTerminalDrag('explorer', 'h1')).toBe(true);
    expect(acceptsTerminalDrag(null, null)).toBe(false);
  });
});

describe('quoteDroppedPath', () => {
  it('leaves a plain path alone', () => {
    expect(quoteDroppedPath('/Users/emmaw/acme/src/index.ts', 'posix')).toBe(
      '/Users/emmaw/acme/src/index.ts',
    );
  });

  it('backslash-escapes what a POSIX shell would split or expand', () => {
    expect(quoteDroppedPath('/tmp/My File (1).png', 'posix')).toBe('/tmp/My\\ File\\ \\(1\\).png');
    expect(quoteDroppedPath("/tmp/it's $HOME*", 'posix')).toBe("/tmp/it\\'s\\ \\$HOME\\*");
  });

  it('single-quotes a path holding a newline (a backslash cannot escape one)', () => {
    expect(quoteDroppedPath("/tmp/a\nb'c", 'posix')).toBe("'/tmp/a\nb'\\''c'");
  });

  it('double-quotes a Windows path only when it needs it', () => {
    expect(quoteDroppedPath('C:\\acme\\a.txt', 'windows')).toBe('C:\\acme\\a.txt');
    expect(quoteDroppedPath('C:\\Program Files\\a.txt', 'windows')).toBe(
      '"C:\\Program Files\\a.txt"',
    );
  });
});

describe('droppedPathsText', () => {
  it('joins several paths with spaces and ends with one, ready for the next word', () => {
    expect(droppedPathsText(['/a/b.ts', '/a/c d.ts'], 'posix')).toBe('/a/b.ts /a/c\\ d.ts ');
    expect(droppedPathsText([], 'posix')).toBe('');
  });
});

describe('explorer drag payload', () => {
  it('round-trips and rejects malformed data', () => {
    const raw = encodeExplorerDrag({ hostId: null, paths: ['/a/b.ts'] });
    expect(decodeExplorerDrag(raw)).toEqual({ hostId: null, paths: ['/a/b.ts'] });
    expect(decodeExplorerDrag('')).toBeNull();
    expect(decodeExplorerDrag('{nope')).toBeNull();
    expect(decodeExplorerDrag(JSON.stringify({ hostId: 3, paths: ['/a'] }))).toBeNull();
    expect(decodeExplorerDrag(JSON.stringify({ hostId: null, paths: [] }))).toBeNull();
  });
});

describe('terminalDropPaths', () => {
  const explorer = (hostId: string | null): string =>
    encodeExplorerDrag({ hostId, paths: ['/srv/acme/a.ts'] });

  it("takes an explorer drag only onto a terminal on the paths' machine", () => {
    expect(terminalDropPaths({ explorer: explorer('h1'), osPaths: [] }, 'h1')).toEqual([
      '/srv/acme/a.ts',
    ]);
    // A host's path typed into a local shell would name a file that is not there.
    expect(terminalDropPaths({ explorer: explorer('h1'), osPaths: [] }, null)).toBeNull();
    expect(terminalDropPaths({ explorer: explorer(null), osPaths: [] }, 'h1')).toBeNull();
  });

  it('prefers the explorer payload over the OS files the same drag may carry', () => {
    expect(terminalDropPaths({ explorer: explorer(null), osPaths: ['/x'] }, null)).toEqual([
      '/srv/acme/a.ts',
    ]);
  });

  it('takes OS files onto a local terminal only, skipping files with no path', () => {
    expect(terminalDropPaths({ explorer: '', osPaths: ['/a', '', '/b'] }, null)).toEqual([
      '/a',
      '/b',
    ]);
    expect(terminalDropPaths({ explorer: '', osPaths: ['/a'] }, 'h1')).toBeNull();
    expect(terminalDropPaths({ explorer: '', osPaths: [''] }, null)).toBeNull();
  });
});
