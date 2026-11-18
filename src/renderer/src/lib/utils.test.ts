import { describe, expect, it } from 'vitest';
import { fileName, isPathInside, joinPath, parentDir, remapPath } from '@renderer/lib/utils';

describe('fileName', () => {
  it('returns the last segment of a POSIX path', () => {
    expect(fileName('/a/b/c.txt')).toBe('c.txt');
  });

  it('returns the last segment of a Windows path', () => {
    expect(fileName('C:\\Users\\emmaw\\file.ts')).toBe('file.ts');
  });

  it('ignores a trailing separator', () => {
    expect(fileName('/a/b/')).toBe('b');
  });
});

describe('joinPath', () => {
  it('joins with a forward slash for POSIX dirs', () => {
    expect(joinPath('/a/b', 'c')).toBe('/a/b/c');
  });

  it('does not double a trailing separator', () => {
    expect(joinPath('/a/b/', 'c')).toBe('/a/b/c');
  });

  it('uses a backslash for Windows-style dirs', () => {
    expect(joinPath('C:\\Users\\emmaw', 'file.ts')).toBe('C:\\Users\\emmaw\\file.ts');
  });
});

describe('isPathInside', () => {
  it('matches the base itself', () => {
    expect(isPathInside('/a/b', '/a/b')).toBe(true);
  });

  it('matches a nested path', () => {
    expect(isPathInside('/a/b/c/d', '/a/b')).toBe(true);
  });

  it('does not treat a sibling sharing a name prefix as inside', () => {
    expect(isPathInside('/a/bc', '/a/b')).toBe(false);
  });

  it('handles Windows separators', () => {
    expect(isPathInside('C:\\a\\b\\c', 'C:\\a\\b')).toBe(true);
  });
});

describe('parentDir', () => {
  it('returns the containing directory', () => {
    expect(parentDir('/a/b/c')).toBe('/a/b');
  });

  it('handles Windows separators', () => {
    expect(parentDir('C:\\a\\b')).toBe('C:\\a');
  });

  it('returns the path unchanged when there is no parent', () => {
    expect(parentDir('file.txt')).toBe('file.txt');
  });
});

describe('remapPath', () => {
  it('maps the root itself', () => {
    expect(remapPath('/a/old', '/a/old', '/a/new')).toBe('/a/new');
  });

  it('re-roots nested paths', () => {
    expect(remapPath('/a/old/x/y', '/a/old', '/a/new')).toBe('/a/new/x/y');
  });

  it('leaves unrelated paths unchanged', () => {
    expect(remapPath('/a/other/x', '/a/old', '/a/new')).toBe('/a/other/x');
  });

  it('leaves a sibling sharing a name prefix unchanged', () => {
    expect(remapPath('/a/older/x', '/a/old', '/a/new')).toBe('/a/older/x');
  });

  it('handles Windows separators', () => {
    expect(remapPath('C:\\p\\old\\f.ts', 'C:\\p\\old', 'C:\\p\\new')).toBe('C:\\p\\new\\f.ts');
  });
});
