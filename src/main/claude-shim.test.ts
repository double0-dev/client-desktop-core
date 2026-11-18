import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAUNCH_ENV, LAUNCH_LINE, LAUNCH_TYPED_SUFFIX, launchScript } from './startup-typer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_SUBCOMMANDS,
  CLAUDE_SHIM_HOOKS_ENV,
  CLAUDE_SHIM_SCRIPT,
  CLAUDE_SHIM_SESSION_ENV,
  CODEX_SHIM_SCRIPT,
  OPENCODE_SHIM_SCRIPT,
  OPENCODE_SHIM_SESSION_ENV,
  POWERSHELL_CLAUDE_FUNCTION,
  SHELL_SETUP_ENV,
  WINDOWS_CLAUDE_HELPER,
  launchesPosixShell,
  windowsShellSetup,
  wrapperLaunchCommand,
} from './claude-shim';
import { AGENT_NAME_ENV, STATUS_OWNER_ENV, USAGE_FILE_ENV } from './claude-status-hooks';
import { CODEX_SHIM_HOOKS_ENV } from './codex-status-hooks';
import { OPENCODE_CONFIG_ENV } from './opencode-status-plugin';
import { OPENCODE_SESSION_RECORD_ENV } from './agent-resume';

const ID = '08d219a2-2b4f-46e3-a0d7-b9b5d2e857ad';

describe('wrapperLaunchCommand', () => {
  const launch = {
    shimDir: '/tmp/double0-claude-shim',
    settingsPath: '/tmp/double0-claude-status-hooks.json',
    plan: { sessionId: ID, recordPath: '/Users/emma/Library/Application Support/x/records/tab' },
  };

  it('exports the shim onto PATH, the pty device and the session env ahead of the command', () => {
    // The user's alias: the adapter sees only the word, the shim sees `claude`.
    expect(wrapperLaunchCommand('claude-personal', launch)).toBe(
      `export DOUBLE0_TTY="$(tty)" PATH='/tmp/double0-claude-shim':"$PATH" ` +
        `${CLAUDE_SHIM_HOOKS_ENV}='/tmp/double0-claude-status-hooks.json' ` +
        `${CLAUDE_SHIM_SESSION_ENV}='${ID}' ` +
        `DOUBLE0_SESSION_FILE='/Users/emma/Library/Application Support/x/records/tab'; claude-personal\n` +
        `unset ${CLAUDE_SHIM_SESSION_ENV} DOUBLE0_SESSION_FILE`,
    );
  });

  it('keeps the unset off a trailing comment in the command', () => {
    expect(wrapperLaunchCommand('claude # mine', launch)).toMatch(/# mine\nunset /);
  });

  it.skipIf(process.platform === 'win32')(
    'drops the pin once the command returns, keeping the hooks for the shell left behind',
    () => {
      // The tab's shell sourced the line and stays the user's shell after the
      // command, with every export. A pin left there made a `claude` typed later in
      // the tab resume the tab's conversation (or open a new one under its
      // uuid in another config dir) instead of starting fresh.
      const line = wrapperLaunchCommand('true', launch);
      const r = spawnSync(
        'sh',
        [
          '-c',
          `${line}; printf '%s|%s|%s' "\${${CLAUDE_SHIM_SESSION_ENV}-unset}" "\${DOUBLE0_SESSION_FILE-unset}" "\${${CLAUDE_SHIM_HOOKS_ENV}-unset}"`,
        ],
        { encoding: 'utf8' },
      );
      expect(r.stdout).toBe('unset|unset|/tmp/double0-claude-status-hooks.json');
    },
  );

  it('leaves an unpinnable pty unpinned but still hooked', () => {
    const line = wrapperLaunchCommand('cd app && claude-personal', { ...launch, plan: null });
    expect(line).toContain(`${CLAUDE_SHIM_HOOKS_ENV}=`);
    expect(line).not.toContain(CLAUDE_SHIM_SESSION_ENV);
    expect(line).not.toContain('DOUBLE0_SESSION_FILE');
    expect(line.endsWith('; cd app && claude-personal')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'exports the status line capture file and keeps it after the command, unlike the pin',
    () => {
      // A `claude` or `codex` typed in the tab later must still report which
      // account it runs under.
      const usageFile = '/Users/emmaw/Library/Application Support/x/captures/tab.usage';
      const line = wrapperLaunchCommand('true', { ...launch, usageFile });
      expect(line).toContain(`${USAGE_FILE_ENV}='${usageFile}'`);
      const r = spawnSync('sh', ['-c', `${line}; printf '%s' "\${${USAGE_FILE_ENV}-unset}"`], {
        encoding: 'utf8',
      });
      expect(r.stdout).toBe(usageFile);
      expect(wrapperLaunchCommand('true', launch)).not.toContain(USAGE_FILE_ENV);
    },
  );

  it('single-quotes paths, a quote inside included', () => {
    const line = wrapperLaunchCommand('x', { ...launch, shimDir: "/tmp/it's here" });
    expect(line).toContain(`PATH='/tmp/it'\\''s here':"$PATH"`);
  });

  it("exports the Codex hook list for the codex shim, kept after the command like Claude's", () => {
    const line = wrapperLaunchCommand('codex', {
      ...launch,
      codexHooksPath: '/tmp/double0-codex-hooks.conf',
    });
    expect(line).toContain(`${CODEX_SHIM_HOOKS_ENV}='/tmp/double0-codex-hooks.conf'`);
    expect(line).not.toMatch(/unset [^;]*DOUBLE0_CODEX_HOOKS/);
    expect(wrapperLaunchCommand('codex', launch)).not.toContain(CODEX_SHIM_HOOKS_ENV);
  });

  it("names the tab's Codex record for the hooks and drops it after the command", () => {
    const line = wrapperLaunchCommand('codex', {
      ...launch,
      plan: null,
      codexRecordPath: '/r/codex-tab',
    });
    expect(line).toContain(`DOUBLE0_CODEX_SESSION_FILE='/r/codex-tab'`);
    // A `codex` typed in the tab's shell later starts no record (as for Claude).
    expect(line.endsWith('; codex\nunset DOUBLE0_CODEX_SESSION_FILE')).toBe(true);
    expect(wrapperLaunchCommand('codex', launch)).not.toContain('DOUBLE0_CODEX_SESSION_FILE');
  });

  it('loads the OpenCode plugin through the inline config, unless the user has their own', () => {
    const line = wrapperLaunchCommand('opencode', {
      ...launch,
      opencodePluginPath: '/tmp/double0-opencode/double0-status.js',
    });
    // Its own statement, after the exports and before the command: a
    // prefix assignment could not express "only if unset".
    expect(line).toContain(
      `; [ -n "\${${OPENCODE_CONFIG_ENV}:-}" ] || export ${OPENCODE_CONFIG_ENV}='{"plugin":["file:///tmp/double0-opencode/double0-status.js"]}'; opencode\n`,
    );
    expect(wrapperLaunchCommand('opencode', launch)).not.toContain(OPENCODE_CONFIG_ENV);
  });

  it("pins the tab's OpenCode session for the opencode shim and drops it after the command", () => {
    const line = wrapperLaunchCommand('opencode', {
      ...launch,
      opencodePlan: { sessionId: 'ses_efd99bf2cffe5s5wMVZhGkYukW', recordPath: '/r/tab' },
    });
    expect(line).toContain(`${OPENCODE_SHIM_SESSION_ENV}='ses_efd99bf2cffe5s5wMVZhGkYukW'`);
    expect(line).toContain(`${OPENCODE_SESSION_RECORD_ENV}='/r/tab'`);
    expect(
      line.endsWith(
        `; opencode\nunset ${CLAUDE_SHIM_SESSION_ENV} DOUBLE0_SESSION_FILE ${OPENCODE_SHIM_SESSION_ENV} ${OPENCODE_SESSION_RECORD_ENV}`,
      ),
    ).toBe(true);
    // Nothing recorded yet: only the record file, so the plugin can start one.
    const fresh = wrapperLaunchCommand('opencode', {
      ...launch,
      plan: null,
      opencodePlan: { sessionId: null, recordPath: '/r/tab' },
    });
    expect(fresh).not.toContain(`${OPENCODE_SHIM_SESSION_ENV}=`);
    expect(fresh.endsWith(`; opencode\nunset ${OPENCODE_SESSION_RECORD_ENV}`)).toBe(true);
  });
});

describe('launchesPosixShell', () => {
  it('takes the sh family, by path or login name', () => {
    for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh', '/usr/bin/dash', '-zsh', 'ksh']) {
      expect(launchesPosixShell(shell), shell).toBe(true);
    }
  });

  it('refuses shells whose -c line cannot parse `export …; unset …`', () => {
    // Under these the wrapped line would fail to parse, and a setup command
    // that used to run verbatim would not run at all.
    for (const shell of [
      '/opt/homebrew/bin/fish',
      '/bin/tcsh',
      '/bin/csh',
      '/usr/local/bin/nu',
      'xonsh',
      'pwsh',
      'C:\\Windows\\System32\\cmd.exe',
      '',
    ]) {
      expect(launchesPosixShell(shell), shell).toBe(false);
    }
  });
});

describe.skipIf(process.platform === 'win32')('CLAUDE_SHIM_SCRIPT under a real sh', () => {
  let root: string;
  let shimDir: string;
  let binDir: string;
  let hooks: string;
  let argvFile: string;
  let envFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'double0-shim-'));
    shimDir = join(root, 'shim');
    binDir = join(root, 'bin');
    mkdirSync(shimDir);
    mkdirSync(binDir);
    writeFileSync(join(shimDir, 'claude'), CLAUDE_SHIM_SCRIPT, { mode: 0o755 });
    // The real binary, further down PATH: records its argv and the env it saw.
    argvFile = join(root, 'argv');
    envFile = join(root, 'env');
    writeFileSync(
      join(binDir, 'claude'),
      `#!/bin/sh\n: > '${argvFile}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvFile}'; done\n` +
        `printf 'CFG=%s\\nTTY=%s\\n' "\${CLAUDE_CONFIG_DIR:-}" "\${DOUBLE0_TTY:-}" > '${envFile}'\n`,
      { mode: 0o755 },
    );
    hooks = join(root, 'hooks.json');
    writeFileSync(hooks, '{}');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const path = (): string => `${shimDir}:${binDir}:/usr/bin:/bin`;
  /** Run `command` the way the tab's shell would: `claude` resolved via PATH. */
  const run = (command: string, env: Record<string, string> = {}) =>
    spawnSync('sh', ['-c', command], {
      env: {
        PATH: path(),
        HOME: root,
        [CLAUDE_SHIM_HOOKS_ENV]: hooks,
        [CLAUDE_SHIM_SESSION_ENV]: ID,
        ...env,
      },
      encoding: 'utf8',
    });
  const argv = (): string[] => readFileSync(argvFile, 'utf8').split('\n').slice(0, -1);
  const seen = (): string => readFileSync(envFile, 'utf8');

  it('launches an interactive claude with the hooks and a new conversation', () => {
    const r = run('claude --model opus');
    expect(r.status).toBe(0);
    expect(argv()).toEqual(['--settings', hooks, '--session-id', ID, '--model', 'opus']);
  });

  it('resumes the conversation when its transcript exists in the config dir the wrapper chose', () => {
    // The transcript lives under CLAUDE_CONFIG_DIR - the alias's own, not the
    // default one main would look in - and under whatever project folder.
    const cfg = join(root, '.claude-personal');
    mkdirSync(join(cfg, 'projects', '-Applications-acme-production-pipeline'), { recursive: true });
    writeFileSync(
      join(cfg, 'projects', '-Applications-acme-production-pipeline', `${ID}.jsonl`),
      '',
    );
    run('claude', { CLAUDE_CONFIG_DIR: cfg });
    expect(argv()).toEqual(['--settings', hooks, '--resume', ID]);
    // Same id, default config dir: nothing there, so a new conversation.
    run('claude');
    expect(argv()).toEqual(['--settings', hooks, '--session-id', ID]);
  });

  it('never overrides a conversation the user pinned themselves', () => {
    run('claude --resume mine');
    expect(argv()).toEqual(['--settings', hooks, '--resume', 'mine']);
    run('claude --session-id=other');
    expect(argv()).toEqual(['--settings', hooks, '--session-id=other']);
    run('claude -c');
    expect(argv()).toEqual(['--settings', hooks, '-c']);
  });

  it('passes print mode, version, help and subcommands through untouched', () => {
    // A script's `claude -p` inside the tab must not flip the tab's status or
    // move its session record; `claude mcp list` takes no --settings.
    run("claude -p 'summarise this'");
    expect(argv()).toEqual(['-p', 'summarise this']);
    run('claude --print x');
    expect(argv()).toEqual(['--print', 'x']);
    run('claude --version');
    expect(argv()).toEqual(['--version']);
    run('claude mcp list');
    expect(argv()).toEqual(['mcp', 'list']);
  });

  it("passes every one of the CLI's subcommands through (2.1.278's `claude --help`)", () => {
    // A pin or --settings injected ahead of a subcommand turns `claude logs x`
    // into an interactive launch with a stray prompt.
    for (const sub of [
      'agents',
      'attach',
      'auth',
      'auto-mode',
      'doctor',
      'gateway',
      'import',
      'install',
      'kill',
      'logs',
      'mcp',
      'plugin',
      'plugins',
      'project',
      'respawn',
      'rm',
      'setup-token',
      'stop',
      'ultrareview',
      'update',
      'upgrade',
    ]) {
      run(`claude ${sub} x`);
      expect(argv(), sub).toEqual([sub, 'x']);
    }
    // A prompt that merely starts with such a word is still a prompt.
    run("claude 'logs are empty'");
    expect(argv()).toEqual(['--settings', hooks, '--session-id', ID, 'logs are empty']);
  });

  it('passes through when no hook file is named or it is gone', () => {
    run('claude', { [CLAUDE_SHIM_HOOKS_ENV]: '' });
    expect(argv()).toEqual([]);
    run('claude', { [CLAUDE_SHIM_HOOKS_ENV]: join(root, 'missing.json') });
    expect(argv()).toEqual([]);
  });

  it('keeps every argument intact, spaces and empties included', () => {
    run(`claude 'fix the flaky test' '' --model opus`);
    expect(argv()).toEqual([
      '--settings',
      hooks,
      '--session-id',
      ID,
      'fix the flaky test',
      '',
      '--model',
      'opus',
    ]);
  });

  describe('only the top-level agent of a tab reports', () => {
    it("runs plain - no hooks, no pin - when the tab's reporting agent ran it from a tool", () => {
      // The variable the shim that armed the top-level agent exported, and
      // its tool shell inherited. An interactive launch, so that without the
      // gate it WOULD get the hooks and the tab's conversation.
      run("claude 'from the tool'", { [STATUS_OWNER_ENV]: 'opencode' });
      expect(argv()).toEqual(['from the tool']);
    });

    it('marks the claude it hooks as the owner, so a claude THAT one runs by name stays plain', () => {
      // The "real" claude plays the agent: it logs what it got and the owner it
      // sees, then runs `claude` by name once, as its Bash tool would - which
      // resolves to the shim again, further up this same PATH.
      const log = join(root, 'launches');
      writeFileSync(
        join(binDir, 'claude'),
        `#!/bin/sh\n` +
          `{ printf 'owner=%s argv=' "\${${STATUS_OWNER_ENV}:-}"; for a in "$@"; do printf '[%s]' "$a"; done; printf '\\n'; } >> '${log}'\n` +
          `[ -n "\${INNER:-}" ] || INNER=1 claude 'from the tool'\n`,
        { mode: 0o755 },
      );
      run('claude --model opus');
      expect(readFileSync(log, 'utf8')).toBe(
        `owner=claude argv=[--settings][${hooks}][--session-id][${ID}][--model][opus]\n` +
          `owner=claude argv=[from the tool]\n`,
      );
    });

    it('never marks a launch it passes through - it reports nothing', () => {
      writeFileSync(
        join(binDir, 'claude'),
        `#!/bin/sh\nprintf '%s' "\${${STATUS_OWNER_ENV}:-unset}" > '${envFile}'\n`,
        { mode: 0o755 },
      );
      run('claude -p x');
      expect(seen()).toBe('unset');
      run('claude mcp list');
      expect(seen()).toBe('unset');
    });

    // Every shell has the shims first on PATH now, so a plain `claude` start
    // command's own line - already hooked and pinned - reaches the shim too.
    // A second --settings and pin would garble it; no owner would let an
    // agent its tools run report into this tab.
    it('runs a launch that already names the hooks untouched, as the reporting agent', () => {
      writeFileSync(
        join(binDir, 'claude'),
        `#!/bin/sh\n{ printf 'owner=%s argv=' "\${${STATUS_OWNER_ENV}:-}"; for a in "$@"; do printf '[%s]' "$a"; done; } > '${envFile}'\n`,
        { mode: 0o755 },
      );
      run(`claude --settings '${hooks}' --resume ${ID}`);
      expect(seen()).toBe(`owner=claude argv=[--settings][${hooks}][--resume][${ID}]`);
    });
  });

  it('keeps the pty device a launch line exported, and finds none without a terminal', () => {
    run('claude', { DOUBLE0_TTY: '/dev/ttys042' });
    expect(seen()).toContain('TTY=/dev/ttys042\n');
    // spawnSync's stdin is a pipe: `tty` fails, nothing is made up.
    run('claude');
    expect(seen()).toContain('TTY=\n');
  });

  it('fails like a missing command when no real claude is on PATH', () => {
    const r = spawnSync('sh', ['-c', 'claude'], {
      env: { PATH: `${shimDir}:/usr/bin:/bin`, HOME: root, [CLAUDE_SHIM_HOOKS_ENV]: hooks },
      encoding: 'utf8',
    });
    expect(r.status).toBe(127);
    expect(r.stderr).toContain('claude: command not found');
  });

  const hasBash = spawnSync('bash', ['-c', ':']).status === 0;
  it.skipIf(!hasBash)(
    "reaches a claude launched through the user's alias, with the alias's own environment",
    () => {
      // The shape that started this: `alias claude-personal='CLAUDE_CONFIG_DIR=… claude'`,
      // defined in the rc file the launch shell sources before it parses the
      // command. The shim must see the alias's config dir (the transcript check
      // depends on it) and the exported pty device.
      const rc = join(root, 'rc');
      writeFileSync(
        rc,
        `alias claude-personal='CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude'\nexport PATH="${binDir}:$PATH"\n`,
      );
      const line = wrapperLaunchCommand('claude-personal --model opus', {
        shimDir,
        settingsPath: hooks,
        plan: { sessionId: ID, recordPath: join(root, 'record') },
      });
      const r = spawnSync('bash', ['--noprofile', '--rcfile', rc, '-i', '-c', line], {
        env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: root },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(argv()).toEqual(['--settings', hooks, '--session-id', ID, '--model', 'opus']);
      expect(seen()).toBe(`CFG=${join(root, '.claude-personal')}\nTTY=not a tty\n`);
    },
  );

  const hasZsh = spawnSync('zsh', ['-c', ':']).status === 0;
  it.skipIf(!hasZsh)('reaches a claude behind a zsh alias - the default launch shell', () => {
    // The tab's interactive zsh sources the line from its launch script
    // (startup-typer.ts): .zshrc has defined the alias by then, and zsh's alias
    // expansion must still land on the shim that the line's own
    // `export PATH=…` put first. `-d` skips the machine's global rc files so
    // only this fixture's .zshrc runs.
    writeFileSync(
      join(root, '.zshrc'),
      `alias claude-personal='CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude'\nexport PATH="${binDir}:$PATH"\n`,
    );
    const line = wrapperLaunchCommand('claude-personal --model opus', {
      shimDir,
      settingsPath: hooks,
      plan: { sessionId: ID, recordPath: join(root, 'record') },
    });
    const script = join(root, 'launch.sh');
    writeFileSync(script + LAUNCH_TYPED_SUFFIX, launchScript(line));
    const r = spawnSync('zsh', ['-d', '-i', '-c', LAUNCH_LINE], {
      env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: root, ZDOTDIR: root, [LAUNCH_ENV]: script },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(argv()).toEqual(['--settings', hooks, '--session-id', ID, '--model', 'opus']);
    expect(seen()).toBe(`CFG=${join(root, '.claude-personal')}\nTTY=not a tty\n`);
  });
});

describe.skipIf(process.platform === 'win32')('CODEX_SHIM_SCRIPT under a real sh', () => {
  let root: string;
  let shimDir: string;
  let binDir: string;
  let argvFile: string;
  let usageFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'double0-codex-shim-'));
    shimDir = join(root, 'shim');
    binDir = join(root, 'bin');
    mkdirSync(shimDir);
    mkdirSync(binDir);
    writeFileSync(join(shimDir, 'codex'), CODEX_SHIM_SCRIPT, { mode: 0o755 });
    argvFile = join(root, 'argv');
    usageFile = join(root, 'tab.usage');
    writeFileSync(
      join(binDir, 'codex'),
      `#!/bin/sh\n: > '${argvFile}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvFile}'; done\nexit 7\n`,
      { mode: 0o755 },
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /**
   * The capture as the shim writes it - a header, the provider, CODEX_HOME
   * (empty = unset), the folder and the pid, one per line. Whatever reads
   * the captures (an extension's status line) parses this format.
   */
  const capture = (): { provider: string; dirEnv: string; pid: number } => {
    const [header, provider, dirEnv, , pid] = readFileSync(usageFile, 'utf8').split('\n');
    expect(header).toBe('double0-usage 1');
    return { provider, dirEnv, pid: Number(pid) };
  };

  const run = (
    command: string,
    env: Record<string, string> = {},
    path = `${shimDir}:${binDir}:/usr/bin:/bin`,
  ) =>
    spawnSync('sh', ['-c', command], {
      cwd: root,
      env: { PATH: path, HOME: root, [USAGE_FILE_ENV]: usageFile, ...env },
      encoding: 'utf8',
    });

  it("records the tab's Codex home, then runs the real CLI with the argv untouched", () => {
    const r = run("codex --model gpt-5 'two words' ''", { CODEX_HOME: '/Users/emmaw/.codex-work' });
    // The real binary's exit status is the shim's (exec).
    expect(r.status).toBe(7);
    expect(readFileSync(argvFile, 'utf8').split('\n').slice(0, -1)).toEqual([
      '--model',
      'gpt-5',
      'two words',
      '',
    ]);
    expect(capture()).toMatchObject({ provider: 'codex', dirEnv: '/Users/emmaw/.codex-work' });
  });

  it('records the pid the CLI runs as, so main can tell when it has exited', () => {
    // The shim execs the real binary: its own pid becomes the CLI's.
    writeFileSync(
      join(binDir, 'codex'),
      `#!/bin/sh\nprintf '%s' "$$" > '${join(root, 'codex-pid')}'\n`,
      { mode: 0o755 },
    );
    run('codex');
    const pid = Number(readFileSync(join(root, 'codex-pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(capture().pid).toBe(pid);
  });

  it('records an unset CODEX_HOME as empty (the default ~/.codex)', () => {
    run('codex');
    expect(capture().dirEnv).toBe('');
  });

  it('still runs codex when there is no capture file to write, and says nothing', () => {
    const r = run('codex exec hi', { [USAGE_FILE_ENV]: join(root, 'missing', 'x.usage') });
    expect(r).toMatchObject({ status: 7, stderr: '' });
    expect(readFileSync(argvFile, 'utf8')).toBe('exec\nhi\n');
  });

  it('fails like a missing command when no real codex is on PATH', () => {
    const r = run('codex', {}, `${shimDir}:/usr/bin:/bin`);
    expect(r.status).toBe(127);
    expect(r.stderr).toContain('codex: command not found');
  });

  describe('status hook injection', () => {
    const LINES = [
      'hooks.SessionStart=[{matcher="startup",hooks=[{type="command",command="\'/tmp/h.sh\' ready"}]}]',
      'hooks.Stop=[{hooks=[{type="command",command="\'/tmp/h.sh\' finished"}]}]',
    ];
    let hooks: string;
    let seenFile: string;

    beforeEach(() => {
      hooks = join(root, 'codex-hooks.conf');
      writeFileSync(hooks, `${LINES.join('\n')}\n`, 'utf8');
      // The real binary also reports the agent name the hook script will see
      // and the status owner its tool shells will inherit: `<agent>/<owner>`.
      seenFile = join(root, 'seen');
      writeFileSync(
        join(binDir, 'codex'),
        `#!/bin/sh\n: > '${argvFile}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvFile}'; done\n` +
          `printf '%s/%s' "\${${AGENT_NAME_ENV}:-unset}" "\${${STATUS_OWNER_ENV}:-unset}" > '${seenFile}'\n`,
        { mode: 0o755 },
      );
    });
    const argv = (): string[] => readFileSync(argvFile, 'utf8').split('\n').slice(0, -1);
    const withHooks = (command: string, env: Record<string, string> = {}) =>
      run(command, { [CODEX_SHIM_HOOKS_ENV]: hooks, ...env });

    it('puts one -c override per line ahead of an interactive launch, naming the agent', () => {
      withHooks("codex --model gpt-5 'fix the flaky test'");
      // Every line present, each as its own -c; the order is the shim's
      // (reversed by the prepend loop) and does not matter - distinct keys.
      const args = argv();
      expect(args.slice(-3)).toEqual(['--model', 'gpt-5', 'fix the flaky test']);
      const overrides = args.slice(0, -3);
      expect(overrides.filter((a) => a === '-c')).toHaveLength(2);
      expect(overrides.filter((a) => a !== '-c').sort()).toEqual([...LINES].sort());
      // Named for the hook script, and marked as the tab's reporting agent
      // for whatever its shell tool runs.
      expect(readFileSync(seenFile, 'utf8')).toBe('codex/codex');
      // The capture is still written first.
      expect(capture().provider).toBe('codex');
    });

    it("runs plain under the tab's reporting agent: no overrides, no capture, no marking", () => {
      // A `codex` an agent runs from its tool: not this tab's account, and
      // hooks that would write into the parent's pty are never injected.
      withHooks("codex 'from the tool'", { [STATUS_OWNER_ENV]: 'claude' });
      expect(argv()).toEqual(['from the tool']);
      expect(existsSync(usageFile)).toBe(false);
      expect(readFileSync(seenFile, 'utf8')).toBe('unset/claude');
    });

    it('takes resume and fork as interactive, flags ahead of the subcommand', () => {
      // Verified on 0.160.0: `codex -c … resume <id>` parses.
      withHooks('codex resume 01a1025e-c170-76c3-985d-d8ea99403fd5');
      expect(argv().slice(-2)).toEqual(['resume', '01a1025e-c170-76c3-985d-d8ea99403fd5']);
      expect(argv().filter((a) => a === '-c')).toHaveLength(2);
      withHooks('codex fork --last');
      expect(argv().slice(-2)).toEqual(['fork', '--last']);
      expect(argv()[0]).toBe('-c');
    });

    it("passes every other subcommand, --version and --help through (0.160.0's `codex --help`)", () => {
      for (const sub of [
        'agents',
        'exec',
        'e',
        'review',
        'login',
        'logout',
        'mcp',
        'plugin',
        'app-server',
        'remote-control',
        'app',
        'completion',
        'update',
        'doctor',
        'sandbox',
        'debug',
        'apply',
        'a',
        'queue',
        'archive',
        'delete',
        'migrate-rollouts',
        'unarchive',
        'cloud',
        'exec-server',
        'features',
        'help',
      ]) {
        withHooks(`codex ${sub} x`);
        expect(argv(), sub).toEqual([sub, 'x']);
        expect(readFileSync(seenFile, 'utf8'), sub).toBe('unset/unset');
      }
      withHooks('codex --version');
      expect(argv()).toEqual(['--version']);
      withHooks('codex -V');
      expect(argv()).toEqual(['-V']);
      withHooks('codex --help');
      expect(argv()).toEqual(['--help']);
      // A prompt that merely starts with such a word is still a prompt.
      withHooks("codex 'review my changes'");
      expect(argv().slice(-1)).toEqual(['review my changes']);
      expect(argv()[0]).toBe('-c');
      // ~30 real shells in a row: 1.4 s on an idle Mac, past the 5 s default
      // on the loaded release runner (v0.5.2's check).
    }, 30_000);

    it('injects nothing when no list is named or it is gone', () => {
      run('codex');
      expect(argv()).toEqual([]);
      withHooks('codex', { [CODEX_SHIM_HOOKS_ENV]: join(root, 'missing.conf') });
      expect(argv()).toEqual([]);
      expect(readFileSync(seenFile, 'utf8')).toBe('unset/unset');
    });

    it('reads a list whose last line has no newline', () => {
      writeFileSync(hooks, LINES.join('\n'), 'utf8');
      withHooks('codex');
      expect(argv().filter((a) => a === '-c')).toHaveLength(2);
    });
  });
});

describe.skipIf(process.platform === 'win32')('OPENCODE_SHIM_SCRIPT under a real sh', () => {
  const SESSION = 'ses_efd99bf2cffe5s5wMVZhGkYukW';
  const hasSqlite = spawnSync('sqlite3', ['-version']).status === 0;
  let root: string;
  let shimDir: string;
  let binDir: string;
  let argvFile: string;
  let db: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'double0-opencode-shim-'));
    shimDir = join(root, 'shim');
    binDir = join(root, 'bin');
    mkdirSync(shimDir);
    mkdirSync(binDir);
    writeFileSync(join(shimDir, 'opencode'), OPENCODE_SHIM_SCRIPT, { mode: 0o755 });
    argvFile = join(root, 'argv');
    writeFileSync(
      join(binDir, 'opencode'),
      `#!/bin/sh\n: > '${argvFile}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvFile}'; done\nexit 7\n`,
      { mode: 0o755 },
    );
    // OpenCode's database, with the one session the tab recorded.
    db = join(root, 'share', 'opencode', 'opencode.db');
    mkdirSync(join(root, 'share', 'opencode'), { recursive: true });
    if (hasSqlite) {
      spawnSync('sqlite3', [
        db,
        `create table session (id text primary key, title text); insert into session values ('${SESSION}', 'x');`,
      ]);
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (command: string, env: Record<string, string> = {}) =>
    spawnSync('sh', ['-c', command], {
      cwd: root,
      env: {
        PATH: `${shimDir}:${binDir}:/usr/bin:/bin`,
        HOME: root,
        XDG_DATA_HOME: join(root, 'share'),
        [OPENCODE_SHIM_SESSION_ENV]: SESSION,
        ...env,
      },
      encoding: 'utf8',
    });
  const argv = (): string[] => readFileSync(argvFile, 'utf8').split('\n').slice(0, -1);

  it.skipIf(!hasSqlite)("continues the tab's session when OpenCode still has it", () => {
    const r = run("opencode --model opencode/claude-haiku-4-5 'two words'");
    expect(r.status).toBe(7);
    expect(argv()).toEqual(['-s', SESSION, '--model', 'opencode/claude-haiku-4-5', 'two words']);
  });

  it.skipIf(!hasSqlite)(
    'starts fresh when the session is gone - a stale id would make OpenCode exit',
    () => {
      // "Session not found" ends the TUI (verified on 1.17.20).
      run('opencode', { [OPENCODE_SHIM_SESSION_ENV]: 'ses_gone00000000000000000000' });
      expect(argv()).toEqual([]);
    },
  );

  it.skipIf(!hasSqlite)('finds the database where OPENCODE_DB points', () => {
    const moved = join(root, 'elsewhere.db');
    renameSync(db, moved);
    run('opencode');
    expect(argv()).toEqual([]);
    run('opencode', { OPENCODE_DB: moved });
    expect(argv()).toEqual(['-s', SESSION]);
  });

  it.skipIf(!hasSqlite)(
    "never continues the tab's session for an opencode the reporting agent ran from a tool",
    () => {
      // Its plugin stays silent on its own (opencode-status-plugin.ts); the
      // shim must not hand it the parent tab's conversation either.
      run('opencode', { [STATUS_OWNER_ENV]: 'claude' });
      expect(argv()).toEqual([]);
    },
  );

  it('starts fresh without a database to check against', () => {
    rmSync(db, { force: true });
    run('opencode');
    expect(argv()).toEqual([]);
  });

  it('starts fresh when sqlite3 is not on PATH', () => {
    // A PATH with the shell tools the shim needs (`dirname`) but no sqlite3.
    const tools = join(root, 'tools');
    mkdirSync(tools);
    const dirname = spawnSync('sh', ['-c', 'command -v dirname'], {
      encoding: 'utf8',
    }).stdout.trim();
    symlinkSync(dirname, join(tools, 'dirname'));
    // Node looks the command up on the child's PATH - name the shell outright.
    const r = spawnSync('/bin/sh', ['-c', 'opencode'], {
      cwd: root,
      env: {
        PATH: `${shimDir}:${binDir}:${tools}`,
        HOME: root,
        XDG_DATA_HOME: join(root, 'share'),
        [OPENCODE_SHIM_SESSION_ENV]: SESSION,
      },
      encoding: 'utf8',
    });
    expect(r.status).toBe(7);
    expect(argv()).toEqual([]);
  });

  it('never pins a session the user pins themselves, nor a non-interactive command', () => {
    for (const command of [
      'opencode -c',
      'opencode --continue',
      `opencode -s ${SESSION}`,
      `opencode --session=${SESSION}`,
      'opencode --fork -c',
      'opencode run hi',
      'opencode serve',
      'opencode attach http://localhost:4096',
      'opencode session list',
      'opencode --version',
      'opencode -h',
    ]) {
      run(command);
      // Exactly the user's own argv - nothing added.
      expect(argv(), command).toEqual(command.split(' ').slice(1));
    }
  });

  it("refuses an id that is not one of OpenCode's - it goes into a query", () => {
    run('opencode', { [OPENCODE_SHIM_SESSION_ENV]: "ses_x' or 1=1 --" });
    expect(argv()).toEqual([]);
    run('opencode', { [OPENCODE_SHIM_SESSION_ENV]: '' });
    expect(argv()).toEqual([]);
  });

  it('fails like a missing command when no real opencode is on PATH', () => {
    const r = spawnSync('sh', ['-c', 'opencode'], {
      env: { PATH: `${shimDir}:/usr/bin:/bin`, HOME: root },
      encoding: 'utf8',
    });
    expect(r.status).toBe(127);
    expect(r.stderr).toContain('opencode: command not found');
  });
});

/**
 * An agent typed at a plain shell's prompt has no launch line to capture the
 * tab's pty device, and its hook processes have no controlling terminal: the
 * shim, running in the foreground on the pty, is the one place that can name
 * it. Without it every marker went to /dev/tty from a hook and was lost.
 */
const hasPython = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' }).status === 0;

/** Runs argv on a fresh pty, draining it until the child exits. */
const PTY_RUN = [
  'import os, pty, sys',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  '    os.execvp(sys.argv[1], sys.argv[1:])',
  'while True:',
  '    try:',
  '        if not os.read(fd, 1024): break',
  '    except OSError:',
  '        break',
  'os.waitpid(pid, 0)',
].join('\n');

describe.skipIf(process.platform === 'win32' || !hasPython)(
  'the shims name the pty device for the hooks of an agent typed at a prompt',
  () => {
    let root: string;
    let shimDir: string;
    let binDir: string;
    let seenFile: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'double0-shim-tty-'));
      shimDir = join(root, 'shim');
      binDir = join(root, 'bin');
      mkdirSync(shimDir);
      mkdirSync(binDir);
      seenFile = join(root, 'seen');
      for (const [name, body] of [
        ['claude', CLAUDE_SHIM_SCRIPT],
        ['codex', CODEX_SHIM_SCRIPT],
        ['opencode', OPENCODE_SHIM_SCRIPT],
      ] as const) {
        writeFileSync(join(shimDir, name), body, { mode: 0o755 });
        // The real CLI: notes the device it was handed and the one it runs on.
        writeFileSync(
          join(binDir, name),
          `#!/bin/sh\nprintf '%s|%s' "\${DOUBLE0_TTY:-unset}" "$(tty)" > '${seenFile}'\n`,
          { mode: 0o755 },
        );
      }
      writeFileSync(join(root, 'hooks.json'), '{}');
      writeFileSync(join(root, 'codex-hooks.conf'), '');
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    /** `command` in sh on a fresh pty - the shell of a tab, as the user types it. */
    const onPty = (command: string): string => {
      spawnSync('python3', ['-c', PTY_RUN, 'sh', '-c', command], {
        env: {
          PATH: `${shimDir}:${binDir}:/usr/bin:/bin`,
          HOME: root,
          [CLAUDE_SHIM_HOOKS_ENV]: join(root, 'hooks.json'),
          [CODEX_SHIM_HOOKS_ENV]: join(root, 'codex-hooks.conf'),
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      return readFileSync(seenFile, 'utf8');
    };

    for (const name of ['claude', 'codex', 'opencode']) {
      it(`${name}: the device the agent runs on`, () => {
        const [handed, actual] = onPty(name).split('|');
        expect(actual).toMatch(/^\/dev\//);
        expect(handed).toBe(actual);
      });
    }
  },
);

describe('windowsShellSetup', () => {
  const helper = 'C:\\Users\\Emma Wilson\\AppData\\Local\\Temp\\double0-claude.cmd';

  it('defines the claude macro from the command line of cmd.exe, however it is named', () => {
    for (const shell of ['C:\\Windows\\System32\\cmd.exe', 'cmd.exe', 'CMD.EXE', 'cmd']) {
      expect(windowsShellSetup(shell, helper), shell).toEqual({
        args: ['/K', `%${SHELL_SETUP_ENV}%`],
        env: { [SHELL_SETUP_ENV]: `doskey claude="${helper}" $*` },
      });
    }
  });

  it('defines the claude function from the command line of PowerShell', () => {
    for (const shell of ['powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh']) {
      expect(windowsShellSetup(shell, helper), shell).toEqual({
        args: ['-NoExit', '-Command', `Invoke-Expression $env:${SHELL_SETUP_ENV}`],
        env: { [SHELL_SETUP_ENV]: POWERSHELL_CLAUDE_FUNCTION },
      });
    }
  });

  it('leaves any other shell alone', () => {
    for (const shell of ['C:\\Program Files\\Git\\bin\\bash.exe', 'nu.exe', '']) {
      expect(windowsShellSetup(shell, helper), shell).toBeNull();
    }
  });

  it('passes through what the sh shim passes through, in CRLF for cmd.exe', () => {
    // cmd.exe misreads labels in a file with bare LF line ends.
    expect(WINDOWS_CLAUDE_HELPER.split('\r\n').every((row) => !row.includes('\n'))).toBe(true);
    expect(WINDOWS_CLAUDE_HELPER).toContain(`for %%S in (${CLAUDE_SUBCOMMANDS.join(' ')})`);
    for (const flag of ['-p', '--print', '-v', '--version', '-h', '--help', '--settings']) {
      expect(WINDOWS_CLAUDE_HELPER).toContain(`if /i "%%~A"=="${flag}" goto plain`);
      expect(POWERSHELL_CLAUDE_FUNCTION).toContain(`'${flag}'`);
    }
    for (const sub of CLAUDE_SUBCOMMANDS) {
      expect(CLAUDE_SHIM_SCRIPT).toContain(sub);
      expect(POWERSHELL_CLAUDE_FUNCTION).toContain(`'${sub}'`);
    }
  });
});

const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

/**
 * The PowerShell `claude` function under a real pwsh (GitHub's Linux runners
 * have one): a fake `claude` on PATH records the argv the function hands it.
 */
describe.skipIf(!hasPwsh)('POWERSHELL_CLAUDE_FUNCTION under a real pwsh', () => {
  let root: string;
  let argvFile: string;
  let hooks: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'double0-pwsh-'));
    argvFile = join(root, 'argv');
    hooks = join(root, 'hooks.json');
    writeFileSync(hooks, '{}');
    mkdirSync(join(root, 'bin'));
    writeFileSync(
      join(root, 'bin', 'claude'),
      `#!/bin/sh\n: > '${argvFile}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvFile}'; done\n`,
      { mode: 0o755 },
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (line: string, env: Record<string, string> = { [CLAUDE_SHIM_HOOKS_ENV]: hooks }) => {
    const r = spawnSync(
      'pwsh',
      ['-NoProfile', '-Command', `${POWERSHELL_CLAUDE_FUNCTION}\n${line}`],
      {
        env: { PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, HOME: root, ...env },
        encoding: 'utf8',
      },
    );
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(argvFile, 'utf8').split('\n').slice(0, -1);
  };

  it('hooks an interactive claude, the argv kept whole', () => {
    expect(run("claude --model opus 'fix the build'")).toEqual([
      '--settings',
      hooks,
      '--model',
      'opus',
      'fix the build',
    ]);
  });

  it('passes subcommands, print mode, version, help and own settings through', () => {
    for (const line of [
      'claude mcp list',
      'claude logs x',
      "claude -p 'hi'",
      'claude --print=text',
      'claude --version',
      'claude -h',
      'claude --settings mine.json',
    ]) {
      expect(run(line), line).toEqual(
        line
          .split(' ')
          .slice(1)
          .map((a) => a.replace(/'/g, '')),
      );
    }
  });

  it('runs plain without a hooks file to name', () => {
    expect(run('claude go', {})).toEqual(['go']);
    expect(run('claude go', { [CLAUDE_SHIM_HOOKS_ENV]: join(root, 'gone.json') })).toEqual(['go']);
  });
});
