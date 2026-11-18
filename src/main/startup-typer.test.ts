import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AFTER_PROMPT_QUIET_MS,
  LAUNCH_ENV,
  ECHO_HOLD_CHARS,
  ECHO_HOLD_MS,
  LAUNCH_LINE,
  LAUNCH_MARK,
  MAX_WAIT_MS,
  MISSING_MARK_QUIET_MS,
  StartupTyper,
  UNMARKED_QUIET_MS,
  TypedEchoHold,
  claimLaunchScript,
  launchScript,
  launchScriptPaths,
  WINDOWS_LAUNCH_ENV,
  windowsLaunch,
} from './startup-typer';

/**
 * When a tab's start command is typed (pty-host.test.ts drives it through a
 * host) and the launch script a POSIX shell sources, under the real shells.
 */

afterEach(() => vi.useRealTimers());

const typer = (promptMarks: boolean) => {
  const typed: string[] = [];
  const t = new StartupTyper({ line: 'claude-personal', promptMarks }, (s) => typed.push(s));
  return { t, typed };
};

describe('StartupTyper', () => {
  it('types nothing before the shell has written anything', () => {
    vi.useFakeTimers();
    const { typed } = typer(false);
    vi.advanceTimersByTime(MAX_WAIT_MS * 2);
    expect(typed).toEqual([]);
  });

  it('falls back to a long quiet when the expected prompt mark never comes', () => {
    // An rc that hands the session to another pty (Kiro's terminal wrapper)
    // starts a shell that never read our integration: no marks at all.
    vi.useFakeTimers();
    const { t, typed } = typer(true);
    t.output(false);
    vi.advanceTimersByTime(UNMARKED_QUIET_MS);
    expect(typed).toEqual([]);
    vi.advanceTimersByTime(MISSING_MARK_QUIET_MS - UNMARKED_QUIET_MS);
    expect(typed).toEqual(['claude-personal\r']);
  });

  it('switches to the short quiet once a prompt mark shows', () => {
    vi.useFakeTimers();
    const { t, typed } = typer(true);
    t.output(false);
    vi.advanceTimersByTime(500);
    t.output(true);
    vi.advanceTimersByTime(AFTER_PROMPT_QUIET_MS);
    expect(typed).toEqual(['claude-personal\r']);
  });

  it('types after the cap even while the output never goes quiet', () => {
    vi.useFakeTimers();
    const { t, typed } = typer(false);
    for (let elapsed = 0; elapsed < MAX_WAIT_MS; elapsed += 100) {
      t.output(false);
      vi.advanceTimersByTime(100);
    }
    expect(typed).toEqual(['claude-personal\r']);
  });

  it('never types once disposed', () => {
    vi.useFakeTimers();
    const { t, typed } = typer(false);
    t.output(false);
    t.dispose();
    t.output(false);
    vi.advanceTimersByTime(MAX_WAIT_MS);
    expect(typed).toEqual([]);
  });
});

const shells = ['/bin/sh', '/bin/bash', '/bin/zsh'].filter((s) => existsSync(s));

describe.skipIf(process.platform === 'win32')('the launch script under a real shell', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(shells)(
    'runs the command with the interactive shell state, once, and removes itself (%s)',
    (shell) => {
      dir = mkdtempSync(join(tmpdir(), 'double0-launch-test-'));
      const script = join(dir, 'tab.sh');
      // A function stands in for the user's alias: it exists only in the shell
      // that typed the line, never in a fresh `sh -c`.
      // Where the host's claim leaves it before the line is typed.
      writeFileSync(script, launchScript('export PIN=1; greet "$PIN"\nunset PIN'), 'utf8');
      expect(claimLaunchScript(script)).toBe(true);
      // Taken once: a second claim (or one after the shell took it) fails.
      expect(claimLaunchScript(script)).toBe(false);
      const r = spawnSync(
        shell,
        [
          '-c',
          `greet() { echo "hi $1"; }\n${LAUNCH_LINE}\necho "left=\${${LAUNCH_ENV}-unset}|\${PIN-unset}"`,
        ],
        { env: { PATH: '/usr/bin:/bin', [LAUNCH_ENV]: script }, encoding: 'utf8' },
      );
      expect(r.stderr).toBe('');
      // Its first output is the mark that ends the hidden echo of the typed
      // line (TypedEchoHold) - before anything the command draws.
      expect(r.stdout).toBe('\x1b]6791;launch\x07hi 1\nleft=unset|unset\n');
      for (const path of launchScriptPaths(script)) expect(existsSync(path)).toBe(false);
    },
  );
});

describe.skipIf(process.platform === 'win32')('launchScript and the agent folders', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // A start command `claude` on a host whose profile never puts ~/.local/bin
  // on PATH (plan 30 › M1.2): the script appends it after the mark.
  it.each(['/bin/sh', '/bin/bash', '/bin/zsh'].filter((s) => existsSync(s)))(
    'finds a CLI in ~/.local/bin, the mark still first (%s)',
    (shell) => {
      dir = mkdtempSync(join(tmpdir(), 'double0-launch-bins-'));
      const bin = join(dir, '.local', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'fake-agent'), '#!/bin/sh\necho agent-ran\n');
      chmodSync(join(bin, 'fake-agent'), 0o755);
      const script = join(dir, 'tab.sh');
      writeFileSync(script, launchScript('fake-agent'), 'utf8');
      expect(claimLaunchScript(script)).toBe(true);
      const r = spawnSync(shell, ['-c', LAUNCH_LINE], {
        env: { PATH: '/usr/bin:/bin', HOME: dir, [LAUNCH_ENV]: script },
        encoding: 'utf8',
      });
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe('\x1b]6791;launch\x07agent-ran\n');
    },
  );
});

describe('windowsLaunch', () => {
  // A command with quotes and an `&`: node-pty escapes inner quotes as `\"`,
  // which cmd.exe would pass on literally - so it travels in the env instead.
  const command = 'claude --append-system-prompt "be brief" & echo done';

  it('runs the command from the cmd.exe command line, never typed', () => {
    for (const shell of ['C:\\Windows\\system32\\cmd.exe', 'CMD.EXE', 'cmd']) {
      expect(windowsLaunch(shell, command)).toEqual({
        args: ['/K', `%${WINDOWS_LAUNCH_ENV}%`],
        env: { [WINDOWS_LAUNCH_ENV]: command },
      });
    }
  });

  it('runs the command from the PowerShell command line and stays interactive', () => {
    for (const shell of ['powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']) {
      const launch = windowsLaunch(shell, command);
      expect(launch?.args).toEqual([
        '-NoExit',
        '-Command',
        `Invoke-Expression $env:${WINDOWS_LAUNCH_ENV}`,
      ]);
      expect(launch?.env).toEqual({ [WINDOWS_LAUNCH_ENV]: command });
    }
  });

  it('leaves a shell it does not know to the typer', () => {
    expect(windowsLaunch('C:\\Program Files\\Git\\bin\\bash.exe', command)).toBeNull();
    // Only the file name decides, not a folder named like a shell.
    expect(windowsLaunch('C:\\cmd\\nu.exe', command)).toBeNull();
  });
});

describe.runIf(process.platform === 'win32')('windowsLaunch under a real shell', () => {
  // stdin at EOF ends the interactive shell /K / -NoExit leave behind.
  const run = (shell: string, command: string) => {
    const launch = windowsLaunch(shell, command)!;
    return spawnSync(shell, launch.args, {
      env: { ...process.env, ...launch.env },
      input: '',
      encoding: 'utf8',
    });
  };

  it('keeps quotes and runs every part of a compound command (cmd.exe)', () => {
    const r = run('cmd.exe', 'echo "a b"& echo second');
    // Nothing of the command line is echoed: no `>echo "a b"` prompt row.
    expect(r.stdout).toContain('"a b"');
    expect(r.stdout).toContain('second');
    expect(r.stdout).not.toContain('echo');
  });

  it('keeps quotes in the command (PowerShell)', () => {
    const r = run('powershell.exe', 'Write-Output "a b"; Write-Output second');
    expect(r.stdout).toContain('a b');
    expect(r.stdout).toContain('second');
    expect(r.stdout).not.toContain('Write-Output');
  });
});

describe('TypedEchoHold', () => {
  const hold = () => {
    const shown: string[] = [];
    return { h: new TypedEchoHold((d) => shown.push(d)), shown };
  };

  it('drops the echo of the typed line and erases the prompt row it stood on', () => {
    vi.useFakeTimers();
    const { h, shown } = hold();
    // A new tab showed ` . "$DOUBLE0_LAUNCH"` at its prompt: the line editor's
    // echo, chunked as it pleases, then Enter's newline.
    expect(h.take(' . "$DOUBLE0')).toBe('');
    expect(h.take('_LAUNCH"\r\n')).toBe('');
    expect(h.done).toBe(false);
    // The script's mark: the cursor is still on the prompt row (the newline
    // was dropped too), so that row goes and the program draws from there.
    expect(h.take(`${LAUNCH_MARK}agent frame`)).toBe(`\r\x1b[2K${LAUNCH_MARK}agent frame`);
    expect(h.done).toBe(true);
    expect(h.take('more')).toBe('more');
    vi.advanceTimersByTime(ECHO_HOLD_MS * 2);
    expect(shown).toEqual([]);
  });

  it('keeps the mode switches of the hidden echo', () => {
    // zsh turns bracketed paste off at Enter; dropped, the terminal would
    // keep wrapping pastes for a program that never asked for it.
    const { h } = hold();
    // (Captured from a real zsh; the title its preexec hook sets goes.)
    h.take(' \b . "$DOUBLE0_LAUNCH"\x1b[?1l\x1b>\x1b[?2004l\r\r\n\x1b]2;. "$DOUBLE0_LAUNCH"\x07');
    expect(h.take(`${LAUNCH_MARK}x`)).toBe(`\x1b[?1l\x1b>\x1b[?2004l\r\x1b[2K${LAUNCH_MARK}x`);
    h.dispose();
  });

  it('finds a mark split across chunks', () => {
    const { h } = hold();
    h.take(`echo\r\n${LAUNCH_MARK.slice(0, 5)}`);
    expect(h.take(`${LAUNCH_MARK.slice(5)}x`)).toBe(`\r\x1b[2K${LAUNCH_MARK}x`);
  });

  it('shows everything it held when the mark never comes', () => {
    // The line did not run (a shell that was not at a prompt): what was
    // written meanwhile is real output and must not be lost.
    vi.useFakeTimers();
    const { h, shown } = hold();
    expect(h.take('compiling...\r\n')).toBe('');
    vi.advanceTimersByTime(ECHO_HOLD_MS);
    expect(shown).toEqual(['compiling...\r\n']);
    expect(h.done).toBe(true);
    expect(h.take('next')).toBe('next');
  });

  it('gives up on output far too long to be an echo', () => {
    const { h } = hold();
    const flood = 'x'.repeat(ECHO_HOLD_CHARS + 1);
    expect(h.take(flood)).toBe(flood);
    expect(h.done).toBe(true);
  });

  it('shows nothing once disposed', () => {
    vi.useFakeTimers();
    const { h, shown } = hold();
    h.take('echo');
    h.dispose();
    vi.advanceTimersByTime(ECHO_HOLD_MS * 2);
    expect(shown).toEqual([]);
  });
});
