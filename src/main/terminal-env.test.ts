import { describe, expect, it } from 'vitest';
// The environment every pty is spawned with (terminal-env.ts). The installed
// app launched from the Finder inherits almost nothing, and what a program
// paints depends on it: Claude Code fell back to the 16 ANSI colours and the
// light-theme rewrite matched none of them (the black user bar, 2026-09-16).
import { PTY_TERM, ptyEnv, withDirOnPath } from './terminal-env';

const darwin = { appVersion: '0.1.3', platform: 'darwin' as const };

describe('ptyEnv', () => {
  it('gives a pty a truecolor terminal identity even when the app was launched with a bare environment', () => {
    const env = ptyEnv({ HOME: '/Users/emmaw', SHELL: '/bin/zsh' }, darwin);
    expect(env).toMatchObject({
      HOME: '/Users/emmaw',
      SHELL: '/bin/zsh',
      TERM: PTY_TERM,
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'double0',
      TERM_PROGRAM_VERSION: '0.1.3',
      LANG: 'en_US.UTF-8',
    });
  });

  it('asks Claude Code to repaint every cell of every fullscreen frame', () => {
    // Its incremental frames leave fragments of earlier frames in the cells a
    // new frame keeps blank once the terminal has drifted from its model (the
    // garbled reply line after a session switch, 2026-09-16); the documented
    // remedy is this variable, whatever platform the pty runs on.
    expect(ptyEnv({}, darwin).CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT).toBe('1');
    expect(
      ptyEnv({}, { appVersion: '0.1.3', platform: 'win32' }).CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT,
    ).toBe('1');
  });

  it('replaces the terminal identity the launching editor left behind', () => {
    // `pnpm dev` from an editor terminal inherits TERM_PROGRAM=vscode and
    // TERM=xterm-color from node-pty's default name; programs then behave as
    // if they ran inside that editor.
    const env = ptyEnv(
      { TERM: 'xterm-color', TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.99' },
      darwin,
    );
    expect(env.TERM).toBe(PTY_TERM);
    expect(env.TERM_PROGRAM).toBe('double0');
    expect(env.TERM_PROGRAM_VERSION).toBe('0.1.3');
  });

  it('keeps any locale the user already set', () => {
    expect(ptyEnv({ LANG: 'de_AT.UTF-8' }, darwin).LANG).toBe('de_AT.UTF-8');
    const lcAll = ptyEnv({ LC_ALL: 'C' }, darwin);
    expect(lcAll.LANG).toBeUndefined();
    expect(lcAll.LC_ALL).toBe('C');
    expect(ptyEnv({ LC_CTYPE: 'UTF-8' }, darwin).LANG).toBeUndefined();
  });

  it('falls back to the locale every Linux has', () => {
    // en_US.UTF-8 is not generated on a minimal Ubuntu or in WSL: shells
    // warned on every start and lost UTF-8. C.UTF-8 is built into glibc.
    expect(ptyEnv({}, { appVersion: '0.1.3', platform: 'linux' }).LANG).toBe('C.UTF-8');
  });

  it('sets no LANG on Windows, where the console code page rules', () => {
    expect(ptyEnv({}, { appVersion: '0.1.3', platform: 'win32' }).LANG).toBeUndefined();
  });

  it('drops undefined entries, which process.env may carry under its typing', () => {
    const env = ptyEnv({ GONE: undefined, KEPT: 'x' }, darwin);
    expect('GONE' in env).toBe(false);
    expect(env.KEPT).toBe('x');
  });

  it('drops the launch variables of the double0 tab the app was started from', () => {
    // Started inside a tab, the app inherited its DOUBLE0_START_COMMAND,
    // DOUBLE0_USAGE_FILE and the like, and every shell of the new app wrote
    // into the old tab's files.
    const env = ptyEnv(
      {
        DOUBLE0_START_COMMAND: 'claude',
        DOUBLE0_USAGE_FILE: '/tmp/double0-usage/tab-1',
        double0_tty: '/dev/ttys004',
        DOUBLE0X: 'kept',
        HOME: '/Users/emmaw',
      },
      darwin,
    );
    expect(Object.keys(env).filter((k) => /^double0_/i.test(k))).toEqual([]);
    expect(env).toMatchObject({ DOUBLE0X: 'kept', HOME: '/Users/emmaw' });
  });
});

describe('withDirOnPath', () => {
  // Windows spells it `Path`. Setting `PATH` beside it gave every terminal a
  // PATH of the tool folder alone: node, git and every tool "not recognized"
  // (2026-10-28).
  it('puts the folder first on the PATH Windows already has, never a second one', () => {
    const env = withDirOnPath(
      { Path: 'C:\\Windows;C:\\Program Files\\nodejs', TERM: PTY_TERM },
      'C:\\Temp\\double0-bin',
      'win32',
    );
    expect(env).toEqual({
      Path: 'C:\\Temp\\double0-bin;C:\\Windows;C:\\Program Files\\nodejs',
      TERM: PTY_TERM,
    });
  });

  it('prepends with the platform separator elsewhere', () => {
    expect(withDirOnPath({ PATH: '/usr/bin:/bin' }, '/tmp/tools', 'darwin')).toEqual({
      PATH: '/tmp/tools:/usr/bin:/bin',
    });
    expect(withDirOnPath({}, '/tmp/tools', 'linux')).toEqual({ PATH: '/tmp/tools' });
  });
});
