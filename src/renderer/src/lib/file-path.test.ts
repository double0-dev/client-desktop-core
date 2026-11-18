import { describe, expect, it } from 'vitest';
import { splitFilePath } from '@renderer/lib/file-path';

describe('splitFilePath', () => {
  it('keeps the leading slash with the file name so it survives truncation', () => {
    expect(splitFilePath('src/auth/session.ts')).toEqual({ dir: 'src/auth', name: '/session.ts' });
    expect(splitFilePath('tests/integration/auth/clock-skew.test.ts')).toEqual({
      dir: 'tests/integration/auth',
      name: '/clock-skew.test.ts',
    });
  });

  it('gives a root-level file no directory and no slash', () => {
    expect(splitFilePath('README.md')).toEqual({ dir: '', name: 'README.md' });
    expect(splitFilePath('.gitignore')).toEqual({ dir: '', name: '.gitignore' });
  });

  it('treats dotfiles inside folders like any other file', () => {
    expect(splitFilePath('.github/workflows/ci.yml')).toEqual({
      dir: '.github/workflows',
      name: '/ci.yml',
    });
  });

  it('leaves an absolute path rooted (the leading slash belongs to the first segment)', () => {
    expect(splitFilePath('/etc/hosts')).toEqual({ dir: '/etc', name: '/hosts' });
  });
});
