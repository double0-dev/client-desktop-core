import {
  CODEX_SESSION_RECORD_ENV,
  OPENCODE_SESSION_RECORD_ENV,
  SESSION_RECORD_ENV,
  shellQuote,
} from './agent-resume';
import { AGENT_NAME_ENV, STATUS_OWNER_ENV, USAGE_FILE_ENV } from './claude-status-hooks';
import { CODEX_SHIM_HOOKS_ENV } from './codex-status-hooks';
import {
  OPENCODE_CONFIG_ENV,
  OPENCODE_SUBCOMMANDS,
  opencodeConfigContent,
  opencodeConfigExport,
} from './opencode-status-plugin';

/**
 * The `claude` PATH shim - how a Claude launched THROUGH something else gets
 * the status hooks.
 *
 * The Claude adapter (AGENT_ADAPTERS in launch-plan.ts) rewrites a start command
 * whose first word is `claude`. It cannot see through a shell alias, a
 * function or a wrapper script: `alias claude-personal='CLAUDE_CONFIG_DIR=…
 * claude'` reaches it as the opaque word `claude-personal`, and the agent ran
 * with no hooks at all. Without hooks the renderer is in its output/quiet
 * fallback, and an idle Claude Code is never quiet for long - its status
 * line, notices and the 60 s idle bell repaint the whole screen every
 * 30-60 s (measured 2026-09-19: 3-11 KB bursts at +28 s, +124 s, +182 s after
 * the last Stop). Each burst read as "running", each 8 s pause as
 * "finished" plus a notification, and opening the session (a focus report,
 * a refit) started the next burst: the running → finished → running loop.
 *
 * So every start command the adapter does NOT recognise runs with this shim
 * first on PATH (`wrapperLaunchCommand`). Whatever the wrapper does, the
 * moment it invokes `claude` BY NAME the shim runs instead: it finds the real
 * binary further down PATH and execs it with `--settings <our hooks>` and the
 * tab's own conversation pinned - `--resume` when its transcript exists under
 * the config dir THE WRAPPER CHOSE (`CLAUDE_CONFIG_DIR`), else `--session-id`
 * - the same launch a plain `claude` start command gets. It reads:
 *   DOUBLE0_CLAUDE_HOOKS    the settings file to inject; unset = passthrough
 *   DOUBLE0_CLAUDE_SESSION  the uuid to pin (agent-resume.ts); unset = no pin
 * and leaves the argv alone for anything that is not an interactive session:
 * print mode (a script's `claude -p …` must neither flip the tab's status
 * nor move its session record), `--version` / `--help`, the subcommands
 * (`claude mcp …`). A wrapper that calls the binary by an absolute path
 * bypasses the shim and stays in the fallback, as before.
 *
 * Every shell double0 starts carries the shims too, hooks only (`shellAgentEnv`,
 * 2026-11-02): a `claude`, `codex` or `opencode` typed at a plain shell's
 * prompt reports its status the same way, starting its own conversation.
 *
 * Main cannot know at spawn time whether a wrapper will reach `claude`, so it
 * reports such a terminal as marker-driven only once the stream has shown a
 * marker (TerminalModeTracker.markerDriven); in the renderer the first marker
 * arms marker mode as it always did.
 *
 * Only the top-level agent of a tab reports. The agent's own tool shell
 * inherits everything the launch line exported - the pty device, the hook
 * files, the inline OpenCode config and this folder on PATH - so a `claude`,
 * `codex` or `opencode` an agent runs by name INSIDE its tool would reach
 * these shims (or OpenCode's plugin) again and write its own `ready` /
 * `running` / `ended` into the parent tab's pty. So each shim, the moment it
 * injects, exports DOUBLE0_STATUS_OWNER (claude-status-hooks.ts) into the
 * real binary's environment, which its tool shells inherit; and every shim
 * checks that variable FIRST - set, the binary runs plain: no hooks, no pin,
 * no status line capture. The OpenCode plugin does both halves for its CLI. The
 * variable is set in the shim's process (exec'd into the agent), never on the
 * launch line, so it dies with the agent and a `claude` typed in the tab's
 * shell afterwards reports again.
 */

/** Folder under the OS temp dir holding the shims (`claude`, `codex` and `opencode` - see CODEX_SHIM_SCRIPT, OPENCODE_SHIM_SCRIPT). */
export const CLAUDE_SHIM_DIR_NAME = 'double0-claude-shim';
/**
 * Env var naming the shims' folder in every shell double0 starts
 * (`shellAgentEnv`): our zsh / bash rc moves it back to the front of PATH
 * after the user's own files (`SHIM_PATH_SNIPPET`).
 */
export const SHIM_DIR_ENV = 'DOUBLE0_SHIM_DIR';
/** Env var naming the tab's pty device, which the hooks write their markers to. */
export const TTY_ENV = 'DOUBLE0_TTY';

/**
 * The shims' half of `DOUBLE0_TTY`. A launch line exports the device it ran
 * on; an agent typed at a plain shell's prompt has no such line, but the shim
 * runs in the foreground on the tab's pty, so its stdin IS that device - the
 * hook processes the agent spawns have no controlling terminal and could not
 * find it themselves. A value already set is kept (the launch line's).
 */
const TTY_CAPTURE = `if [ -z "\${${TTY_ENV}:-}" ] && tty_dev=$(tty 2>/dev/null); then
  ${TTY_ENV}=$tty_dev
  export ${TTY_ENV}
fi`;
/** Env var naming the OpenCode session the `opencode` shim continues (agent-resume.ts); unset = no pin. */
export const OPENCODE_SHIM_SESSION_ENV = 'DOUBLE0_OPENCODE_SESSION';
/** Env var naming the hook settings file the shim injects. */
export const CLAUDE_SHIM_HOOKS_ENV = 'DOUBLE0_CLAUDE_HOOKS';
/** Env var naming the conversation uuid the shim pins the launch to. */
export const CLAUDE_SHIM_SESSION_ENV = 'DOUBLE0_CLAUDE_SESSION';

/**
 * The subcommands of 2.1.278's `claude --help`: a launch whose first word is
 * one of them is not an interactive session, and `--settings` or a pin put
 * ahead of it turns `claude logs x` into one with a stray prompt. Re-check
 * the list on a CLI update.
 */
export const CLAUDE_SUBCOMMANDS = [
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
  'migrate-installer',
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
] as const;

/**
 * The shim itself. POSIX sh only - `$0` is the path the shell found it under,
 * so its own PATH entry is skipped when looking for the real binary. The
 * transcript check mirrors `claudeTranscriptExists` (any project folder, the
 * id is a random uuid) against the config dir the wrapper's environment names.
 */
export const CLAUDE_SHIM_SCRIPT = `#!/bin/sh
# double0: a \`claude\` reached through an alias, a function or a wrapper script
# gets the session status hooks and its tab's conversation, like a plain
# \`claude\` start command does (see src/main/claude-shim.ts).
self=$(dirname "$0")
real=''
old_ifs=$IFS
IFS=:
for dir in $PATH; do
  [ -n "$dir" ] && [ "$dir" != "$self" ] || continue
  if [ -f "$dir/claude" ] && [ -x "$dir/claude" ]; then
    real="$dir/claude"
    break
  fi
done
IFS=$old_ifs
if [ -z "$real" ]; then
  printf 'claude: command not found\\n' >&2
  exit 127
fi
# Under the tab's reporting agent (its tool ran this): plain, no hooks, no pin.
[ -z "\${${STATUS_OWNER_ENV}:-}" ] || exec "$real" "$@"
hooks="\${${CLAUDE_SHIM_HOOKS_ENV}:-}"
if [ -z "$hooks" ] || [ ! -r "$hooks" ]; then
  exec "$real" "$@"
fi
${TTY_CAPTURE}
# Already hooked: a plain \`claude\` start command's own line names the file.
# Never twice - but it is the tab's reporting agent all the same.
for arg in "$@"; do
  if [ "$arg" = "$hooks" ]; then
    ${STATUS_OWNER_ENV}=claude
    export ${STATUS_OWNER_ENV}
    exec "$real" "$@"
  fi
done
case "\${1:-}" in
  ${CLAUDE_SUBCOMMANDS.join('|')}) exec "$real" "$@" ;;
esac
pin="\${${CLAUDE_SHIM_SESSION_ENV}:-}"
for arg in "$@"; do
  case "\${arg%%=*}" in
    -p|--print|-v|--version|-h|--help) exec "$real" "$@" ;;
    -r|--resume|-c|--continue|--session-id|--fork-session|--cloud) pin='' ;;
  esac
done
if [ -n "$pin" ]; then
  flag=--session-id
  for f in "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$pin".jsonl; do
    if [ -e "$f" ]; then
      flag=--resume
      break
    fi
  done
  set -- "$flag" "$pin" "$@"
fi
${STATUS_OWNER_ENV}=claude
export ${STATUS_OWNER_ENV}
exec "$real" --settings "$hooks" "$@"
`;

/**
 * The `codex` shim, in the same folder - the Codex adapter's whole launch
 * side. It records which Codex account the tab runs - its `CODEX_HOME`,
 * empty when unset (the default `~/.codex`) - in the pty's status line
 * capture file when one is named (DOUBLE0_USAGE_FILE), then execs the real binary with the status hooks injected: one
 * `-c hooks.<Event>=…` override per line of the file $DOUBLE0_CODEX_HOOKS
 * names (codex-status-hooks.ts writes it; unset = none), ahead of the user's
 * own argv, plus `DOUBLE0_AGENT=codex` so the shared hook script knows whose
 * prompts it files. Only an interactive session gets them: `exec`, `login`,
 * `mcp`, the other subcommands of 0.160.0's `codex --help`, `--version` and
 * `--help` pass through untouched; `resume` and `fork` are interactive and
 * take the flags ahead of the subcommand (verified). The capture carries the
 * shim's own pid (`$$` is the invoked shell's, even inside the subshell):
 * after the exec it is the CLI's, so the capture's reader can tell when it
 * has exited. A `codex` start command is not an
 * adapter match, so it always launches with this folder first on PATH
 * (`wrapperLaunchCommand`) - and so does a wrapper alias that sets CODEX_HOME
 * before calling `codex` by name, which is exactly the case where the tab's
 * account cannot be read off the start command. Main reports such a pty as
 * marker-driven only once the stream shows a marker: Codex runs the hooks
 * only after the user has trusted them once (`/hooks`), see
 * codex-status-hooks.ts.
 */
export const CODEX_SHIM_SCRIPT = `#!/bin/sh
# double0: notes which Codex home this tab's \`codex\` runs under (the
# status line capture) and injects the session status hooks, then runs the real CLI
# (see src/main/claude-shim.ts).
self=$(dirname "$0")
real=''
old_ifs=$IFS
IFS=:
for dir in $PATH; do
  [ -n "$dir" ] && [ "$dir" != "$self" ] || continue
  if [ -f "$dir/codex" ] && [ -x "$dir/codex" ]; then
    real="$dir/codex"
    break
  fi
done
IFS=$old_ifs
if [ -z "$real" ]; then
  printf 'codex: command not found\\n' >&2
  exit 127
fi
# Under the tab's reporting agent (its tool ran this): plain, and never the
# tab's account.
[ -z "\${${STATUS_OWNER_ENV}:-}" ] || exec "$real" "$@"
file="\${${USAGE_FILE_ENV}:-}"
if [ -n "$file" ]; then
  ( printf 'double0-usage 1\\ncodex\\n%s\\n%s\\n%s\\n' "\${CODEX_HOME:-}" "$PWD" "$$" > "$file.tmp" && mv -f "$file.tmp" "$file" ) 2>/dev/null
fi
hooks="\${${CODEX_SHIM_HOOKS_ENV}:-}"
if [ -z "$hooks" ] || [ ! -r "$hooks" ]; then
  exec "$real" "$@"
fi
case "\${1:-}" in
  agents|exec|e|review|login|logout|mcp|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|a|queue|archive|delete|migrate-rollouts|unarchive|cloud|exec-server|features|help) exec "$real" "$@" ;;
esac
for arg in "$@"; do
  case "\${arg%%=*}" in
    -V|--version|-h|--help) exec "$real" "$@" ;;
  esac
done
${TTY_CAPTURE}
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] && set -- -c "$line" "$@"
done < "$hooks"
${AGENT_NAME_ENV}=codex
${STATUS_OWNER_ENV}=codex
export ${AGENT_NAME_ENV} ${STATUS_OWNER_ENV}
exec "$real" "$@"
`;

/**
 * The `opencode` shim, in the same folder: continues the tab's own OpenCode
 * conversation. OpenCode's status plugin needs no shim - the env var that
 * loads it reaches an `opencode` however it is launched (opencode-status-
 * plugin.ts) - but `-s <id>` has to land on the real binary's argv, so a
 * wrapper alias gets it here, like a `claude` behind an alias gets its pin.
 * The id comes from $DOUBLE0_OPENCODE_SESSION (the tab's record, agent-
 * resume.ts; unset = no pin) and is added only to an interactive launch
 * that pins nothing itself (`-c`, `-s`, `--fork`): `run`, `serve`, `attach`
 * and the other subcommands of 1.17.20's `opencode --help` pass through, so
 * do `--version` / `--help`. A session OpenCode no longer has makes it EXIT
 * ("Session not found", verified on 1.17.20), so the id is pinned only after
 * `sqlite3` finds it in OpenCode's database (its sessions live nowhere
 * else); without `sqlite3`, or with the database elsewhere, the tab starts
 * a fresh conversation rather than none.
 */
export const OPENCODE_SHIM_SCRIPT = `#!/bin/sh
# double0: an \`opencode\` reached by name continues its tab's conversation
# (see src/main/claude-shim.ts).
self=$(dirname "$0")
real=''
old_ifs=$IFS
IFS=:
for dir in $PATH; do
  [ -n "$dir" ] && [ "$dir" != "$self" ] || continue
  if [ -f "$dir/opencode" ] && [ -x "$dir/opencode" ]; then
    real="$dir/opencode"
    break
  fi
done
IFS=$old_ifs
if [ -z "$real" ]; then
  printf 'opencode: command not found\\n' >&2
  exit 127
fi
# Under the tab's reporting agent (its tool ran this): never the tab's
# conversation (its plugin stays silent on its own).
[ -z "\${${STATUS_OWNER_ENV}:-}" ] || exec "$real" "$@"
# The status plugin writes to the tab's pty, pinned or not.
${TTY_CAPTURE}
pin="\${${OPENCODE_SHIM_SESSION_ENV}:-}"
[ -n "$pin" ] || exec "$real" "$@"
case "$pin" in
  *[!A-Za-z0-9_]*) exec "$real" "$@" ;;
esac
case "\${1:-}" in
  ${OPENCODE_SUBCOMMANDS.join('|')}) exec "$real" "$@" ;;
esac
for arg in "$@"; do
  case "\${arg%%=*}" in
    -v|--version|-h|--help|-c|--continue|-s|--session|--fork) exec "$real" "$@" ;;
  esac
done
db="\${OPENCODE_DB:-\${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db}"
command -v sqlite3 >/dev/null 2>&1 && [ -r "$db" ] || exec "$real" "$@"
found=$(sqlite3 -readonly "$db" "select 1 from session where id = '$pin' limit 1" 2>/dev/null)
[ "$found" = 1 ] || exec "$real" "$@"
exec "$real" -s "$pin" "$@"
`;

/**
 * Shells whose `-c` line takes the POSIX `export NAME=VALUE …; cmd; unset …`
 * that `wrapperLaunchCommand` builds. The launch shell is the user's `$SHELL`:
 * under csh/tcsh (`setenv`), fish (no `unset`), nu, xonsh, elvish or
 * PowerShell the line fails to parse - and a start or worktree setup command
 * that ran verbatim before would not run at all. Those launch verbatim, as
 * before the shim existed. A login-shell name (`-zsh`) counts as its shell.
 */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash']);

export function launchesPosixShell(shell: string): boolean {
  const name = shell.split(/[\\/]/).pop()?.replace(/^-/, '') ?? '';
  return POSIX_SHELLS.has(name);
}

export type WrapperLaunch = {
  /** The folder holding the shim `claude` - put first on PATH. */
  shimDir: string;
  /** The hook settings file the shim injects. */
  settingsPath: string;
  /**
   * The tab's conversation to pin and the record file its SessionStart hook
   * keeps current (agent-resume.ts) - null for a pty with no restart-stable
   * uuid, which launches unpinned.
   */
  plan: { sessionId: string; recordPath: string } | null;
  /**
   * The pty's status line capture file (launch-materialize.ts ›
   * AgentStatusLine) - written by an extension's status line and by the
   * `codex` shim. Stays set after the command, unlike the pin: a `claude` or
   * `codex` typed in the tab later still reports its config dir.
   */
  usageFile?: string | null;
  /**
   * The Codex hook override file the `codex` shim injects (codex-status-
   * hooks.ts); kept after the command like the Claude hooks. Absent = none.
   */
  codexHooksPath?: string | null;
  /**
   * The OpenCode status plugin file (opencode-status-plugin.ts), loaded
   * through the inline config the line exports unless the user has one of
   * their own; kept after the command. Absent = none.
   */
  opencodePluginPath?: string | null;
  /**
   * The tab's OpenCode conversation: the session to continue (null = none
   * recorded yet) and the record file the plugin keeps current - both unset
   * once the command returns, like the Claude pin. Absent for a pty with no
   * restart-stable uuid.
   */
  opencodePlan?: { sessionId: string | null; recordPath: string } | null;
  /**
   * The tab's Codex record file (agent-resume.ts), which the SessionStart hook
   * keeps for a following view - unset once the command returns, like the other
   * records. Absent for a pty with no restart-stable uuid.
   */
  codexRecordPath?: string | null;
};

/**
 * The launch line (sourced by the tab's shell, startup-typer.ts) for a start command the adapter did not recognise:
 * the shim's folder first on PATH, the pty device the hook script writes to,
 * and the session env - EXPORTED, not prefixed to one simple command, so a
 * compound `cd x && claude-personal` and whatever the wrapper spawns inherit
 * them. The hooks outlive the command into the tab's interactive shell (a
 * `claude`, `codex` or `opencode` typed there later reports its status too,
 * PATH order permitting); the pins and the record files do not - they are
 * unset once the command returns, so that a later `claude` / `opencode`
 * starts its own conversation instead of silently resuming the tab's, the
 * same as after a plain `claude` start command. Every agent's env rides on
 * every such launch: the line cannot know which CLI an alias reaches, and
 * each variable is read by its own CLI only.
 */
export function wrapperLaunchCommand(command: string, launch: WrapperLaunch): string {
  const env: Array<[string, string]> = [
    [TTY_ENV, '"$(tty)"'],
    ['PATH', `${shellQuote(launch.shimDir)}:"$PATH"`],
    [CLAUDE_SHIM_HOOKS_ENV, shellQuote(launch.settingsPath)],
  ];
  if (launch.usageFile) env.push([USAGE_FILE_ENV, shellQuote(launch.usageFile)]);
  if (launch.codexHooksPath) env.push([CODEX_SHIM_HOOKS_ENV, shellQuote(launch.codexHooksPath)]);
  const transient: string[] = [];
  if (launch.plan) {
    env.push([CLAUDE_SHIM_SESSION_ENV, shellQuote(launch.plan.sessionId)]);
    env.push([SESSION_RECORD_ENV, shellQuote(launch.plan.recordPath)]);
    transient.push(CLAUDE_SHIM_SESSION_ENV, SESSION_RECORD_ENV);
  }
  if (launch.codexRecordPath) {
    env.push([CODEX_SESSION_RECORD_ENV, shellQuote(launch.codexRecordPath)]);
    transient.push(CODEX_SESSION_RECORD_ENV);
  }
  if (launch.opencodePlan) {
    if (launch.opencodePlan.sessionId) {
      env.push([OPENCODE_SHIM_SESSION_ENV, shellQuote(launch.opencodePlan.sessionId)]);
      transient.push(OPENCODE_SHIM_SESSION_ENV);
    }
    env.push([OPENCODE_SESSION_RECORD_ENV, shellQuote(launch.opencodePlan.recordPath)]);
    transient.push(OPENCODE_SESSION_RECORD_ENV);
  }
  const exports = `export ${env.map(([name, value]) => `${name}=${value}`).join(' ')}`;
  const plugin = launch.opencodePluginPath
    ? `; ${opencodeConfigExport(launch.opencodePluginPath)}`
    : '';
  const line = `${exports}${plugin}; ${command}`;
  // A newline, not `;`: a start command ending in a `# comment` would
  // swallow the unset (review, 2026-10-06).
  return transient.length > 0 ? `${line}\nunset ${transient.join(' ')}` : line;
}

export type ShellAgentEnv = {
  /** The folder holding the shims. */
  shimDir: string;
  /** The hook settings file the `claude` shim injects. */
  settingsPath: string;
  /** The pty's status line capture file - absent = none. */
  usageFile?: string | null;
  /** The Codex hook override file the `codex` shim injects - absent = none. */
  codexHooksPath?: string | null;
  /** The OpenCode status plugin - absent = none. */
  opencodePluginPath?: string | null;
};

/**
 * What every shell double0 starts carries for an agent typed at its prompt -
 * a plain Terminal session, a "+" tab, the shell left behind by a start
 * command: the variables the `claude` / `codex` shims and the OpenCode plugin
 * read, the same hooks a start command gets (the PATH half - the shims'
 * folder first - is the caller's). Hooks only: never a pin or a record, so a
 * `claude` typed twice starts two conversations, as it does in any terminal.
 * Without it such an agent ran with no hooks, and the renderer read its
 * repaints and its idle bell as work and as a wait (2026-11-02). A user's own
 * `OPENCODE_CONFIG_CONTENT` (`inherited`) stays theirs, as on a launch line.
 */
export function shellAgentEnv(
  launch: ShellAgentEnv,
  inherited: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {
    [SHIM_DIR_ENV]: launch.shimDir,
    [CLAUDE_SHIM_HOOKS_ENV]: launch.settingsPath,
  };
  if (launch.usageFile) env[USAGE_FILE_ENV] = launch.usageFile;
  if (launch.codexHooksPath) env[CODEX_SHIM_HOOKS_ENV] = launch.codexHooksPath;
  if (launch.opencodePluginPath && !inherited[OPENCODE_CONFIG_ENV]) {
    env[OPENCODE_CONFIG_ENV] = opencodeConfigContent(launch.opencodePluginPath);
  }
  return env;
}

/**
 * Run by double0's own zsh / bash rc AFTER the user's files: puts the shims'
 * folder (`SHIM_DIR_ENV`) back in front of PATH, where an rc that prepends
 * its own folder (`~/bin`, a version manager) had pushed it behind a `claude`
 * of its own. POSIX sh, silent, a no-op without the variable or when the
 * folder already leads.
 */
export const SHIM_PATH_SNIPPET = [
  `if [ -n "\${${SHIM_DIR_ENV}:-}" ] && [ -d "$${SHIM_DIR_ENV}" ]; then`,
  `  case "$PATH" in "$${SHIM_DIR_ENV}"|"$${SHIM_DIR_ENV}":*) ;; *) PATH="$${SHIM_DIR_ENV}\${PATH:+:$PATH}" ;; esac`,
  'fi',
].join('\n');

/**
 * Windows has no shims (no `/bin/sh` to run them, and cmd.exe would ask
 * "Terminate batch job?" around a `claude.cmd` on PATH). A `claude` typed
 * into a plain cmd.exe or PowerShell tab gets the hooks where the shell
 * reads a typed command instead: cmd.exe through a doskey macro calling
 * `WINDOWS_CLAUDE_HELPER` (named apart from `claude`, off PATH - no
 * recursion), PowerShell through a `claude` function. Both pass through what
 * the sh shim passes through, plus an argv that names its own `--settings`;
 * the markers go to the pty's marker folder as a `claude` start command's do
 * (claude-status-hooks.ts › Windows). Unit-tested only: never run on Windows.
 */
export const SHELL_SETUP_ENV = 'DOUBLE0_SHELL_SETUP';

/** Launches that are not an interactive session, or bring their own settings. */
const CLAUDE_PLAIN_FLAGS = ['-p', '--print', '-v', '--version', '-h', '--help', '--settings'];

/** The file name of the cmd.exe helper, in the agent files folder. */
export const WINDOWS_CLAUDE_HELPER_NAME = 'double0-claude.cmd';

/**
 * The cmd.exe helper the doskey macro calls. `for` splits `%*` on `=` too, so
 * `--print=x` is caught as `--print`. CRLF: cmd.exe misreads labels in a file
 * with bare LF line ends.
 */
export const WINDOWS_CLAUDE_HELPER = [
  '@echo off',
  'rem double0: a claude typed at this cmd.exe prompt gets the session status',
  'rem hooks, like a claude start command (src/main/claude-shim.ts).',
  'setlocal',
  `if not defined ${CLAUDE_SHIM_HOOKS_ENV} goto plain`,
  `if not exist "%${CLAUDE_SHIM_HOOKS_ENV}%" goto plain`,
  `for %%S in (${CLAUDE_SUBCOMMANDS.join(' ')}) do if /i "%~1"=="%%S" goto plain`,
  'for %%A in (%*) do (',
  ...CLAUDE_PLAIN_FLAGS.map((flag) => `  if /i "%%~A"=="${flag}" goto plain`),
  ')',
  `endlocal & claude --settings "%${CLAUDE_SHIM_HOOKS_ENV}%" %*`,
  'goto :eof',
  ':plain',
  'endlocal & claude %*',
  '',
].join('\r\n');

/** The PowerShell `claude` function: the helper's rules, natively. */
export const POWERSHELL_CLAUDE_FUNCTION = [
  'function global:claude {',
  '  $real = Get-Command -Name claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
  "  if (-not $real) { Write-Error 'claude: command not found'; return }",
  `  $hooks = $env:${CLAUDE_SHIM_HOOKS_ENV}`,
  `  $plain = (-not $hooks) -or (-not (Test-Path -LiteralPath $hooks)) -or ($args.Count -gt 0 -and @(${CLAUDE_SUBCOMMANDS.map((s) => `'${s}'`).join(', ')}) -contains "$($args[0])")`,
  `  foreach ($a in $args) { if (@(${CLAUDE_PLAIN_FLAGS.map((f) => `'${f}'`).join(', ')}) -contains ("$a" -replace '=.*$', '')) { $plain = $true } }`,
  '  if ($plain) { & $real @args } else { & $real --settings $hooks @args }',
  '}',
].join('\n');

/**
 * How a plain cmd.exe or PowerShell tab is started so that a `claude` typed
 * at its prompt gets the hooks: the setup rides in `SHELL_SETUP_ENV` and runs
 * from the shell's own command line (never typed - its echo would stay on
 * screen, startup-typer.ts › windowsLaunch). Null for any other shell.
 */
export function windowsShellSetup(
  shell: string,
  helperPath: string,
): { args: string[]; env: Record<string, string> } | null {
  const name =
    shell
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, '') ?? '';
  if (name === 'cmd') {
    return {
      args: ['/K', `%${SHELL_SETUP_ENV}%`],
      env: { [SHELL_SETUP_ENV]: `doskey claude="${helperPath}" $*` },
    };
  }
  if (name === 'powershell' || name === 'pwsh') {
    return {
      args: ['-NoExit', '-Command', `Invoke-Expression $env:${SHELL_SETUP_ENV}`],
      env: { [SHELL_SETUP_ENV]: POWERSHELL_CLAUDE_FUNCTION },
    };
  }
  return null;
}
