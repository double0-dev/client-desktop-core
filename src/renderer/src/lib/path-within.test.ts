import { describe, expect, it } from 'vitest';
import { folderName, isWithin, parentFolder, relativeTo } from '@renderer/lib/path-within';

describe('isWithin', () => {
  it('reads one Windows folder however its separators and drive letter are spelled', () => {
    expect(isWithin('c:/Users/emmaw/acme/src', 'C:\\Users\\emmaw\\acme')).toBe(true);
    expect(isWithin('\\\\server\\Share\\acme\\x', '\\\\SERVER\\share\\acme')).toBe(true);
    expect(isWithin('C:\\Users\\emmaw\\acme-old', 'c:/users/emmaw/acme')).toBe(false);
    // POSIX file systems are case-sensitive: no folding there.
    expect(isWithin('/Users/emmaw/ACME/src', '/Users/emmaw/acme')).toBe(false);
  });
  it('matches the folder itself and anything below it, trailing separators aside', () => {
    expect(isWithin('/Users/emmaw/code/acme/', '/Users/emmaw/code/acme')).toBe(true);
    expect(isWithin('/Users/emmaw/code/acme/api/.worktree/fix', '/Users/emmaw/code/acme/api')).toBe(
      true,
    );
    expect(isWithin('/anything', '/')).toBe(true);
  });

  it('never lets a folder swallow a sibling sharing its prefix', () => {
    expect(isWithin('/Users/emmaw/code/acme/api-docs', '/Users/emmaw/code/acme/api')).toBe(false);
  });

  it('understands Windows separators', () => {
    // Main builds child repo paths with `path.join`: backslashes on Windows.
    expect(isWithin('C:\\code\\acme\\api\\.worktree\\fix', 'C:\\code\\acme\\api')).toBe(true);
    expect(isWithin('C:\\code\\acme\\api-docs', 'C:\\code\\acme\\api')).toBe(false);
  });

  it('matches a mixed-separator Windows path against a native one', () => {
    // Sessions created on Windows before 2026-10-28 stored `C:\…/.worktree/…`.
    expect(isWithin('C:\\code\\acme/.worktree/fix/src', 'C:\\code\\acme\\.worktree\\fix')).toBe(
      true,
    );
    expect(isWithin('C:\\code\\acme\\.worktree\\fix-2', 'C:\\code\\acme/.worktree/fix')).toBe(
      false,
    );
  });

  it('matches below a drive root', () => {
    expect(isWithin('C:\\src', 'C:\\')).toBe(true);
  });
});

describe('relativeTo', () => {
  it('drops the base and its separator', () => {
    expect(relativeTo('/Users/emmaw/acme/web/src', '/Users/emmaw/acme/')).toBe('web/src');
    expect(relativeTo('C:\\Users\\emmaw\\acme\\web', 'C:\\Users\\emmaw\\acme')).toBe('web');
    expect(relativeTo('/Users/emmaw/acme', '/Users/emmaw/acme')).toBe('');
  });

  it('keeps the first character below a root', () => {
    // `slice(base.length + 1)` turned `C:\src` into `rc`.
    expect(relativeTo('C:\\src', 'C:\\')).toBe('src');
    expect(relativeTo('/src', '/')).toBe('src');
  });
});

describe('parentFolder', () => {
  it('drops the last segment with either separator', () => {
    expect(parentFolder('/Users/emmaw/code/acme/api/')).toBe('/Users/emmaw/code/acme');
    expect(parentFolder('C:\\code\\acme\\api')).toBe('C:\\code\\acme');
  });
});

describe('folderName', () => {
  it('takes the last segment with either separator', () => {
    expect(folderName('/work/acme/web/')).toBe('web');
    expect(folderName('C:\\work\\acme')).toBe('acme');
  });
});
