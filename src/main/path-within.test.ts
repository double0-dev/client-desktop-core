import { describe, expect, it } from 'vitest';
import { isAbsolutePath, isWithin, relativeWithin } from './path-within';

describe('isWithin - the path-boundary check every scope match uses', () => {
  it('reads one Windows folder however its separators and drive letter are spelled', () => {
    // Claude Code writes `c:/…` for the session's `C:\…` folder: the tool
    // title showed the whole absolute path (review, 2026-10-29).
    expect(isWithin('c:/Users/emmaw/acme/src/a.ts', 'C:\\Users\\emmaw\\acme')).toBe(true);
    expect(isWithin('C:\\USERS\\EMMAW\\ACME', 'c:/users/emmaw/acme/')).toBe(true);
    expect(isWithin('\\\\server\\Share\\acme\\x', '\\\\SERVER\\share\\acme')).toBe(true);
    expect(relativeWithin('c:/Users/emmaw/acme/src/a.ts', 'C:\\Users\\emmaw\\acme')).toBe(
      'src/a.ts',
    );
    // Still a boundary, and still not a sibling sharing the prefix.
    expect(isWithin('C:\\Users\\emmaw\\acme-old', 'c:/users/emmaw/acme')).toBe(false);
  });

  it('keeps POSIX paths case-sensitive', () => {
    expect(isWithin('/Users/emmaw/ACME/src', '/Users/emmaw/acme')).toBe(false);
  });
  it('matches the folder itself and anything below it, trailing separators aside', () => {
    expect(isWithin('/Users/emmaw/code/acme', '/Users/emmaw/code/acme/')).toBe(true);
    expect(isWithin('/Users/emmaw/code/acme/api/src', '/Users/emmaw/code/acme')).toBe(true);
    expect(isWithin('/anything', '/')).toBe(true);
  });

  it('never lets a folder swallow a sibling sharing its prefix', () => {
    expect(isWithin('/Users/emmaw/code/acme-docs', '/Users/emmaw/code/acme')).toBe(false);
  });

  it('understands Windows separators', () => {
    // Child repo paths come from `path.join`, so on Windows a session folder
    // below a repo reads `C:\code\acme\api\.worktree\fix`. A `/`-only check
    // matched nothing there and the session fell back to the project's ticks.
    expect(isWithin('C:\\code\\acme\\api\\.worktree\\fix', 'C:\\code\\acme\\api')).toBe(true);
    expect(isWithin('C:\\code\\acme\\api-docs', 'C:\\code\\acme\\api')).toBe(false);
  });
});

describe('relativeWithin / isAbsolutePath', () => {
  it('shortens a path below the folder, with either separator', () => {
    expect(relativeWithin('/Users/emmaw/acme/src/a.ts', '/Users/emmaw/acme/')).toBe('src/a.ts');
    expect(relativeWithin('C:\\acme\\src\\a.ts', 'C:\\acme')).toBe('src\\a.ts');
  });

  it('leaves a path outside the folder, or the folder itself, whole', () => {
    expect(relativeWithin('C:\\acme-docs\\a.md', 'C:\\acme')).toBe('C:\\acme-docs\\a.md');
    expect(relativeWithin('/Users/emmaw/acme', '/Users/emmaw/acme')).toBe('/Users/emmaw/acme');
    expect(relativeWithin('/a/b', '')).toBe('/a/b');
  });

  it('knows absolute paths of both platforms', () => {
    for (const p of ['/a', '\\a', 'C:\\a', 'c:/a']) expect(isAbsolutePath(p)).toBe(true);
    for (const p of ['a', 'src/a.ts', 'C:a']) expect(isAbsolutePath(p)).toBe(false);
  });
});
