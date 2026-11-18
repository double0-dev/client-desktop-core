import { describe, expect, it } from 'vitest';

import { extraToolDirs, loginShellFor } from './user-path';

describe('loginShellFor', () => {
  it('asks the account’s own shell when $SHELL is unset', () => {
    // A .desktop launch may carry no SHELL; the old zsh fallback does not
    // exist on a stock Ubuntu, and the login PATH was lost with it.
    expect(loginShellFor('linux', undefined, '/bin/bash')).toBe('/bin/bash');
    expect(loginShellFor('linux', undefined, '/usr/bin/fish')).toBe('/usr/bin/fish');
  });

  it('falls back to bash on Linux and zsh on macOS', () => {
    expect(loginShellFor('linux', undefined, null)).toBe('/bin/bash');
    expect(loginShellFor('darwin', undefined, null)).toBe('/bin/zsh');
  });

  it('keeps $SHELL first', () => {
    expect(loginShellFor('linux', '/usr/bin/zsh', '/bin/bash')).toBe('/usr/bin/zsh');
  });
});

describe('extraToolDirs', () => {
  it('adds the Linux tool folders a .desktop launch does not inherit', () => {
    const dirs = extraToolDirs('linux', '/home/emmaw');
    expect(dirs).toEqual(
      expect.arrayContaining([
        '/snap/bin',
        '/home/linuxbrew/.linuxbrew/bin',
        '/home/emmaw/.npm-global/bin',
        '/home/emmaw/.local/bin',
      ]),
    );
    expect(dirs).not.toContain('/opt/homebrew/bin');
  });

  it('keeps Homebrew first on macOS', () => {
    const dirs = extraToolDirs('darwin', '/Users/emmaw');
    expect(dirs[0]).toBe('/opt/homebrew/bin');
    expect(dirs).not.toContain('/snap/bin');
  });
});
