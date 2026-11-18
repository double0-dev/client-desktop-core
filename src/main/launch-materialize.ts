import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  claudeConfigDir,
  claudeSessionIdForPty,
  claudeSessionRecordPath,
  claudeSessionRecordsDir,
  codexSessionRecordFor,
  codexSessionRecordsDir,
  opencodeSessionRecordsDir,
  resolveClaudeSession,
  resolveOpencodeSession,
} from './agent-resume';
import {
  MARKER_DIR_ENV,
  STATUS_HOOK_SCRIPT,
  USAGE_FILE_ENV,
  claudeStatusSettings,
  gitBashPath,
} from './claude-status-hooks';
import {
  CLAUDE_SHIM_DIR_NAME,
  CLAUDE_SHIM_HOOKS_ENV,
  CLAUDE_SHIM_SCRIPT,
  CODEX_SHIM_SCRIPT,
  OPENCODE_SHIM_SCRIPT,
  WINDOWS_CLAUDE_HELPER,
  WINDOWS_CLAUDE_HELPER_NAME,
  launchesPosixShell,
  shellAgentEnv,
  windowsShellSetup,
} from './claude-shim';
import { CODEX_HOOKS_FILE_NAME, codexHooksFile } from './codex-status-hooks';
import { keptFiles } from './kept-files';
import { augmentAgentCommand, type LaunchPlan, type LaunchResources } from './launch-plan';
import {
  OPENCODE_PLUGIN_DIR_NAME,
  OPENCODE_PLUGIN_FILE_NAME,
  OPENCODE_STATUS_PLUGIN,
} from './opencode-status-plugin';
import { agentFilesRoot } from './private-tmp';
import type { HostSpawnRequest } from './pty-host';
import {
  BASH_INTEGRATION_FOLDER,
  SHELL_INTEGRATION_DIR_NAME,
  ZSH_INTEGRATION_FOLDER,
  bashIntegration,
  bashIntegrationFiles,
  zshIntegration,
  zshIntegrationFiles,
  type ShellIntegration,
} from './shell-integration';
import {
  LAUNCH_DIR_NAME,
  LAUNCH_ENV,
  LAUNCH_LINE,
  launchScript,
  launchScriptPaths,
  windowsLaunch,
  type StartupTyping,
} from './startup-typer';
import { PTY_TERM, applyTerminalEnv, withDirOnPath } from './terminal-env';
import { withAgentBinsOnPath } from './agent-bins';

/**
 * The host's half of a spawn (a private plan › 8.2): from
 * main's `LaunchPlan` to the `HostSpawnRequest` a `PtyHost` runs, on THIS
 * machine's filesystem - the shell, the cwd check, the env, the agent files
 * (hook script, settings, shims, plugin, shell integration), the launch script
 * and the resume decision. Pure node, never Electron (directly or through an
 * import): the session daemon will run it on a remote host. What only main has
 * today - the userData folder, an extension's status line and agent tools -
 * comes in through `MaterializeDeps`.
 */

/**
 * An extension's Claude Code status line (`MaterializeDeps.statusLine`): the
 * `statusLine` command in the injected settings and the per-tab capture file
 * it writes, named to the agent in DOUBLE0_USAGE_FILE (the `codex` shim
 * writes into the same file). The extension reads the captures. Absent = no
 * status line is injected - the user's own stays - and no capture is made.
 */
export type AgentStatusLine = {
  /** The script's source, written beside the hook script (0755). */
  script: string;
  /** The settings' `statusLine` entry for the script at `path`, Claude's default config dir given. */
  entry: (path: string, configDir: string) => object;
  /** The pty's capture file for this launch, or null when it cannot be made (the launch goes ahead without). */
  capture: (ptyId: string, cwd: string) => string | null;
};

/** An extension's tools for agents (a CLI of its own): `MaterializeDeps.agentTools`. */
export type AgentTools = {
  /** The instructions file the agent settings name (Claude's SessionStart prints it). */
  instructionsPath: () => string | null;
  /** A terminal's env, and the folder put first on its PATH. */
  terminalEnv: (ptyId: string) => { env: Record<string, string>; binDir: string | null };
  /** What Codex is told (its `developer_instructions`). */
  instructions: string;
  /** Commands an agent runs without a prompt (Claude's `permissions.allow`). */
  allow: readonly string[];
};

export type MaterializeDeps = {
  /** Where the per-tab session records live (the app's userData locally). */
  recordsRoot: () => string;
  /** An extension's status line. Absent = none (the core build). */
  statusLine?: AgentStatusLine;
  /**
   * An extension's tools for the agents on this host: the instructions file
   * the agent settings name, a terminal's env and the folder put first on its
   * PATH, what Codex is told, the commands an agent may run without asking.
   * Absent = none here (the core build).
   */
  agentTools?: AgentTools;
  /**
   * The environment shells start from (default: this process's). A remote
   * daemon passes a getter: its agent forward comes and goes (spec 10.2).
   */
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  /**
   * The launch shell (default: `defaultShell` over `env`). A remote daemon
   * adds the passwd step (daemon/remote-spawn.ts › hostShellOf).
   */
  shell?: () => string;
  platform?: NodeJS.Platform;
  /** The home folder (default: os.homedir()). */
  home?: () => string;
  /** The private folder for the agent files (default: private-tmp.ts). */
  agentRoot?: () => string | null;
};

/**
 * The launch shell: `$SHELL`, else the platform's usual one. No $SHELL (a
 * service manager, a stripped env): zsh is always there on macOS, often
 * missing on Linux - bash, else plain sh.
 */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform === 'win32') return env.COMSPEC ?? 'powershell.exe';
  if (env.SHELL) return env.SHELL;
  if (platform === 'darwin') return '/bin/zsh';
  return exists('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

/** Shells that take `-l` as their only argument to start as a login shell. */
const LOGIN_FLAG_SHELLS = new Set(['zsh', 'bash', 'sh', 'ksh', 'fish']);

/**
 * A macOS shell's arguments when nothing else gives it any: `-l`, a login
 * shell, as every macOS terminal starts one. Homebrew's `brew shellenv` and
 * most toolchain PATH lines live in `~/.zprofile`, which only a login zsh
 * reads, and an app opened from the Dock or Finder inherits launchd's bare
 * PATH - so a terminal's `pnpm run dev` said `command not found: pnpm`
 * (2026-11-15) while `pnpm dev`, started from an already set-up terminal,
 * hid it. The zsh integration chains `.zprofile` and hands ZDOTDIR back
 * before `.zlogin` (shell-integration.ts). Linux terminals start shells
 * plain - the desktop login read the profile already.
 */
export function loginShellArgs(shell: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'darwin') return [];
  const name = shell.split('/').pop()?.replace(/^-/, '') ?? '';
  return LOGIN_FLAG_SHELLS.has(name) ? ['-l'] : [];
}

/**
 * Validate a renderer-supplied cwd before handing it to `spawn`. Expands a
 * leading `~`, then requires the path to exist and be a directory; anything
 * missing/invalid (or absent) falls back to the home dir rather than being
 * passed through unchecked.
 */
export async function resolveLaunchCwd(
  cwd: string | null | undefined,
  home: string = homedir(),
): Promise<string> {
  if (cwd) {
    const expanded = cwd === '~' || cwd.startsWith('~/') ? join(home, cwd.slice(1)) : cwd;
    try {
      if ((await stat(expanded)).isDirectory()) return expanded;
    } catch {
      // Missing or inaccessible - fall through to home.
    }
  }
  return home;
}

/**
 * `<stem>-<12 hex of the body's sha256><ext>`: the agent files folder is
 * shared by every build on the machine (the installed app, `pnpm dev`, the
 * core edition), and a file the builds write differently - the Claude
 * settings carry an extension's status line and agent tools, or not - is
 * trusted by each build while it exists (kept-files.ts), so under one name
 * the last build to write it would decide for all of them. Named by content,
 * builds that agree share a file and builds that differ never meet.
 */
export function contentFileName(stem: string, ext: string, body: string): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
  return `${stem}-${hash}${ext}`;
}

export type LaunchMaterializer = {
  /** The cwd a spawn runs in: the asked one when it is a folder, else home. */
  resolveCwd: (cwd: string | null | undefined) => Promise<string>;
  /**
   * The spawn for `plan` in `cwd` (already resolved). Synchronous: it writes
   * the files a launch needs and returns, so a caller can check that the spawn
   * is still wanted before calling it (nothing is written for a cancelled one).
   */
  materialize: (plan: LaunchPlan, cwd: string) => HostSpawnRequest;
  /** A launch script the shell never ran (it exited first) goes with it. */
  forgetLaunchScript: (id: string) => void;
};

function isDirSync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function createLaunchMaterializer(deps: MaterializeDeps): LaunchMaterializer {
  const env = (): NodeJS.ProcessEnv =>
    typeof deps.env === 'function' ? deps.env() : (deps.env ?? process.env);
  const platform = (): NodeJS.Platform => deps.platform ?? process.platform;
  const home = (): string => (deps.home ? deps.home() : homedir());
  const configDir = (): string => claudeConfigDir(env(), home());

  /**
   * The folder the files below go to: the per-user temp folder, a private
   * `double0-<uid>` one on Linux (private-tmp.ts). Throws when there is none -
   * each writer then gives up, as on a failed write.
   */
  const agentDir = (): string => {
    const root = deps.agentRoot ? deps.agentRoot() : agentFilesRoot();
    if (!root) throw new Error('no private folder for the agent files');
    return root;
  };

  // Every writer below goes through keptFiles (kept-files.ts): the files are
  // written on first use and again whenever one has gone missing - the temp
  // folder is swept under an app that stays open for days. Each answers null
  // when the write failed; the launch then runs without that piece.

  // The hook script every hook-style CLI (Claude Code, Codex) runs.
  const statusHookScriptPath = keptFiles(() => {
    // The temp folder (not userData - that path can contain spaces) so the injected flag
    // and the hook command stay simple single-quoted tokens.
    const script = join(agentDir(), 'double0-status-hook.sh');
    writeFileSync(script, STATUS_HOOK_SCRIPT, 'utf8');
    chmodSync(script, 0o755); // writeFileSync only applies a mode on creation
    return { path: script, files: [script] };
  });

  /**
   * The extension's status line script, written where the hook script goes;
   * null without one. Inside the settings writers' keptFiles, which re-run it
   * whenever the file has gone.
   */
  const writeStatusLine = (): string | null => {
    if (!deps.statusLine) return null;
    const { script } = deps.statusLine;
    const path = join(agentDir(), contentFileName('double0-status-line', '.sh', script));
    writeFileSync(path, script, 'utf8');
    chmodSync(path, 0o755);
    return path;
  };

  // Path to the managed settings file (plus the hook script it references).
  // null if they couldn't be written - then we just skip augmentation and fall
  // back to output/idle detection for that session.
  const claudeStatusSettingsPath = keptFiles(() => {
    const script = statusHookScriptPath();
    if (!script) throw new Error('no hook script');
    // An extension's status line (AgentStatusLine), when there is one.
    const statusLine = writeStatusLine();
    const instructionsPath = deps.agentTools?.instructionsPath() ?? null;
    const settings = claudeStatusSettings(
      script,
      statusLine ? deps.statusLine?.entry(statusLine, configDir()) : undefined,
      instructionsPath && deps.agentTools
        ? { instructionsPath, allow: deps.agentTools.allow }
        : undefined,
    );
    const body = JSON.stringify(settings, null, 2);
    const p = join(agentDir(), contentFileName('double0-claude-status-hooks', '.json', body));
    writeFileSync(p, body, 'utf8');
    return { path: p, files: [p, script, ...(statusLine ? [statusLine] : [])] };
  });

  // Windows: the status hooks and the status line (claude-status-hooks.ts ›
  // Windows), script paths in forward slashes - Git Bash reads a backslash as
  // an escape.
  const claudeWindowsSettingsPath = keptFiles(() => {
    const script = statusHookScriptPath();
    if (!script) throw new Error('no hook script');
    const statusLine = writeStatusLine();
    const settings = claudeStatusSettings(
      script.replace(/\\/g, '/'),
      statusLine ? deps.statusLine?.entry(statusLine.replace(/\\/g, '/'), configDir()) : undefined,
    );
    const body = JSON.stringify(settings, null, 2);
    const p = join(agentDir(), contentFileName('double0-claude-windows-settings', '.json', body));
    writeFileSync(p, body, 'utf8');
    return { path: p, files: [p, script, ...(statusLine ? [statusLine] : [])] };
  });

  /**
   * Windows: the pty's marker folder (marker-inbox.ts), in forward slashes, as
   * the hook script writes into it; null when it could not be made. Never
   * emptied here: this launch may only re-adopt a live terminal in the daemon,
   * whose undrained markers the folder holds - `PtyHost.spawn` empties it for a
   * NEW shell.
   */
  const windowsMarkerDir = (ptyId: string): string | null => {
    try {
      const dir = join(agentDir(), 'double0-markers', ptyId.replace(/[^\w-]/g, '_'));
      mkdirSync(dir, { recursive: true });
      return dir.replace(/\\/g, '/');
    } catch {
      return null;
    }
  };

  // The Codex `-c` override list the `codex` shim injects (codex-status-hooks.ts),
  // one per line. null if it couldn't be written - Codex then launches with no
  // hooks, as it used to.
  const codexHooksPath = keptFiles(() => {
    const script = statusHookScriptPath();
    if (!script) throw new Error('no hook script');
    const p = join(agentDir(), CODEX_HOOKS_FILE_NAME);
    writeFileSync(
      p,
      codexHooksFile(
        script,
        deps.agentTools?.instructionsPath() ? deps.agentTools.instructions : undefined,
      ),
      'utf8',
    );
    return { path: p, files: [p, script] };
  });

  // The OpenCode status plugin (opencode-status-plugin.ts), in its own folder so
  // the `file://` spec that loads it is a plain path. null if it couldn't be
  // written - OpenCode then runs without status, as it used to.
  const opencodePluginPath = keptFiles(() => {
    const dir = join(agentDir(), OPENCODE_PLUGIN_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, OPENCODE_PLUGIN_FILE_NAME);
    writeFileSync(p, OPENCODE_STATUS_PLUGIN, 'utf8');
    return { path: p, files: [p] };
  });

  // The PATH shims for start commands the adapters don't recognise (see
  // claude-shim.ts): `claude` (hooks + pin), `codex` (account + hooks),
  // `opencode` (pin), next to the hook files. null if they couldn't be written -
  // such a launch then runs verbatim, as it used to.
  const claudeShimDir = keptFiles(() => {
    const dir = join(agentDir(), CLAUDE_SHIM_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (const [name, body] of [
      ['claude', CLAUDE_SHIM_SCRIPT],
      ['codex', CODEX_SHIM_SCRIPT],
      ['opencode', OPENCODE_SHIM_SCRIPT],
    ] as const) {
      const shim = join(dir, name);
      writeFileSync(shim, body, 'utf8');
      chmodSync(shim, 0o755);
      files.push(shim);
    }
    return { path: dir, files };
  });

  // Windows: the helper a plain cmd.exe tab's doskey macro calls for a typed
  // `claude` (claude-shim.ts › WINDOWS_CLAUDE_HELPER).
  const windowsClaudeHelperPath = keptFiles(() => {
    const p = join(agentDir(), WINDOWS_CLAUDE_HELPER_NAME);
    writeFileSync(p, WINDOWS_CLAUDE_HELPER, 'utf8');
    return { path: p, files: [p] };
  });

  /**
   * The folder holding the zsh integration's startup files - null if it could
   * not be written, and the shells then start as they always did.
   */
  const shellIntegrationDir = keptFiles(() => {
    const dir = join(agentDir(), SHELL_INTEGRATION_DIR_NAME, ZSH_INTEGRATION_FOLDER);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (const [name, body] of Object.entries(zshIntegrationFiles())) {
      writeFileSync(join(dir, name), body, 'utf8');
      files.push(join(dir, name));
    }
    return { path: dir, files };
  });

  /** The folder holding the bash integration's rc file - null if not written. */
  const bashIntegrationDir = keptFiles(() => {
    const dir = join(agentDir(), SHELL_INTEGRATION_DIR_NAME, BASH_INTEGRATION_FOLDER);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (const [name, body] of Object.entries(bashIntegrationFiles())) {
      writeFileSync(join(dir, name), body, 'utf8');
      files.push(join(dir, name));
    }
    return { path: dir, files };
  });

  /** The integration for a spawn of `shell`, unless the user turned it off. */
  const shellIntegrationFor = (shell: string, enabled: boolean): ShellIntegration | null => {
    if (!enabled || platform() === 'win32') return null;
    const name = shell.split(/[\\/]/).pop()?.replace(/^-/, '') ?? '';
    if (name === 'bash') {
      // Linux only: macOS's bash is 3.2 and nobody has run the rc file there.
      if (platform() !== 'linux') return null;
      const dir = bashIntegrationDir();
      return dir ? bashIntegration(shell, dir) : null;
    }
    const dir = shellIntegrationDir();
    return dir ? zshIntegration(shell, dir, env().ZDOTDIR) : null;
  };

  /** Where terminal `id`'s launch script lives (startup-typer.ts). */
  const launchScriptPath = (id: string): string =>
    join(agentDir(), LAUNCH_DIR_NAME, `${encodeURIComponent(id)}.sh`);

  /**
   * Write terminal `id`'s launch script, owner-only. Null when it could not be
   * written - the command is then typed as is.
   */
  const writeLaunchScript = (id: string, command: string): string | null => {
    try {
      const path = launchScriptPath(id);
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(path, launchScript(command), { encoding: 'utf8', mode: 0o600 });
      return path;
    } catch {
      return null;
    }
  };

  const forgetLaunchScript = (id: string): void => {
    try {
      for (const path of launchScriptPaths(launchScriptPath(id))) rmSync(path, { force: true });
    } catch {
      // No agent folder: nothing was written.
    }
  };

  const resources = (shell: string): LaunchResources => ({
    shell,
    hasGitBash: () => gitBashPath(env(), existsSync) !== null,
    claudeSettings: claudeStatusSettingsPath,
    claudeWindowsSettings: claudeWindowsSettingsPath,
    shimDir: claudeShimDir,
    codexHooks: codexHooksPath,
    opencodePlugin: opencodePluginPath,
    claudeSession: ({ ptyId, cwd }) =>
      resolveClaudeSession(ptyId, cwd, {
        configDir: configDir(),
        recordsDir: claudeSessionRecordsDir(deps.recordsRoot()),
      }),
    opencodeSession: (ptyId) =>
      resolveOpencodeSession(ptyId, opencodeSessionRecordsDir(deps.recordsRoot())),
    codexRecord: (ptyId) =>
      codexSessionRecordFor(ptyId, codexSessionRecordsDir(deps.recordsRoot())),
    usageCapture: ({ ptyId, cwd }) => deps.statusLine?.capture(ptyId, cwd) ?? null,
    windowsMarkerDir,
    windowsSessionRecord: (ptyId) => {
      const tabId = claudeSessionIdForPty(ptyId);
      if (!tabId) return null;
      const records = claudeSessionRecordsDir(deps.recordsRoot());
      try {
        mkdirSync(records, { recursive: true });
        return claudeSessionRecordPath(records, tabId).replace(/\\/g, '/');
      } catch {
        return null;
      }
    },
  });

  /**
   * A terminal's env: never bare process.env - a Finder-launched app has no
   * COLORTERM/LANG and programs paint accordingly (terminal-env.ts has the
   * story) - plus the shell integration's and the extension's agent tools'
   * (their env, their folder first on PATH).
   */
  const spawnEnv = (
    plan: LaunchPlan,
    integration: Record<string, string> | undefined,
  ): Record<string, string> => {
    const base = applyTerminalEnv(env(), plan.overlayEnv, platform());
    const agent =
      plan.agentTools && deps.agentTools
        ? deps.agentTools.terminalEnv(plan.id)
        : { env: {}, binDir: null as string | null };
    const out: Record<string, string> = { ...base, ...integration, ...agent.env };
    const withTools = agent.binDir ? withDirOnPath(out, agent.binDir, platform()) : out;
    // The agent CLIs' install folders, last (agent-bins.ts): a fish or plain
    // `-l` shell has no rc of ours to add them.
    return withAgentBinsOnPath(withTools, home(), isDirSync, platform());
  };

  /**
   * `out` with what an agent typed at the shell's prompt needs to report its
   * status (claude-shim.ts › shellAgentEnv) and the shims' folder first on
   * PATH. Every shell gets it, a start command or not. Not on Windows (no
   * shims there), nor when the files could not be written.
   */
  const withShellAgents = (
    out: Record<string, string>,
    res: LaunchResources,
    launch: { ptyId: string; cwd: string },
  ): Record<string, string> => {
    if (platform() === 'win32') return out;
    const settingsPath = res.claudeSettings();
    const shimDir = res.shimDir();
    if (!settingsPath || !shimDir) return out;
    const agentEnv = shellAgentEnv(
      {
        shimDir,
        settingsPath,
        usageFile: res.usageCapture(launch),
        codexHooksPath: res.codexHooks(),
        opencodePluginPath: res.opencodePlugin(),
      },
      out,
    );
    return withDirOnPath({ ...out, ...agentEnv }, shimDir, platform());
  };

  /**
   * Windows: how a plain cmd.exe / PowerShell tab starts so that a `claude`
   * typed at its prompt gets the hooks (claude-shim.ts › windowsShellSetup),
   * and the env those hooks report through - the marker folder the host
   * drains, the status line capture. Null (a plain shell, as before) for another
   * shell, without Git Bash to run the hook scripts under, or when a file
   * could not be written.
   */
  const windowsShellAgents = (
    shell: string,
    res: LaunchResources,
    launch: { ptyId: string; cwd: string },
  ): { args: string[]; env: Record<string, string> } | null => {
    if (!res.hasGitBash()) return null;
    const settings = res.claudeWindowsSettings();
    const helper = windowsClaudeHelperPath();
    const setup = settings && helper ? windowsShellSetup(shell, helper) : null;
    if (!settings || !setup) return null;
    const markerDir = res.windowsMarkerDir(launch.ptyId);
    if (!markerDir) return null;
    const usageFile = res.usageCapture(launch);
    return {
      args: setup.args,
      env: {
        ...setup.env,
        [CLAUDE_SHIM_HOOKS_ENV]: settings,
        ...(usageFile ? { [USAGE_FILE_ENV]: usageFile } : {}),
        [MARKER_DIR_ENV]: markerDir,
      },
    };
  };

  const materialize = (plan: LaunchPlan, cwd: string): HostSpawnRequest => {
    const shell = deps.shell ? deps.shell() : defaultShell(env(), platform());
    // One status line capture per spawn: preparing it again would empty the
    // file the start command was just pointed at.
    let usageFile: string | null | undefined;
    const base = resources(shell);
    const res: LaunchResources = {
      ...base,
      usageCapture: (launch) =>
        usageFile === undefined ? (usageFile = base.usageCapture(launch)) : usageFile,
    };
    // An agent session gets our status hooks injected (see launch-plan.ts ›
    // AGENT_ADAPTERS); everything else runs verbatim.
    const launch = plan.command
      ? augmentAgentCommand(plan.command, { ptyId: plan.id, cwd }, res, platform())
      : undefined;
    // Shell integration reports each command for the Inputs list, and marks the
    // prompt the start command waits for.
    const integration = shellIntegrationFor(shell, plan.shellIntegration);
    // The start command is TYPED at the shell's first prompt, like the user
    // typing it (startup-typer.ts has why: an rc that wraps or replaces the
    // shell broke the old in-shell `-c` launch). A POSIX shell sources it from
    // a launch script, so the injected env never fills the screen.
    const script =
      launch && launchesPosixShell(shell) ? writeLaunchScript(plan.id, launch.command) : null;
    // cmd.exe and PowerShell run it from their command line instead: typed, its
    // echo stayed on screen (startup-typer.ts › windowsLaunch).
    const fromArgs = launch && platform() === 'win32' ? windowsLaunch(shell, launch.command) : null;
    // A plain Windows shell: set up for a `claude` typed at its prompt.
    const winAgents =
      !launch && platform() === 'win32'
        ? windowsShellAgents(shell, res, { ptyId: plan.id, cwd })
        : null;
    const typing: StartupTyping | undefined =
      launch && !fromArgs
        ? { line: script ? LAUNCH_LINE : launch.command, promptMarks: integration !== null }
        : undefined;
    return {
      id: plan.id,
      file: shell,
      args:
        fromArgs?.args ?? winAgents?.args ?? integration?.args ?? loginShellArgs(shell, platform()),
      name: PTY_TERM,
      cols: plan.cols,
      rows: plan.rows,
      // Validated by `resolveCwd`: an existing directory, or the home dir.
      cwd,
      env: {
        ...withShellAgents(spawnEnv(plan, integration?.env), res, { ptyId: plan.id, cwd }),
        ...(script ? { [LAUNCH_ENV]: script } : {}),
        ...launch?.env,
        ...fromArgs?.env,
        ...winAgents?.env,
      },
      markerDriven: launch?.markerDriven ?? false,
      ...(typing ? { typeWhenReady: typing } : {}),
    };
  };

  return {
    resolveCwd: (cwd) => resolveLaunchCwd(cwd, home()),
    materialize,
    forgetLaunchScript,
  };
}
