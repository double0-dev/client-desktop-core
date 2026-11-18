import { SESSION_RECORD_ENV, shellQuote, withClaudeSession } from './agent-resume';
import { MARKER_DIR_ENV, USAGE_FILE_ENV, windowsClaudeCommand } from './claude-status-hooks';
import { launchesPosixShell, wrapperLaunchCommand } from './claude-shim';
import { terminalOverlay } from './terminal-env';

/**
 * What to run in a new terminal, decided in main (a private plan
 * › 8.1). Pure: no fs, no Electron. The other half - where the shell, the cwd,
 * the agent files, the resume decision and the status line capture come from - is
 * the host's (launch-materialize.ts), which hands this file the pieces it
 * resolved through `LaunchResources` and gets the start command back.
 *
 * Session status is driven by REAL signals from the agent - lifecycle hooks
 * that write an invisible private OSC marker (code 6790 + verb) to the session
 * pty, which observeSessionStatus (renderer) consumes. The hook script and the
 * Claude event → verb mapping live in claude-status-hooks.ts, the Codex `-c`
 * overrides in codex-status-hooks.ts and the OpenCode plugin in
 * opencode-status-plugin.ts; launch-materialize.ts writes them to disk and
 * this file puts them on the launch line (see AGENT_ADAPTERS and wrapperLaunch).
 */

/**
 * Which launch path a start command takes: the plain `claude` adapter, the
 * PATH-shim wrapper for everything else (POSIX), the Windows `claude` env
 * injection, or none (a bare shell, or a Windows command that runs verbatim).
 */
export type LaunchAdapter = 'claude' | 'wrapper' | 'windows' | null;

export type LaunchPlan = {
  /** The terminal's id (identifies the tab, hence its agent conversation). */
  id: string;
  /** The raw start command, trimmed; null for a bare shell. */
  command: string | null;
  /**
   * Expectation only - the materialised request is authoritative: the host
   * picks the path again from the command (a wrapper launch also needs a
   * POSIX shell there). `materialize` does not read it; M2's `prepareLaunch`
   * will check it against the host.
   */
  adapter: LaunchAdapter;
  /**
   * Expectation only - the materialised request is authoritative: the plain
   * `claude` adapter's hooks emit markers, but the host may find it cannot
   * write the hook files (`request.markerDriven` is then false, and this may
   * disagree), and the stream rules afterwards (TerminalModeTracker.markerDriven).
   * `materialize` does not read it.
   */
  markerDriven: boolean;
  /** Settings › Terminal › shell integration (anything but an explicit off). */
  shellIntegration: boolean;
  /** The variables the app contributes, whatever host the shell runs on. */
  overlayEnv: Record<string, string>;
  /**
   * The extension's agent tools apply here (`MaterializeDeps.agentTools`: a
   * CLI on PATH, its env, its instructions) - where the host offers them.
   */
  agentTools: boolean;
  /**
   * Expectation only - the materialised request is authoritative: the cwd as
   * the renderer gave it, which the host validates (`resolveCwd`, falling back
   * to its home) and passes to `materialize` separately.
   */
  cwd: string | null;
  cols: number;
  rows: number;
};

export type LaunchRequest = {
  id: string;
  cwd?: string | null;
  cols?: number;
  rows?: number;
  initialCommand?: string;
  shellIntegration?: boolean;
};

const CLAUDE_COMMAND = /^claude(\s|$)/;

/** The launch path a start command takes on `platform`. */
export function adapterFor(command: string | null, platform: NodeJS.Platform): LaunchAdapter {
  if (!command) return null;
  if (platform === 'win32') return CLAUDE_COMMAND.test(command) ? 'windows' : null;
  return AGENT_ADAPTERS.some((a) => a.match.test(command)) ? 'claude' : 'wrapper';
}

/** Main's half of a spawn: from what the renderer asked for to a plan. */
export function planLaunch(
  req: LaunchRequest,
  ctx: { platform: NodeJS.Platform; appVersion: string; agentTools: boolean },
): LaunchPlan {
  const command = req.initialCommand?.trim() || null;
  const adapter = adapterFor(command, ctx.platform);
  return {
    id: req.id,
    command,
    adapter,
    markerDriven: adapter === 'claude',
    shellIntegration: req.shellIntegration !== false,
    overlayEnv: terminalOverlay(ctx.appVersion),
    agentTools: ctx.agentTools,
    cwd: req.cwd ?? null,
    cols: req.cols && req.cols > 0 ? req.cols : 80,
    rows: req.rows && req.rows > 0 ? req.rows : 24,
  };
}

/**
 * What an adapter needs beyond the command itself: the PTY it is launching in
 * (which identifies the tab, hence its agent conversation) and the directory it
 * will run in (which scopes that conversation on disk).
 */
export type AgentLaunch = { ptyId: string; cwd: string };

/** A tab's Claude conversation as the host resolved it (agent-resume.ts). */
export type ResolvedClaudeSession = { sessionId: string; exists: boolean; recordPath: string };

/**
 * Everything a launch line names that lives on the host: the agent files, the
 * resume decision, the status line capture. Each getter writes or reads on first
 * call, so the launch below asks for a piece only when its path needs it -
 * the order (and so the files written) is today's. Null = could not be
 * written; the launch then runs without that piece.
 */
export type LaunchResources = {
  /** The launch shell (decides whether the wrapper's POSIX line may run). */
  shell: string;
  /** Windows: Claude Code finds a Git Bash to run the hook scripts under. */
  hasGitBash: () => boolean;
  claudeSettings: () => string | null;
  claudeWindowsSettings: () => string | null;
  shimDir: () => string | null;
  codexHooks: () => string | null;
  opencodePlugin: () => string | null;
  claudeSession: (launch: AgentLaunch) => ResolvedClaudeSession | null;
  opencodeSession: (ptyId: string) => { sessionId: string | null; recordPath: string } | null;
  codexRecord: (ptyId: string) => string | null;
  /**
   * The tab's status line capture (launch-materialize.ts › AgentStatusLine),
   * named to the agent in DOUBLE0_USAGE_FILE: null without an extension's
   * status line, or when it could not be made.
   */
  usageCapture: (launch: AgentLaunch) => string | null;
  windowsMarkerDir: (ptyId: string) => string | null;
  windowsSessionRecord: (ptyId: string) => string | null;
};

export type ComposedLaunch = {
  command: string;
  markerDriven: boolean;
  env?: Record<string, string>;
};

/**
 * Per-agent startup-command adapters: how each agent CLI gets wired to the
 * status script, and pinned to this tab's conversation so a restart resumes it
 * (see agent-resume.ts). Only a plain leading `claude ...` form is rewritten
 * here (the built-in template + the common typed forms like `claude --resume`);
 * every other start command goes through `wrapperLaunch`, which exports the
 * env every agent's injection reads and puts the PATH shims first: the
 * `claude` shim does this adapter's rewrite the moment a wrapper reaches
 * `claude` by name, the `codex` shim injects the Codex hooks
 * (codex-status-hooks.ts), the `opencode` shim pins the tab's OpenCode
 * session, and OpenCode loads its status plugin off the exported inline
 * config (opencode-status-plugin.ts). So a plain `codex` or `opencode` start
 * command needs no entry here - the wrapper path IS their adapter. POSIX only
 * - the mechanism relies on the launch shell's tty. The renderer side is
 * agent-agnostic (it just consumes 6790 markers). Map a new CLI's events by
 * probing the real binary, not its docs - see scripts/probe-claude-hooks.py,
 * probe-codex-hooks.py and probe-opencode-hooks.py for the recipes (hook log
 * + standalone-BEL log under a pty); a private plan lists
 * what each CLI supports and what is verified.
 */
/**
 * An adapter's result: the rewritten command plus any environment the launch
 * shell must export for it (inherited by the agent and, through it, by every
 * hook process it spawns). Values are quoted by `augmentAgentCommand`.
 */
type AgentInjection = {
  command: string;
  env?: Record<string, string>;
  /** The rewritten command will emit status markers (hooks in place). */
  markerDriven?: boolean;
};

const AGENT_ADAPTERS: Array<{
  match: RegExp;
  inject: (command: string, launch: AgentLaunch, res: LaunchResources) => AgentInjection;
}> = [
  {
    match: CLAUDE_COMMAND,
    inject: (command, launch, res) => {
      const settings = res.claudeSettings();
      const withHooks = settings
        ? command.replace(/^claude/, `claude --settings '${settings}'`)
        : command;
      // This tab's own conversation: resumed if it has one, freshly named if not.
      // The id is the tab's LAST recorded session when there is one (a `/clear`
      // or in-Claude `/resume` moved it there), else the tab's own uuid. A PTY
      // with no stable uuid (the setup shell) resolves to null and launches
      // unpinned, and records nothing.
      const plan = res.claudeSession(launch);
      const markerDriven = settings !== null;
      // Where an extension's status line records what the tab's agent reports.
      const usageFile = settings ? res.usageCapture(launch) : null;
      const env: Record<string, string> = usageFile ? { [USAGE_FILE_ENV]: usageFile } : {};
      if (!plan) return { command: withHooks, env, markerDriven };
      return {
        command: withClaudeSession(withHooks, plan.sessionId, plan.exists),
        // Tells the SessionStart hook where to keep this tab's record current.
        env: { ...env, [SESSION_RECORD_ENV]: plan.recordPath },
        markerDriven,
      };
    },
  },
];

/**
 * Inject status-marker hooks into a session's startup command (see
 * AGENT_ADAPTERS). `markerDriven` says whether the launched program will emit
 * markers - the renderer skips its output/quiet heuristics for such a terminal
 * from the start (`terminal:markerDriven`).
 */
export function augmentAgentCommand(
  command: string,
  launch: AgentLaunch,
  res: LaunchResources,
  platform: NodeJS.Platform,
): ComposedLaunch {
  if (platform === 'win32') return windowsAgentLaunch(command, launch, res);
  const adapter = AGENT_ADAPTERS.find((a) => a.match.test(command));
  if (!adapter) return wrapperLaunch(command, launch, res);
  const injected = adapter.inject(command, launch, res);
  const markerDriven = injected.markerDriven === true;
  if (injected.command === command && Object.keys(injected.env ?? {}).length === 0) {
    return { command, markerDriven };
  }
  // Agent hook processes have NO controlling terminal, so the hook script can't
  // reach the session pty via /dev/tty (verified: the open fails). The launch
  // shell DOES own the pty - capture its device path into DOUBLE0_TTY here, at
  // the prompt, so every hook inherits it and the script can write markers
  // straight to the session's terminal stream. Adapter-supplied variables ride
  // along the same way (single-quoted: userData paths contain spaces).
  const extra = Object.entries(injected.env ?? {})
    .map(([name, value]) => ` ${name}=${shellQuote(value)}`)
    .join('');
  return { command: `DOUBLE0_TTY="$(tty)"${extra} ${injected.command}`, markerDriven };
}

/**
 * Windows: a plain `claude …` gets the status hooks, and an extension's status
 * line when it has one (claude-status-hooks.ts › Windows). The hooks' markers go to the pty's
 * marker folder, which the host reads (marker-inbox.ts); the SessionStart
 * hook records the tab's conversation and transcript, which a following view
 * reads - the launch is not pinned to it, as it is
 * elsewhere. Everything rides in the pty's env, which the command line of
 * cmd.exe / PowerShell hands on. Not marker-driven until the stream shows a
 * marker: a hook that cannot run must leave the tab on the fallback. Every
 * other command runs verbatim, as before.
 */
export function windowsAgentLaunch(
  command: string,
  launch: AgentLaunch,
  res: LaunchResources,
): ComposedLaunch {
  if (!CLAUDE_COMMAND.test(command) || !res.hasGitBash()) {
    return { command, markerDriven: false };
  }
  const settings = res.claudeWindowsSettings();
  const markerDir = settings ? res.windowsMarkerDir(launch.ptyId) : null;
  if (!settings || !markerDir) return { command, markerDriven: false };
  const env: Record<string, string> = { [MARKER_DIR_ENV]: markerDir };
  // The status line's capture, when the settings carry one.
  const usageFile = res.usageCapture(launch);
  if (usageFile) env[USAGE_FILE_ENV] = usageFile;
  // No record: a view cannot follow this tab, the rest works.
  const record = res.windowsSessionRecord(launch.ptyId);
  if (record) env[SESSION_RECORD_ENV] = record;
  return { command: windowsClaudeCommand(command, settings), markerDriven: false, env };
}

/**
 * A start command no adapter recognises - `codex`, `opencode`, a shell alias
 * (the user's `claude-personal`), a function, a wrapper script, a compound
 * command. Whichever agent it reaches by name gets its status injection and
 * its tab's conversation: the line exports the env every agent's injection
 * reads and runs the command with the PATH shims first (claude-shim.ts has
 * the story). Not marker-driven as far as main knows at spawn - the stream
 * tells (TerminalModeTracker.markerDriven) once the first marker arrives,
 * which for Codex is only after the user has trusted the hooks once
 * (codex-status-hooks.ts) and for OpenCode only if its plugin loaded (no
 * `--pure`): claiming it up front would freeze a tab the markers never reach.
 */
export function wrapperLaunch(
  command: string,
  launch: AgentLaunch,
  res: LaunchResources,
): ComposedLaunch {
  // The line below is POSIX sh; another launch shell runs the command verbatim.
  if (!launchesPosixShell(res.shell)) return { command, markerDriven: false };
  const settings = res.claudeSettings();
  const shimDir = res.shimDir();
  if (!settings || !shimDir) return { command, markerDriven: false };
  const plan = res.claudeSession(launch);
  return {
    command: wrapperLaunchCommand(command, {
      shimDir,
      settingsPath: settings,
      // resume-vs-new is the shim's call: it knows the wrapper's config dir.
      plan: plan && { sessionId: plan.sessionId, recordPath: plan.recordPath },
      // Written by an extension's Claude status line or the `codex` shim,
      // whichever the wrapper reaches - both name the config dir it chose.
      usageFile: res.usageCapture(launch),
      codexHooksPath: res.codexHooks(),
      opencodePluginPath: res.opencodePlugin(),
      opencodePlan: res.opencodeSession(launch.ptyId),
      codexRecordPath: res.codexRecord(launch.ptyId),
    }),
    markerDriven: false,
  };
}
