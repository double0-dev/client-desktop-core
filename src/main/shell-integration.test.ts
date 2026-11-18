import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASH_RC_NAME,
  USER_ZDOTDIR_ENV,
  bashIntegration,
  bashIntegrationFiles,
  zshIntegration,
  zshIntegrationFiles,
} from './shell-integration';
import { LAUNCH_ENV, LAUNCH_LINE, claimLaunchScript, launchScript } from './startup-typer';

/** ANSI-C quote for zsh (`$'…'`), so a newline in `s` survives the -c line. */
const shq = (s: string): string =>
  `$'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('zshIntegration', () => {
  it('applies to zsh however it is named, and to nothing else', () => {
    for (const shell of ['/bin/zsh', '/opt/homebrew/bin/zsh', '-zsh', 'zsh']) {
      expect(zshIntegration(shell, '/tmp/i', undefined)).not.toBeNull();
    }
    for (const shell of ['/bin/bash', '/usr/bin/fish', 'nu', 'zsh-5.9']) {
      expect(zshIntegration(shell, '/tmp/i', undefined)).toBeNull();
    }
  });

  it("points ZDOTDIR at the integration and passes the user's own along only when set", () => {
    expect(zshIntegration('/bin/zsh', '/tmp/i', undefined)?.env).toEqual({ ZDOTDIR: '/tmp/i' });
    expect(zshIntegration('/bin/zsh', '/tmp/i', '/Users/emmaw/.config/zsh')?.env).toEqual({
      ZDOTDIR: '/tmp/i',
      [USER_ZDOTDIR_ENV]: '/Users/emmaw/.config/zsh',
    });
  });
});

describe.skipIf(process.platform === 'win32' || !existsSync('/bin/zsh'))(
  'the zsh integration files under a real zsh',
  () => {
    let root: string;
    let integration: string;
    let home: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'double0-zsh-'));
      integration = join(root, 'integration');
      home = join(root, 'home');
      mkdirSync(integration);
      mkdirSync(home);
      for (const [name, body] of Object.entries(zshIntegrationFiles())) {
        writeFileSync(join(integration, name), body, 'utf8');
      }
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    /** Run `script` in an interactive zsh started the way terminal.ts starts one. */
    const zsh = (script: string, env: Record<string, string> = {}, interactive = true) =>
      spawnSync('/bin/zsh', interactive ? ['-i', '-c', script] : ['-c', script], {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          ZDOTDIR: integration,
          ...env,
        },
        encoding: 'utf8',
      });

    it("runs the user's own startup files and hands ZDOTDIR back as it was", () => {
      writeFileSync(join(home, '.zshenv'), 'export ENV_RAN=1\n');
      writeFileSync(
        join(home, '.zshrc'),
        'RC_RAN=1\nuser_precmd() { :; }\nprecmd_functions+=(user_precmd)\n',
      );
      const r = zsh(
        'print -r -- "$ENV_RAN|$RC_RAN|${ZDOTDIR-unset}|$precmd_functions|$preexec_functions"',
      );
      expect(r.status).toBe(0);
      // ZDOTDIR unset again - the user had none, so children start as before.
      expect(r.stdout.trim()).toBe('1|1|unset|user_precmd __double0_precmd|__double0_preexec');
    });

    // A user's ~/.local/bin is off PATH (root on Ubuntu) or a .zshrc resets
    // PATH: the agent CLIs' installers put their binaries there (plan 30).
    it("puts the agent CLIs' install folders on PATH after the user's .zshrc", () => {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      writeFileSync(join(home, '.zshrc'), 'PATH=/usr/bin:/bin\n');
      const r = zsh('print -r -- "$PATH"');
      expect(r.stdout.trim()).toBe(`/usr/bin:/bin:${home}/.local/bin`);
    });

    // A .zshrc that prepends ~/bin (which held a `claude` wrapper) put it ahead
    // of the shims: a `claude` typed at the prompt ran with no hooks.
    it('puts the agent shims back in front of PATH after a .zshrc that prepends its own', () => {
      const shims = join(root, 'shims');
      mkdirSync(shims);
      writeFileSync(join(home, '.zshrc'), 'PATH=$HOME/bin:$PATH\n');
      const r = zsh('print -r -- "$PATH"', {
        PATH: `${shims}:/usr/bin:/bin`,
        DOUBLE0_SHIM_DIR: shims,
      });
      expect(r.stdout.trim()).toBe(`${shims}:${home}/bin:${shims}:/usr/bin:/bin`);
      // Already in front: left alone. No variable: nothing added.
      writeFileSync(join(home, '.zshrc'), '');
      expect(
        zsh('print -r -- "$PATH"', {
          PATH: `${shims}:/usr/bin:/bin`,
          DOUBLE0_SHIM_DIR: shims,
        }).stdout.trim(),
      ).toBe(`${shims}:/usr/bin:/bin`);
      expect(zsh('print -r -- "$PATH"', { PATH: '/usr/bin:/bin' }).stdout.trim()).toBe(
        '/usr/bin:/bin',
      );
    });

    it("reads the user's files from their own ZDOTDIR and leaves it set", () => {
      const own = join(root, 'dotfiles');
      mkdirSync(own);
      writeFileSync(join(own, '.zshrc'), 'RC_FROM=own\n');
      writeFileSync(join(home, '.zshrc'), 'RC_FROM=home\n');
      const r = zsh('print -r -- "$RC_FROM|$ZDOTDIR"', { [USER_ZDOTDIR_ENV]: own });
      expect(r.stdout.trim()).toBe(`own|${own}`);
    });

    it('follows a ZDOTDIR the user sets in .zshenv, the way zsh itself would', () => {
      const moved = join(home, '.config', 'zsh');
      mkdirSync(moved, { recursive: true });
      writeFileSync(join(home, '.zshenv'), `ZDOTDIR=${moved}\n`);
      writeFileSync(join(moved, '.zshrc'), 'RC_FROM=moved\n');
      const r = zsh('print -r -- "$RC_FROM|$ZDOTDIR"');
      expect(r.stdout.trim()).toBe(`moved|${moved}`);
    });

    it("keeps the history file in the user's folder, not the integration's", () => {
      // macOS's /etc/zshrc runs before ours and sets
      // HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history - the integration folder at
      // that point: the tab's up-arrow had none of the user's history and
      // what they ran in it was written to the temp folder.
      const histfile = { HISTFILE: join(integration, '.zsh_history') };
      expect(zsh('print -r -- "$HISTFILE"', histfile).stdout.trim()).toBe(
        join(home, '.zsh_history'),
      );
      const own = join(root, 'dotfiles');
      mkdirSync(own);
      expect(
        zsh('print -r -- "$HISTFILE"', { ...histfile, [USER_ZDOTDIR_ENV]: own }).stdout.trim(),
      ).toBe(join(own, '.zsh_history'));
      // One the user's own file sets wins, as in any shell.
      writeFileSync(join(home, '.zshrc'), `HISTFILE=${root}/mine\n`);
      expect(zsh('print -r -- "$HISTFILE"', histfile).stdout.trim()).toBe(`${root}/mine`);
    });

    it('marks a command, its exit status and the next prompt', () => {
      const r = zsh(
        `cd ${root}; __double0_preexec "git status"; (exit 3); __double0_precmd; __double0_precmd`,
      );
      expect(r.stdout).toBe(
        `\x1b]6791;cmd;${b64('git status')}\x07` +
          // The first prompt says where the shell is; the next one, in the
          // same folder, does not repeat it.
          `\x1b]6791;cwd;${b64(root)}\x07` +
          '\x1b]6791;done;3\x07\x1b]6791;ps\x07' +
          // A prompt without a command in between reports no status.
          '\x1b]6791;ps\x07',
      );
    });

    it('reports the folder again after a cd, so file links follow the shell', () => {
      const sub = join(root, 'sub');
      mkdirSync(sub);
      const r = zsh(`cd ${root}; __double0_precmd; cd ${sub}; __double0_precmd`);
      expect(r.stdout).toBe(
        `\x1b]6791;cwd;${b64(root)}\x07\x1b]6791;ps\x07` +
          `\x1b]6791;cwd;${b64(sub)}\x07\x1b]6791;ps\x07`,
      );
    });

    it("runs a tab's launch script from the first prompt hook, with nothing typed", () => {
      // Typed at the prompt, the launch line showed in every new tab until
      // the program covered it. The first precmd sources the script instead:
      // the mark calls main's typing off, the command sees the shell's own
      // aliases, and the script (which erases the typed line's row when it
      // WAS typed) leaves the row above alone.
      writeFileSync(join(home, '.zshrc'), "alias agent-personal='print -r -- ran:$PIN'\n");
      const script = join(root, 'tab.sh');
      writeFileSync(script, launchScript('export PIN=1; agent-personal\nunset PIN'), 'utf8');
      const r = zsh(
        `cd ${root}; __double0_precmd; print -r -- "|left=\${${LAUNCH_ENV}-unset}|\${PIN-unset}"; __double0_precmd`,
        { [LAUNCH_ENV]: script },
      );
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe(
        `\x1b]6791;cwd;${b64(root)}\x07` +
          '\x1b]6791;launch\x07ran:1\n' +
          // Not a command the user ran: no done mark. Then the first prompt.
          '\x1b]6791;ps\x07|left=unset|unset\n' +
          // Once: the next prompt finds no script.
          '\x1b]6791;ps\x07',
      );
      expect(existsSync(script)).toBe(false);
    });

    it('leaves a launch script the host already took for typing alone', () => {
      // A slow rc: the host typed the line before the first prompt. Sourcing
      // the script here as well started the agent with that line still in
      // the tty's input - it became the agent's first prompt.
      const script = join(root, 'tab.sh');
      writeFileSync(script, launchScript('print -r -- ran'), 'utf8');
      expect(claimLaunchScript(script)).toBe(true);
      const r = zsh(
        `cd ${root}; __double0_precmd >/dev/null; print -r -- "|\${${LAUNCH_ENV}-unset}"`,
        {
          [LAUNCH_ENV]: script,
        },
      );
      expect(r.stdout).toBe(`|${script}\n`);
      // And once the shell took it, the host's claim fails: nothing is typed.
      writeFileSync(script, launchScript('print -r -- ran'), 'utf8');
      expect(zsh(`cd ${root}; __double0_precmd`, { [LAUNCH_ENV]: script }).stdout).toContain('ran');
      expect(claimLaunchScript(script)).toBe(false);
    });

    it("never reports or keeps the line that sources a tab's launch script", () => {
      // The line is ours (startup-typer.ts): the Inputs list shows what the
      // user ran, and up-arrow must not find a script that deleted itself.
      const r = zsh(
        `cd ${root}; __double0_precmd >/dev/null; __double0_preexec ${shq(LAUNCH_LINE)}; __double0_precmd; ` +
          `__double0_addhistory ${shq(`${LAUNCH_LINE}\n`)}; print -r -- "|keep=$?"; ` +
          `__double0_addhistory ${shq(`${LAUNCH_LINE.trim()}\n`)}; print -r -- "|keep=$?"; ` +
          `__double0_addhistory ${shq('git status\n')}; print -r -- "|keep=$?"`,
      );
      // No cmd mark, and no done mark at the next prompt.
      expect(r.stdout).toBe('\x1b]6791;ps\x07|keep=1\n|keep=1\n|keep=0\n');
    });

    it('stays silent outside an interactive shell', () => {
      writeFileSync(join(home, '.zshenv'), 'export ENV_RAN=1\n');
      const r = zsh('print -r -- "$ENV_RAN|${+functions[__double0_precmd]}"', {}, false);
      // .zshenv still chains (a script sees the user's env), no hooks exist.
      expect(r.stdout).toBe('1|0\n');
    });

    it('installs its hooks once, whatever re-reads .zshrc', () => {
      const r = zsh(`source ${join(integration, '.zshrc')}; print -r -- "$precmd_functions"`);
      expect(r.stdout.trim()).toBe('__double0_precmd');
    });
  },
);

describe('bashIntegration', () => {
  it('starts bash however it is named on our rc file, and nothing else', () => {
    // Most Linux users run bash; without this the folder, the Inputs list and
    // the launch timing all fell back to guesses (2026-10-29).
    for (const shell of ['/bin/bash', '/usr/bin/bash', 'bash', '-bash']) {
      expect(bashIntegration(shell, '/tmp/i')).toEqual({
        env: {},
        args: ['--rcfile', `/tmp/i/${BASH_RC_NAME}`],
      });
    }
    for (const shell of ['/bin/zsh', '/bin/sh', '/usr/bin/fish', '/bin/dash']) {
      expect(bashIntegration(shell, '/tmp/i')).toBeNull();
    }
  });
});

// Linux only, like the integration itself: macOS's bash is 3.2 and unprobed.
describe.skipIf(process.platform !== 'linux' || !existsSync('/bin/bash'))(
  'the bash integration under a real bash',
  () => {
    let root: string;
    let rc: string;
    let home: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'double0-bash-'));
      home = join(root, 'home');
      mkdirSync(home);
      mkdirSync(join(root, 'integration'));
      for (const [name, body] of Object.entries(bashIntegrationFiles())) {
        writeFileSync(join(root, 'integration', name), body, 'utf8');
      }
      rc = join(root, 'integration', BASH_RC_NAME);
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    /** Type `lines` into an interactive bash started the way terminal.ts starts one. */
    const bash = (lines: string[], env: Record<string, string> = {}) =>
      spawnSync('/bin/bash', ['--rcfile', rc, '-i'], {
        input: `${lines.join('\n')}\n`,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, PS1: '', ...env },
        encoding: 'utf8',
      });

    /** The marks in `out`, decoded: `<cmd:git status>`, `<done;3>`, `<ps>`. */
    const marks = (out: string): string[] =>
      // eslint-disable-next-line no-control-regex
      [...out.matchAll(/\x1b\]6791;([^\x07]*)\x07/g)].map(([, body]) => {
        const [kind, value] = body.split(';');
        return kind === 'cmd' || kind === 'cwd'
          ? `${kind}:${Buffer.from(value, 'base64').toString('utf8')}`
          : body;
      });

    // Debian's /etc/profile resets PATH for a login bash; ours runs after it.
    it("puts the agent CLIs' install folders on PATH after a login file that resets it", () => {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      writeFileSync(join(home, '.bash_profile'), 'PATH=/usr/bin:/bin\n');
      const r = bash(['echo "|$PATH|"'], { DOUBLE0_BASH_LOGIN: '1' });
      expect(r.stdout).toContain(`|/usr/bin:/bin:${home}/.local/bin|`);
    });

    it('puts the agent shims back in front of PATH after a ~/.bashrc that prepends its own', () => {
      const shims = join(root, 'shims');
      mkdirSync(shims);
      writeFileSync(join(home, '.bashrc'), 'PATH=$HOME/bin:$PATH\n');
      const r = bash(['echo "|$PATH|"'], {
        PATH: `${shims}:/usr/bin:/bin`,
        DOUBLE0_SHIM_DIR: shims,
      });
      expect(r.stdout).toContain(`|${shims}:${home}/bin:${shims}:/usr/bin:/bin|`);
    });

    it("runs the user's ~/.bashrc and keeps their prompt command, with ours around it", () => {
      writeFileSync(join(home, '.bashrc'), 'RC_RAN=1\nPROMPT_COMMAND=user_pc\nuser_pc() { :; }\n');
      const r = bash(['echo "|$RC_RAN|$PROMPT_COMMAND|$(trap -p DEBUG)"']);
      expect(r.stdout).toContain(
        "|1|__double0_precmd\nuser_pc\n__double0_arm|trap -- '__double0_preexec' DEBUG",
      );
    });

    it('keeps a prompt command that ends in `; `, a newline or a comment working', () => {
      // `PROMPT_COMMAND="history -a; $PROMPT_COMMAND"` ends in `; `: joined
      // with `;` it was `; ;`, a syntax error at every prompt - the user's own
      // command never ran and no mark came (review, 2026-10-29).
      for (const rcLine of [
        'PROMPT_COMMAND="SAW=1; $PROMPT_COMMAND"',
        "PROMPT_COMMAND=$'SAW=1\\n'",
        "PROMPT_COMMAND='SAW=1 # count prompts'",
      ]) {
        writeFileSync(join(home, '.bashrc'), `${rcLine}\n`);
        const r = bash(['true', 'echo "|saw=$SAW"']);
        expect(r.stderr, rcLine).not.toMatch(/syntax error/);
        expect(r.stdout, rcLine).toContain('|saw=1');
        // Armed after it: the commands are still reported.
        expect(marks(r.stdout), rcLine).toContain('cmd:true');
      }
    });

    it('reports the typed line, not our own functions, under extdebug', () => {
      // extdebug hands the trap down into function bodies: every prompt
      // reported `return $ec` from inside our arm, and the user's line never.
      writeFileSync(join(home, '.bashrc'), 'shopt -s extdebug\n');
      const r = bash(['false', 'true']);
      expect(marks(r.stdout).filter((m) => m.startsWith('cmd:'))).toEqual([
        'cmd:false',
        'cmd:true',
      ]);
    });

    it('marks the whole line, its exit status, the folder and the next prompt', () => {
      const r = bash([`cd ${root}`, 'true | cat; (exit 3)', '']);
      expect(marks(r.stdout)).toEqual([
        // The first prompt says where the shell starts.
        `cwd:${process.cwd()}`,
        'ps',
        `cmd:cd ${root}`,
        `cwd:${root}`,
        'done;0',
        'ps',
        // The whole line from history - not just its first simple command.
        'cmd:true | cat; (exit 3)',
        'done;3',
        'ps',
        // An empty line runs nothing: no cmd, no status.
        'ps',
      ]);
    });

    it("hands the command's exit status on to the user's own prompt command", () => {
      // Ours runs first and returns the status it read; a prompt that shows
      // the last exit code must still see the command's.
      writeFileSync(join(home, '.bashrc'), "PROMPT_COMMAND='SAW=$?'\n");
      const r = bash(['(exit 7)', 'echo "|saw=$SAW"']);
      expect(r.stdout).toContain('|saw=7');
    });

    it('extends an array prompt command as an array', () => {
      writeFileSync(
        join(home, '.bashrc'),
        'PROMPT_COMMAND=(one two)\none() { :; }\ntwo() { :; }\n',
      );
      const r = bash(['echo "|${PROMPT_COMMAND[*]}"']);
      if (r.stdout.includes('|__double0_precmd one two __double0_arm')) return;
      // bash < 5.1 has no array prompt command: the string form then.
      expect(r.stdout).toContain('|__double0_precmd\none\n__double0_arm');
    });

    it('leaves a DEBUG trap the user already has alone', () => {
      writeFileSync(join(home, '.bashrc'), "trap 'MINE=1' DEBUG\n");
      const r = bash(['echo "|$(trap -p DEBUG)"', 'true']);
      expect(r.stdout).toContain("|trap -- 'MINE=1' DEBUG");
      // No cmd marks without our trap; the prompts still come.
      expect(marks(r.stdout).filter((m) => m.startsWith('cmd:'))).toEqual([]);
      expect(marks(r.stdout)).toContain('ps');
    });

    it("runs a tab's launch script from the first prompt, never reported as a command", () => {
      writeFileSync(
        join(home, '.bashrc'),
        "alias agent-personal='echo ran:$PIN'\nshopt -s expand_aliases\n",
      );
      const script = join(root, 'tab.sh');
      writeFileSync(script, launchScript('export PIN=1; agent-personal\nunset PIN'), 'utf8');
      const r = bash(['echo "|left=${' + LAUNCH_ENV + '-unset}|${PIN-unset}"'], {
        [LAUNCH_ENV]: script,
      });
      expect(r.stdout).toContain('ran:1');
      expect(r.stdout).toContain('|left=unset|unset');
      expect(marks(r.stdout).slice(0, 3)).toEqual([`cwd:${process.cwd()}`, 'launch', 'ps']);
      expect(existsSync(script)).toBe(false);
    });

    it('never reports the typed line that sources a launch script', () => {
      // The line is ours (startup-typer.ts): the Inputs list shows what the
      // user ran.
      const r = bash([LAUNCH_LINE, 'true']);
      expect(marks(r.stdout).filter((m) => m.startsWith('cmd:'))).toEqual(['cmd:true']);
    });
  },
);
