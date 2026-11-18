import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_SHIM_DIR_NAME,
  CLAUDE_SHIM_SCRIPT,
  POWERSHELL_CLAUDE_FUNCTION,
  WINDOWS_CLAUDE_HELPER,
  WINDOWS_CLAUDE_HELPER_NAME,
} from './claude-shim';
import { STATUS_HOOK_SCRIPT } from './claude-status-hooks';
import {
  createLaunchMaterializer,
  defaultShell,
  loginShellArgs,
  resolveLaunchCwd,
  type MaterializeDeps,
} from './launch-materialize';
import { planLaunch, type LaunchRequest } from './launch-plan';
import {
  SHELL_INTEGRATION_DIR_NAME,
  ZSH_INTEGRATION_FOLDER,
  zshIntegrationFiles,
} from './shell-integration';
import { LAUNCH_DIR_NAME, LAUNCH_ENV, LAUNCH_LINE, launchScript } from './startup-typer';
import { PTY_TERM } from './terminal-env';

/**
 * The host's half of a spawn (launch-materialize.ts) on a real filesystem: a
 * scratch folder stands in for the agent folder, the records folder and a
 * fake home with its own Claude config. Every input the materialiser reads -
 * env, platform, home - is injected, so nothing here touches the user's
 * real temp folder or ~/.claude (the running app launches its agents
 * against those). The request the in-process backend got before the split
 * is pinned by terminal.test.ts, which runs unchanged over this code.
 */

const TAB = '5b0c3a1e-7f2d-4c8e-9a61-2d4f8e0b7c13';

let root: string;
let home: string;
let agent: string;
let records: string;
let project: string;
let captures: Array<[string, string]>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'd0-materialize-')));
  home = join(root, 'home', 'emmaw');
  agent = join(root, 'agent');
  records = join(root, 'userData');
  project = join(home, 'acme', 'production-pipeline');
  for (const dir of [agent, project, join(home, '.claude')]) mkdirSync(dir, { recursive: true });
  captures = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in extension status line: its script, an entry naming the config
 * dir it was handed, and a capture per tab under the records folder.
 */
const GADGET_LINE_SCRIPT = '#!/bin/sh\n# gadget status line\n';
const gadgetCapture = (ptyId: string): string =>
  join(records, 'gadget', `${encodeURIComponent(ptyId)}.capture`);
const gadgetLine = (): NonNullable<MaterializeDeps['statusLine']> => ({
  script: GADGET_LINE_SCRIPT,
  entry: (path, configDir) => ({ type: 'command', command: `'${path}'`, configDir }),
  capture: (ptyId, cwd) => {
    captures.push([ptyId, cwd]);
    return gadgetCapture(ptyId);
  },
});

/**
 * The one agent file `<stem>-<hash><ext>` in the agent folder (files whose
 * contents differ get names of their own - launch-materialize.ts ›
 * contentFileName), or a path that does not exist when there is none.
 */
function agentFile(stem: string, ext: string): string {
  const names = existsSync(agent)
    ? readdirSync(agent).filter((n) => n.startsWith(`${stem}-`) && n.endsWith(ext))
    : [];
  expect(names.length, `${stem}*${ext}: ${names.join(', ')}`).toBeLessThanOrEqual(1);
  return join(agent, names[0] ?? `${stem}${ext}`);
}
const hooksFile = (): string => agentFile('double0-claude-status-hooks', '.json');
const windowsSettingsFile = (): string => agentFile('double0-claude-windows-settings', '.json');
const statusLineFile = (): string => agentFile('double0-status-line', '.sh');

function materializer(over: Partial<MaterializeDeps> = {}) {
  return createLaunchMaterializer({
    recordsRoot: () => records,
    statusLine: gadgetLine(),
    env: { HOME: home, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', DOUBLE0_LAUNCH: '/old/tab' },
    platform: 'darwin',
    home: () => home,
    agentRoot: () => agent,
    ...over,
  });
}

const plan = (req: Omit<LaunchRequest, 'id'> & { id?: string }, agentTools = true) =>
  planLaunch({ id: TAB, ...req }, { platform: 'darwin', appVersion: '0.6.4', agentTools });

describe('defaultShell', () => {
  it('takes $SHELL, else the platform shell, and bash over sh on Linux when it exists', () => {
    expect(defaultShell({ SHELL: '/usr/bin/fish' }, 'linux')).toBe('/usr/bin/fish');
    expect(defaultShell({}, 'darwin')).toBe('/bin/zsh');
    expect(defaultShell({}, 'linux', (p) => p === '/bin/bash')).toBe('/bin/bash');
    // A minimal container has no bash.
    expect(defaultShell({}, 'linux', () => false)).toBe('/bin/sh');
    expect(defaultShell({ COMSPEC: 'C:\\Windows\\cmd.exe' }, 'win32')).toBe('C:\\Windows\\cmd.exe');
    expect(defaultShell({}, 'win32')).toBe('powershell.exe');
  });
});

describe('loginShellArgs', () => {
  // A Dock-launched app has launchd's bare PATH and Homebrew's lives in
  // ~/.zprofile, which only a login zsh reads: without -l a terminal's
  // `pnpm run dev` said "command not found: pnpm".
  it('starts a macOS shell as a login shell, as macOS terminals do', () => {
    expect(loginShellArgs('/bin/zsh', 'darwin')).toEqual(['-l']);
    expect(loginShellArgs('/opt/homebrew/bin/bash', 'darwin')).toEqual(['-l']);
    expect(loginShellArgs('/opt/homebrew/bin/fish', 'darwin')).toEqual(['-l']);
  });

  it('leaves Linux shells and shells it does not know plain', () => {
    // A Linux desktop login has read the profile already.
    expect(loginShellArgs('/bin/zsh', 'linux')).toEqual([]);
    expect(loginShellArgs('/bin/bash', 'linux')).toEqual([]);
    // tcsh takes -l only alone, nu reads its login file differently - not ours to guess.
    expect(loginShellArgs('/bin/tcsh', 'darwin')).toEqual([]);
    expect(loginShellArgs('/opt/homebrew/bin/nu', 'darwin')).toEqual([]);
  });
});

describe('resolveLaunchCwd', () => {
  it("expands ~ against the host's home and falls back to it for anything that is not a folder", async () => {
    expect(await resolveLaunchCwd(project, home)).toBe(project);
    expect(await resolveLaunchCwd('~', home)).toBe(home);
    expect(await resolveLaunchCwd('~/acme/production-pipeline', home)).toBe(project);
    expect(await resolveLaunchCwd(join(project, 'missing'), home)).toBe(home);
    const file = join(project, 'README.md');
    writeFileSync(file, '# acme');
    expect(await resolveLaunchCwd(file, home)).toBe(home);
    expect(await resolveLaunchCwd(null, home)).toBe(home);
    expect(await materializer().resolveCwd('~')).toBe(home);
  });
});

/** The agent shims' folder in the scratch agent folder. */
const shims = (): string => join(agent, CLAUDE_SHIM_DIR_NAME);

describe('materialize', () => {
  // The report (2026-11-02): `claude` typed in a plain Terminal session ran
  // with no hooks, so the renderer read its repaints as work ("Working…" on
  // an idle agent) and its idle bell as a wait, with alerts.
  it('gives every shell the agent shims and their hooks, never a pin or a record', () => {
    const req = materializer({
      env: {
        HOME: home,
        SHELL: '/bin/zsh',
        PATH: '/usr/bin:/bin',
        // An app started from inside a double0 agent's tool: none of this is
        // the new shell's - with the owner set, every shim would stay silent.
        DOUBLE0_STATUS_OWNER: 'claude',
        DOUBLE0_TTY: '/dev/ttys001',
      },
    }).materialize(plan({}), project);
    expect(req.env.PATH).toBe(`${shims()}:/usr/bin:/bin`);
    expect(req.env).toMatchObject({
      DOUBLE0_SHIM_DIR: shims(),
      DOUBLE0_CLAUDE_HOOKS: hooksFile(),
      DOUBLE0_USAGE_FILE: gadgetCapture(TAB),
      DOUBLE0_CODEX_HOOKS: join(agent, 'double0-codex-hooks.conf'),
    });
    expect(JSON.parse(req.env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      plugin: [`file://${join(agent, 'double0-opencode', 'double0-status.js')}`],
    });
    // Hooks only: a `claude` typed twice starts two conversations.
    for (const name of [
      'DOUBLE0_CLAUDE_SESSION',
      'DOUBLE0_SESSION_FILE',
      'DOUBLE0_CODEX_SESSION_FILE',
      'DOUBLE0_OPENCODE_SESSION',
      'DOUBLE0_OPENCODE_SESSION_FILE',
      'DOUBLE0_STATUS_OWNER',
      'DOUBLE0_TTY',
    ]) {
      expect(req.env, name).not.toHaveProperty(name);
    }
    expect(readFileSync(join(shims(), 'claude'), 'utf8')).toBe(CLAUDE_SHIM_SCRIPT);
    expect(statSync(join(shims(), 'claude')).mode & 0o111).not.toBe(0);
    expect(existsSync(hooksFile())).toBe(true);
    expect(captures).toEqual([[TAB, project]]);
    // Still a plain shell: nothing typed, and the stream decides marker mode.
    expect(req.typeWhenReady).toBeUndefined();
    expect(req.markerDriven).toBe(false);
  });

  it("leaves a user's own OpenCode config theirs", () => {
    const own = '{"model":"anthropic/claude-sonnet"}';
    const req = materializer({
      env: { HOME: home, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', OPENCODE_CONFIG_CONTENT: own },
    }).materialize(plan({}), project);
    expect(req.env.OPENCODE_CONFIG_CONTENT).toBe(own);
  });

  it('prepares one status line capture per spawn, the one a start command names', () => {
    materializer().materialize(plan({ initialCommand: 'claude' }), project);
    // A second preparation would empty the file the command was pointed at.
    expect(captures).toEqual([[TAB, project]]);
  });

  it('starts a bare shell as a login shell, with the app env, the zsh integration and no launch script', () => {
    const req = materializer().materialize(plan({ cols: 120, rows: 40 }), project);
    expect(req).toMatchObject({
      id: TAB,
      file: '/bin/zsh',
      args: ['-l'],
      name: PTY_TERM,
      cols: 120,
      rows: 40,
      cwd: project,
      markerDriven: false,
    });
    expect(req.typeWhenReady).toBeUndefined();
    expect(req.env).toMatchObject({
      HOME: home,
      TERM: PTY_TERM,
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'double0',
      TERM_PROGRAM_VERSION: '0.6.4',
      LANG: 'en_US.UTF-8',
    });
    // A launch variable inherited from a double0 tab never reaches a new shell.
    expect(req.env).not.toHaveProperty(LAUNCH_ENV);
    const integration = join(agent, SHELL_INTEGRATION_DIR_NAME, ZSH_INTEGRATION_FOLDER);
    expect(req.env.ZDOTDIR).toBe(integration);
    expect(readFileSync(join(integration, '.zshrc'), 'utf8')).toBe(zshIntegrationFiles()['.zshrc']);
    expect(existsSync(join(agent, LAUNCH_DIR_NAME))).toBe(false);
  });

  it("sources a plain claude from an owner-only launch script, hooked and pinned to the tab's conversation", () => {
    const req = materializer().materialize(plan({ initialCommand: 'claude' }), project);
    expect(req.markerDriven).toBe(true);
    expect(req.typeWhenReady).toEqual({ line: LAUNCH_LINE, promptMarks: true });
    const script = req.env[LAUNCH_ENV];
    expect(script).toBe(join(agent, LAUNCH_DIR_NAME, `${TAB}.sh`));
    expect(statSync(script).mode & 0o777).toBe(0o600);
    const settings = hooksFile();
    const record = join(records, 'claude-sessions', TAB);
    const usage = gadgetCapture(TAB);
    expect(readFileSync(script, 'utf8')).toBe(
      launchScript(
        `DOUBLE0_TTY="$(tty)" DOUBLE0_USAGE_FILE='${usage}' DOUBLE0_SESSION_FILE='${record}'` +
          ` claude --session-id ${TAB} --settings '${settings}'`,
      ),
    );
    // The records folder exists for the SessionStart hook's first write.
    expect(existsSync(dirname(record))).toBe(true);
    expect(captures).toEqual([[TAB, project]]);
    // The hook script and the extension's status line, both runnable.
    const hook = join(agent, 'double0-status-hook.sh');
    expect(readFileSync(hook, 'utf8')).toBe(STATUS_HOOK_SCRIPT);
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    const line = statusLineFile();
    expect(readFileSync(line, 'utf8')).toBe(GADGET_LINE_SCRIPT);
    expect(statSync(line).mode & 0o111).not.toBe(0);
  });

  it("resumes the conversation when the host's Claude config holds its transcript", () => {
    const slug = project.replace(/[/._]/g, '-');
    const transcripts = join(home, '.claude', 'projects', slug);
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, `${TAB}.jsonl`), '{}\n');
    const req = materializer().materialize(plan({ initialCommand: 'claude' }), project);
    expect(readFileSync(req.env[LAUNCH_ENV], 'utf8')).toContain(`claude --resume ${TAB} `);
  });

  it("builds the status line entry from the host's own Claude config dir", () => {
    // The entry copies layout fields from the HOST's ~/.claude/settings.json
    // (spec 8.2 › 4) - never the laptop's.
    materializer().materialize(plan({ initialCommand: 'claude' }), project);
    const settings = JSON.parse(readFileSync(hooksFile(), 'utf8')) as {
      statusLine: { configDir: string; command: string };
    };
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: `'${statusLineFile()}'`,
      configDir: join(home, '.claude'),
    });
  });

  it('keeps a build without the status line off the settings file of a build with it', () => {
    // Every build on the machine shares the agent folder, and each trusts the
    // file it wrote while it exists: under one name, a core build started
    // beside the official app took the status line out of the app's tabs.
    const pro = materializer().materialize(plan({}), project).env.DOUBLE0_CLAUDE_HOOKS;
    const core = materializer({ statusLine: undefined }).materialize(plan({}), project).env
      .DOUBLE0_CLAUDE_HOOKS;
    expect(core).not.toBe(pro);
    expect(JSON.parse(readFileSync(pro, 'utf8'))).toHaveProperty('statusLine');
    expect(JSON.parse(readFileSync(core, 'utf8'))).not.toHaveProperty('statusLine');
    // Builds that write the same settings share the file.
    expect(materializer().materialize(plan({}), project).env.DOUBLE0_CLAUDE_HOOKS).toBe(pro);
  });

  it("injects no status line without an extension's, leaving the user's own in place", () => {
    // The core build: Claude keeps the status line its user configured, and no
    // capture is named to any agent.
    const req = materializer({ statusLine: undefined }).materialize(
      plan({ initialCommand: 'claude' }),
      project,
    );
    const settings = JSON.parse(readFileSync(hooksFile(), 'utf8')) as Record<string, unknown>;
    expect(settings).not.toHaveProperty('statusLine');
    expect(settings).toHaveProperty('hooks');
    expect(existsSync(statusLineFile())).toBe(false);
    expect(readFileSync(req.env[LAUNCH_ENV], 'utf8')).not.toContain('DOUBLE0_USAGE_FILE');
    expect(req.env).not.toHaveProperty('DOUBLE0_USAGE_FILE');
    // Still hooked and marker-driven: agent status does not need the line.
    expect(req.markerDriven).toBe(true);
    expect(captures).toEqual([]);
  });

  it("appends the agent CLIs' install folders that exist, after the agent tools', never twice", () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const gadget = {
      instructionsPath: () => join(agent, 'gadget', 'gadget-instructions.md'),
      terminalEnv: () => ({ env: {}, binDir: join(agent, 'gadget') }),
      instructions: 'GADGET INSTRUCTIONS',
      allow: [],
    };
    const out = materializer({ agentTools: gadget }).materialize(plan({}), project);
    // .opencode/bin and .claude/local do not exist here: not added. The agent
    // shims lead every shell's PATH (see below).
    expect(out.env.PATH).toBe(
      `${shims()}:${join(agent, 'gadget')}:/usr/bin:/bin:${home}/.local/bin`,
    );
    const again = materializer({
      env: { HOME: home, SHELL: '/bin/zsh', PATH: `/usr/bin:${home}/.local/bin` },
    }).materialize(plan({}, false), project);
    expect(again.env.PATH).toBe(`${shims()}:/usr/bin:${home}/.local/bin`);
  });

  it("adds the agent tools' env and puts their launcher first on PATH only where they exist and the plan asks", () => {
    const gadget = {
      instructionsPath: () => join(agent, 'gadget', 'gadget-instructions.md'),
      terminalEnv: (ptyId: string) => ({
        env: { GADGET_TOKEN: `token-of-${ptyId}` },
        binDir: join(agent, 'gadget'),
      }),
      instructions: 'GADGET INSTRUCTIONS',
      allow: [],
    };
    const withTools = materializer({ agentTools: gadget }).materialize(plan({}), project);
    expect(withTools.env.GADGET_TOKEN).toBe(`token-of-${TAB}`);
    expect(withTools.env.PATH).toBe(`${shims()}:${join(agent, 'gadget')}:/usr/bin:/bin`);
    const planned = materializer({ agentTools: gadget }).materialize(plan({}, false), project);
    expect(planned.env).not.toHaveProperty('GADGET_TOKEN');
    expect(planned.env.PATH).toBe(`${shims()}:/usr/bin:/bin`);
    // A host without agent tools names no instructions file in the agent settings.
    const bare = materializer().materialize(plan({}), project);
    expect(readFileSync(bare.env.DOUBLE0_CLAUDE_HOOKS, 'utf8')).not.toContain(
      'gadget-instructions.md',
    );
  });

  it("tells Codex the host's own instructions when the agent tools bring them (plan 29 › M6)", () => {
    const gadget = {
      instructionsPath: () => join(agent, 'gadget', 'gadget-instructions.md'),
      terminalEnv: () => ({ env: {}, binDir: null }),
      instructions: 'HOST INSTRUCTIONS: localhost opens through a forwarded port',
      allow: [],
    };
    materializer({ agentTools: gadget }).materialize(plan({ initialCommand: 'codex' }), project);
    const conf = readFileSync(join(agent, 'double0-codex-hooks.conf'), 'utf8');
    expect(conf).toContain('HOST INSTRUCTIONS');
  });

  it('writes the agent files again once the temp folder was swept', () => {
    const m = materializer();
    m.materialize(plan({ initialCommand: 'claude-personal' }), project);
    const shim = join(agent, CLAUDE_SHIM_DIR_NAME, 'claude');
    const hook = join(agent, 'double0-status-hook.sh');
    expect(readFileSync(shim, 'utf8')).toBe(CLAUDE_SHIM_SCRIPT);
    rmSync(shim);
    rmSync(hook);
    m.materialize(plan({ id: 'conversation:other', initialCommand: 'claude-personal' }), project);
    expect(existsSync(shim)).toBe(true);
    expect(existsSync(hook)).toBe(true);
  });

  it('types the command itself under a shell that cannot source the POSIX launch script', () => {
    const m = materializer({ env: { HOME: home, SHELL: '/usr/bin/fish' } });
    const req = m.materialize(plan({ initialCommand: 'claude-personal' }), project);
    expect(req.file).toBe('/usr/bin/fish');
    expect(req.env).not.toHaveProperty(LAUNCH_ENV);
    // The wrapper line is POSIX sh: fish gets the command verbatim (and no
    // prompt marks - the integration is zsh's and bash's). The shims reach it
    // through its env instead: they run under sh whatever the shell.
    expect(req.typeWhenReady).toEqual({ line: 'claude-personal', promptMarks: false });
    expect(req.env.PATH?.split(':')[0]).toBe(shims());
    expect(req.env.DOUBLE0_CLAUDE_HOOKS).toBe(hooksFile());
  });

  it('gives bash its rc file on Linux only, and no integration when switched off', () => {
    const bash = { HOME: home, SHELL: '/bin/bash' };
    const linux = materializer({ env: bash, platform: 'linux' }).materialize(plan({}), project);
    expect(linux.args[0]).toBe('--rcfile');
    expect(existsSync(linux.args[1])).toBe(true);
    // Linux's locale fallback is the one glibc always has.
    expect(linux.env.LANG).toBe('C.UTF-8');
    const mac = materializer({ env: bash }).materialize(plan({}), project);
    // macOS's bash 3.2 gets no rc file - a login shell, like zsh there.
    expect(mac.args).toEqual(['-l']);
    const off = materializer().materialize(
      plan({ initialCommand: 'claude', shellIntegration: false }),
      project,
    );
    expect(off.env).not.toHaveProperty('ZDOTDIR');
    expect(off.typeWhenReady).toEqual({ line: LAUNCH_LINE, promptMarks: false });
  });

  it('launches verbatim, typed, when there is no private folder for the agent files', () => {
    const req = materializer({ agentRoot: () => null }).materialize(
      plan({ id: `setup:${TAB}`, initialCommand: 'claude' }),
      project,
    );
    expect(req.markerDriven).toBe(false);
    expect(req.env).not.toHaveProperty(LAUNCH_ENV);
    expect(req.env).not.toHaveProperty('ZDOTDIR');
    expect(req.typeWhenReady).toEqual({ line: 'claude', promptMarks: false });
    expect(captures).toEqual([]);
  });

  it('forgets a launch script the shell never ran, with its claimed copies', () => {
    const m = materializer();
    const script = m.materialize(plan({ initialCommand: 'claude' }), project).env[LAUNCH_ENV];
    writeFileSync(`${script}.typed`, 'x');
    m.forgetLaunchScript(TAB);
    expect(existsSync(script)).toBe(false);
    expect(existsSync(`${script}.typed`)).toBe(false);
  });
});

describe('materialize on Windows', () => {
  it('runs a plain claude from the shell command line, hooked through the env and the marker folder', () => {
    // The wiring only - this runs on any OS, so the paths keep the runner's
    // separators; what matters is which pieces are made and where they go.
    const gitBash = join(root, 'Git', 'bin', 'bash.exe');
    mkdirSync(dirname(gitBash), { recursive: true });
    writeFileSync(gitBash, '');
    const m = materializer({
      platform: 'win32',
      env: {
        COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        CLAUDE_CODE_GIT_BASH_PATH: gitBash,
        Path: 'C:\\Windows',
      },
    });
    const req = m.materialize(
      planLaunch(
        { id: TAB, initialCommand: 'claude' },
        { platform: 'win32', appVersion: '0.6.4', agentTools: true },
      ),
      project,
    );
    expect(req.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(req.args).toEqual(['/K', '%DOUBLE0_START_COMMAND%']);
    // Never typed into cmd.exe: its echo would stay on screen.
    expect(req.typeWhenReady).toBeUndefined();
    // Not marker-driven until the stream shows a marker.
    expect(req.markerDriven).toBe(false);
    const settings = windowsSettingsFile();
    const markers = join(agent, 'double0-markers', TAB).replace(/\\/g, '/');
    const record = join(records, 'claude-sessions', TAB).replace(/\\/g, '/');
    expect(req.env).toMatchObject({
      DOUBLE0_START_COMMAND: `claude --settings "${settings.replace(/\\/g, '/')}"`,
      DOUBLE0_USAGE_FILE: gadgetCapture(TAB),
      DOUBLE0_MARKER_DIR: markers,
      DOUBLE0_SESSION_FILE: record,
    });
    // No launch script, no shell integration, no LANG (the console's code page rules).
    expect(req.env).not.toHaveProperty(LAUNCH_ENV);
    expect(req.env).not.toHaveProperty('ZDOTDIR');
    expect(req.env).not.toHaveProperty('LANG');
    // No shims on Windows: nothing for a typed agent beyond what it had.
    expect(req.env).not.toHaveProperty('DOUBLE0_SHIM_DIR');
    expect(req.env).not.toHaveProperty('DOUBLE0_CLAUDE_HOOKS');
    expect(captures).toEqual([[TAB, project]]);
    // The files: the Windows settings naming forward-slashed scripts, the
    // marker folder the hooks write into, the records folder for the hook.
    const written = JSON.parse(readFileSync(settings, 'utf8')) as {
      statusLine: { command: string };
    };
    expect(written.statusLine.command).toContain(statusLineFile().replace(/\\/g, '/'));
    expect(JSON.stringify(written)).not.toContain('\\\\');
    expect(existsSync(join(agent, 'double0-status-hook.sh'))).toBe(true);
    expect(statSync(join(agent, 'double0-markers', TAB)).isDirectory()).toBe(true);
    expect(existsSync(join(records, 'claude-sessions'))).toBe(true);
  });

  it("reports a Windows claude through the marker folder without an extension's status line", () => {
    // The markers never depended on the capture: the core build's Windows tab
    // keeps its agent status.
    const gitBash = join(root, 'Git', 'bin', 'bash.exe');
    mkdirSync(dirname(gitBash), { recursive: true });
    writeFileSync(gitBash, '');
    const req = materializer({
      statusLine: undefined,
      platform: 'win32',
      env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe', CLAUDE_CODE_GIT_BASH_PATH: gitBash },
    }).materialize(
      planLaunch(
        { id: TAB, initialCommand: 'claude' },
        { platform: 'win32', appVersion: '0.6.4', agentTools: true },
      ),
      project,
    );
    expect(req.env.DOUBLE0_START_COMMAND).toContain('--settings');
    expect(req.env.DOUBLE0_MARKER_DIR).toBe(
      join(agent, 'double0-markers', TAB).replace(/\\/g, '/'),
    );
    expect(req.env).not.toHaveProperty('DOUBLE0_USAGE_FILE');
    const written = JSON.parse(readFileSync(windowsSettingsFile(), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(written).not.toHaveProperty('statusLine');
  });

  it('runs claude verbatim when there is no Git Bash to run the hooks under', () => {
    const m = materializer({
      platform: 'win32',
      env: { COMSPEC: 'cmd.exe', CLAUDE_CODE_GIT_BASH_PATH: join(root, 'missing.exe') },
    });
    const req = m.materialize(
      planLaunch(
        { id: TAB, initialCommand: 'claude' },
        { platform: 'win32', appVersion: '1', agentTools: true },
      ),
      project,
    );
    expect(req.env.DOUBLE0_START_COMMAND).toBe('claude');
    expect(req.env).not.toHaveProperty('DOUBLE0_MARKER_DIR');
    expect(captures).toEqual([]);
  });

  describe('a plain shell, for a claude typed at its prompt', () => {
    const gitBash = (): string => {
      const path = join(root, 'Git', 'bin', 'bash.exe');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
      return path;
    };
    const plainOn = (shell: string, bash: string) =>
      materializer({
        platform: 'win32',
        env: { COMSPEC: shell, CLAUDE_CODE_GIT_BASH_PATH: bash, Path: 'C:\\Windows' },
      }).materialize(
        planLaunch({ id: TAB }, { platform: 'win32', appVersion: '0.6.4', agentTools: true }),
        project,
      );

    it('defines the doskey macro in cmd.exe and reports through the marker folder', () => {
      const req = plainOn('C:\\Windows\\System32\\cmd.exe', gitBash());
      const helper = join(agent, WINDOWS_CLAUDE_HELPER_NAME);
      expect(req.args).toEqual(['/K', '%DOUBLE0_SHELL_SETUP%']);
      expect(req.env).toMatchObject({
        DOUBLE0_SHELL_SETUP: `doskey claude="${helper}" $*`,
        DOUBLE0_CLAUDE_HOOKS: windowsSettingsFile(),
        DOUBLE0_USAGE_FILE: gadgetCapture(TAB),
        DOUBLE0_MARKER_DIR: join(agent, 'double0-markers', TAB).replace(/\\/g, '/'),
      });
      expect(readFileSync(helper, 'utf8')).toBe(WINDOWS_CLAUDE_HELPER);
      // Nothing typed, no start command, no shims on PATH.
      expect(req.typeWhenReady).toBeUndefined();
      expect(req.env).not.toHaveProperty('DOUBLE0_START_COMMAND');
      expect(req.env).not.toHaveProperty('DOUBLE0_SHIM_DIR');
      expect(captures).toEqual([[TAB, project]]);
    });

    it('defines the claude function in PowerShell', () => {
      const req = plainOn('C:\\Program Files\\PowerShell\\7\\pwsh.exe', gitBash());
      expect(req.args).toEqual([
        '-NoExit',
        '-Command',
        'Invoke-Expression $env:DOUBLE0_SHELL_SETUP',
      ]);
      expect(req.env.DOUBLE0_SHELL_SETUP).toBe(POWERSHELL_CLAUDE_FUNCTION);
      expect(req.env.DOUBLE0_MARKER_DIR).toBeDefined();
    });

    it('starts the shell plain without Git Bash to run the hooks under, or for another shell', () => {
      for (const req of [
        plainOn('cmd.exe', join(root, 'missing.exe')),
        plainOn('C:\\Program Files\\Git\\bin\\bash.exe', gitBash()),
      ]) {
        expect(req.args).toEqual([]);
        expect(req.env).not.toHaveProperty('DOUBLE0_SHELL_SETUP');
        expect(req.env).not.toHaveProperty('DOUBLE0_MARKER_DIR');
      }
      expect(captures).toEqual([]);
    });
  });
});

describe('the import graph', () => {
  it('reaches nothing but node built-ins, so the session daemon can run it', () => {
    // The daemon runs as plain node (ELECTRON_RUN_AS_NODE, and on a remote
    // host the runtime's own Node): one `electron` import anywhere below this
    // module - an extension's IPC module, say - would kill it at load.
    const seen = new Set<string>();
    const bare = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      // Static imports and re-exports, dynamic `import('…')` and `require('…')`.
      // Template literals are blanked for the second pass: the agent files
      // embed whole scripts (an agent tool's `require('net')`) that run as
      // their own processes, never as part of this module.
      const code = src.replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``');
      const specs = [
        // `import type` is erased at build: it loads nothing.
        ...src.matchAll(/^(?:import|export)\s(?!type\s)[^;]*?from\s+'([^']+)'/gms),
        ...code.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((m) => m[1]);
      for (const spec of specs) {
        if (!spec.startsWith('.')) {
          bare.add(spec);
          continue;
        }
        const base = resolve(dirname(file), spec);
        const next = [`${base}.ts`, join(base, 'index.ts')].find((p) => existsSync(p));
        if (next) visit(next);
      }
    };
    visit(join(__dirname, 'launch-materialize.ts'));
    expect(seen.size).toBeGreaterThan(5);
    expect([...bare].filter((spec) => !spec.startsWith('node:'))).toEqual([]);
    // The remote daemon's modules run on a host under the runtime's own Node,
    // beside the materialiser: the same rule, checked in Pro's
    // the official build (plan 28 › M2, a private plan › M7).
  });
});
