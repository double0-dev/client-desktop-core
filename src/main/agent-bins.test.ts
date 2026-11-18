import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_BINS_SNIPPET, AGENT_BIN_DIRS, withAgentBinsOnPath } from './agent-bins';
import { SIGN_IN_AGENTS } from './agent-table';

/**
 * The agent CLIs' install folders on every shell's PATH (plan 30 › M1.2).
 * Found on a user's Ubuntu server: Claude Code installed as root to
 * ~/.local/bin, which root's ~/.profile never puts on PATH - every session
 * said `claude: command not found` while the Agents list said installed.
 */

describe('AGENT_BIN_DIRS', () => {
  it("is the installers' folders from the sign-in table, each once", () => {
    expect(AGENT_BIN_DIRS).toEqual(['.local/bin', '.claude/local', '.opencode/bin']);
    for (const a of SIGN_IN_AGENTS) {
      for (const bin of a.homeBins) {
        expect(AGENT_BIN_DIRS).toContain(bin.slice(0, bin.lastIndexOf('/')));
      }
    }
  });
});

describe('withAgentBinsOnPath', () => {
  const exists = new Set(['/home/emmaw/.local/bin', '/home/emmaw/.opencode/bin']);
  const isDir = (p: string): boolean => exists.has(p);

  it('appends only the folders that exist, after everything already there', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/emmaw' };
    const out = withAgentBinsOnPath(env, '/home/emmaw/', isDir, 'linux');
    // Appended: a claude the user installed in /usr/local/bin still wins.
    expect(out.PATH).toBe(
      '/usr/local/bin:/usr/bin:/home/emmaw/.local/bin:/home/emmaw/.opencode/bin',
    );
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
  });

  it('never doubles a folder already on PATH, wherever it is', () => {
    const env = { PATH: '/home/emmaw/.local/bin:/usr/bin:/home/emmaw/.opencode/bin' };
    expect(withAgentBinsOnPath(env, '/home/emmaw', isDir, 'linux')).toBe(env);
  });

  it('sets a PATH when there was none, and does nothing on Windows', () => {
    expect(withAgentBinsOnPath({}, '/home/emmaw', isDir, 'darwin').PATH).toBe(
      '/home/emmaw/.local/bin:/home/emmaw/.opencode/bin',
    );
    const win = { Path: 'C:\\Windows' };
    expect(withAgentBinsOnPath(win, 'C:\\Users\\emmaw', () => true, 'win32')).toBe(win);
  });
});

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh'].filter((s) => existsSync(s));

describe.skipIf(process.platform === 'win32')('AGENT_BINS_SNIPPET under a real shell', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'double0-agent-bins-'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const bin = join(home, '.local', 'bin', 'fake-agent');
    writeFileSync(bin, '#!/bin/sh\necho agent-ran\n');
    chmodSync(bin, 0o755);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it.each(SHELLS)('appends an existing folder once and finds the CLI there (%s)', (shell) => {
    const r = spawnSync(
      shell,
      ['-c', `${AGENT_BINS_SNIPPET}\n${AGENT_BINS_SNIPPET}\nprintf '%s\\n' "$PATH"; fake-agent`],
      { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' },
    );
    expect(r.stderr).toBe('');
    // Missing folders (.opencode/bin, .claude/local) are skipped; run twice, added once.
    expect(r.stdout).toBe(`/usr/bin:/bin:${home}/.local/bin\nagent-ran\n`);
  });

  it.each(SHELLS)('keeps a folder the user put first where it is (%s)', (shell) => {
    const first = `${home}/.local/bin:/usr/bin:/bin`;
    const r = spawnSync(shell, ['-c', `${AGENT_BINS_SNIPPET}\nprintf '%s' "$PATH"`], {
      env: { HOME: home, PATH: first },
      encoding: 'utf8',
    });
    expect(r.stdout).toBe(first);
  });
});
