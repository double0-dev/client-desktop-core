/**
 * Shell integration: the few lines that make a shell report each command it
 * runs, for the status bar's Inputs list (terminal-inputs.ts,
 * a private plan). Pure - launch-materialize.ts writes the files to disk
 * once and applies `zshIntegration` at the single spawn site.
 *
 * zsh, and bash on Linux (see `bashIntegration` below - most Linux users run it,
 * and without it file links, the Inputs list and the launch timing all fell
 * back to guesses, 2026-10-29). zsh reads its startup files from $ZDOTDIR, so a pty gets
 * ZDOTDIR pointed at a folder of ours whose files each run the user's own
 * file with THEIR ZDOTDIR in place (a compinit dump, a plugin manager's
 * cache, anything keyed off $ZDOTDIR lands where it always did) and point it
 * back to ours, so zsh keeps reading from here. The last one, .zshrc, leaves
 * ZDOTDIR as the user's shell would have it (unset when they had none) and
 * adds two hooks:
 *
 * - precmd, before every prompt: `cwd;<base64 of $PWD>` when the folder
 *   changed (file links resolve against it - a `cd` must not send them to
 *   the tab's starting folder), `done;<exit status>` when a command ran,
 *   then `ps` - where the command about to be typed starts on screen;
 * - preexec, when a command starts: `cmd;<base64 of the command line>`.
 *
 * A system zshrc read before ours may have derived the history file from
 * $ZDOTDIR (macOS: `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history`) - our folder
 * at that point, so the tab neither saw the user's history nor added to it
 * (2026-10-12). .zshrc points it at the user's folder before their own file
 * runs; zsh reads history only after the startup files.
 *
 * The first precmd also runs the tab's launch script (startup-typer.ts) when
 * there is one, sourced (its `launch` mark tells main not to type the line as
 * well) - the start command runs in this shell with its
 * aliases and functions, before any prompt is drawn and with nothing echoed.
 * It first takes the script by renaming it - main types the line only when IT
 * wins that rename (startup-typer.ts › claimLaunchScript), so the command
 * never runs here AND arrives typed in the program it started. The script
 * removes itself and its variable, so it happens once.
 *
 * The line that sources a tab's launch script (when it IS typed: the hooks
 * were dropped, another shell) is ours, not
 * the user's: it is never reported, and zshaddhistory keeps it out of the
 * history (up-arrow would find a script that deleted itself).
 *
 * zsh hands every precmd function the command's own `$?` (probed on 5.9: a
 * hook that runs after one ending in `true` still reads the command's
 * status), so the hooks are appended, never forced first. Both write with the
 * builtin printf to the terminal and fork only for base64. Output is an OSC
 * (6791) xterm ignores; nothing else changes. Other shells (fish, sh, ...) run
 * as before - the renderer reads their command lines off the screen instead.
 *
 * `-o interactive` guards the hooks: a `zsh -c` script that inherits our
 * ZDOTDIR must not print marks.
 */

import { INPUT_OSC } from './claude-status-hooks';
import { LAUNCH_ENV, LAUNCH_LINE, LAUNCH_SOURCED_SUFFIX } from './startup-typer';
import { AGENT_BINS_SNIPPET } from './agent-bins';
import { SHIM_PATH_SNIPPET } from './claude-shim';

/** Folder (under the OS temp dir) holding the integration files. */
export const SHELL_INTEGRATION_DIR_NAME = 'double0-shell-integration';

/**
 * The zsh files' folder inside it. The temp folder is shared by every build
 * running on the machine (the installed app beside `pnpm dev`), and these
 * files are one half of a contract with the build's own host: the build that
 * began sourcing the launch script from precmd overwrote the folder the
 * installed app's shells read, whose host still typed the line - into the
 * agent (2026-10-12). Bump the number whenever what the files do and what
 * pty-host.ts / startup-typer.ts expect change together. 3: the rc puts the
 * agent shims back in front of PATH, a folder the spawn names (2026-11-02).
 */
export const ZSH_INTEGRATION_FOLDER = 'zsh-3';

/** The user's own ZDOTDIR when they have one - their startup files live there. */
export const USER_ZDOTDIR_ENV = 'DOUBLE0_USER_ZDOTDIR';

/** Characters of a command line the preexec hook forwards. */
const COMMAND_CHARS = 2000;

const HEADER = `# double0 shell integration - reports each command for the Inputs list.
# Runs your own startup file with your ZDOTDIR in place, then points zsh back
# here for the next one (a private plan in the double0 repo).`;

/** Run the user's startup file `name` with their ZDOTDIR, then come back. */
const chain = (name: string): string => `${HEADER}
__double0_zdotdir=$ZDOTDIR
ZDOTDIR=\${${USER_ZDOTDIR_ENV}:-$HOME}
if [[ -f $ZDOTDIR/${name} ]]; then
  builtin source $ZDOTDIR/${name}
fi
if [[ $ZDOTDIR != \${${USER_ZDOTDIR_ENV}:-$HOME} ]]; then
  export ${USER_ZDOTDIR_ENV}=$ZDOTDIR
fi
ZDOTDIR=$__double0_zdotdir
unset __double0_zdotdir
`;

/** `value` single-quoted for zsh (`'` → `'\\''`). */
function zshQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ZSHRC = `${HEADER}
if [[ \${HISTFILE:-} == $ZDOTDIR/* ]]; then
  HISTFILE=\${${USER_ZDOTDIR_ENV}:-$HOME}/\${HISTFILE:t}
fi
ZDOTDIR=\${${USER_ZDOTDIR_ENV}:-$HOME}
if [[ -f $ZDOTDIR/.zshrc ]]; then
  builtin source $ZDOTDIR/.zshrc
fi
if [[ -z \${${USER_ZDOTDIR_ENV}:-} && $ZDOTDIR == $HOME ]]; then
  unset ZDOTDIR
fi
# The agent CLIs' install folders, after the user's files (agent-bins.ts),
# and the agent shims back in front of them all (claude-shim.ts).
${AGENT_BINS_SNIPPET}
${SHIM_PATH_SNIPPET}
if [[ -o interactive && -z \${__double0_hooks:-} ]]; then
  __double0_hooks=1
  typeset -g __double0_launch=${zshQuote(LAUNCH_LINE.trim())}
  typeset -g __double0_ran=
  typeset -g __double0_pwd=
  __double0_precmd() {
    local ec=$?
    if [[ $PWD != $__double0_pwd ]]; then
      __double0_pwd=$PWD
      builtin printf '\\033]${INPUT_OSC};cwd;%s\\007' "$(builtin printf '%s' "$PWD" | command base64 | command tr -d '\\n')"
    fi
    if [[ -n \${${LAUNCH_ENV}:-} && -e \${${LAUNCH_ENV}:-} ]] &&
      command mv -- "$${LAUNCH_ENV}" "$${LAUNCH_ENV}${LAUNCH_SOURCED_SUFFIX}" 2>/dev/null; then
      builtin source "$${LAUNCH_ENV}${LAUNCH_SOURCED_SUFFIX}"
    fi
    if [[ -n $__double0_ran ]]; then
      builtin printf '\\033]${INPUT_OSC};done;%s\\007' "$ec"
      __double0_ran=
    fi
    builtin printf '\\033]${INPUT_OSC};ps\\007'
  }
  __double0_preexec() {
    local line=\${1:-$3}
    [[ \${line## } == "$__double0_launch" ]] && return
    __double0_ran=1
    builtin printf '\\033]${INPUT_OSC};cmd;%s\\007' "$(builtin printf '%s' "\${line:0:${COMMAND_CHARS}}" | command base64 | command tr -d '\\n')"
  }
  __double0_addhistory() {
    [[ \${\${1%%$'\\n'}## } != "$__double0_launch" ]]
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __double0_precmd
  add-zsh-hook preexec __double0_preexec
  add-zsh-hook zshaddhistory __double0_addhistory
fi
`;

/**
 * The integration folder's files, by name. `.zlogin` is not among them: by
 * the time a login shell reads it, .zshrc has handed ZDOTDIR back, so zsh
 * reads the user's own.
 */
export function zshIntegrationFiles(): Record<string, string> {
  return {
    '.zshenv': chain('.zshenv'),
    '.zprofile': chain('.zprofile'),
    '.zshrc': ZSHRC,
  };
}

/** What a spawn adds for the integration: its env, and the shell's arguments. */
export type ShellIntegration = {
  env: Record<string, string>;
  args?: string[];
};

/**
 * The integration for a spawn of `shell`, or null when that shell has none.
 * `dir` holds the files above; `userZdotdir` is the app's own ZDOTDIR (the
 * user's, inherited), if any.
 */
export function zshIntegration(
  shell: string,
  dir: string,
  userZdotdir: string | undefined,
): ShellIntegration | null {
  const name = shell.split(/[\\/]/).pop()?.replace(/^-/, '') ?? '';
  if (name !== 'zsh') return null;
  const env: Record<string, string> = { ZDOTDIR: dir };
  if (userZdotdir) env[USER_ZDOTDIR_ENV] = userZdotdir;
  return { env };
}

/** The bash file's folder inside it - numbered like ZSH_INTEGRATION_FOLDER. */
export const BASH_INTEGRATION_FOLDER = 'bash-2';

/**
 * Set by a remote host's spawn (daemon/remote-spawn.ts): the bash rc file
 * then reads the login files instead of ~/.bashrc - a login bash ignores
 * --rcfile, and a host user's PATH often lives in ~/.bash_profile.
 */
export const BASH_LOGIN_ENV = 'DOUBLE0_BASH_LOGIN';

/** The rc file bash is started with (`--rcfile`). */
export const BASH_RC_NAME = 'bashrc';

/**
 * bash has no ZDOTDIR: a pty runs `bash --rcfile <ours>`, and ours sources the
 * user's ~/.bashrc first (the system file, Ubuntu's /etc/bash.bashrc, is read
 * by bash itself even with --rcfile - probed on 5.2). Then the same marks as
 * zsh, from bash's own hooks:
 *
 * - PROMPT_COMMAND gets `__double0_precmd` FIRST, so it reads the command's
 *   own `$?` and hands it back (`return $ec`) to whatever the user's prompt
 *   command does with it, and `__double0_arm` LAST, each on its own line: only
 *   a command that runs after the whole prompt command is the user's. An
 *   array PROMPT_COMMAND (bash 5.1+) is extended as an array;
 * - a DEBUG trap stands in for preexec: the first command after the arm is
 *   the user's line, read from history when it added one (the whole
 *   pipeline), else `$BASH_COMMAND` - only the line's first simple command,
 *   which is what a repeat under `ignoredups` or a space-led line under
 *   `ignorespace` reports. Commands inside functions, key bindings and
 *   completion functions are not the user's line and are skipped. A user who
 *   already has a DEBUG trap (starship without bash-preexec) keeps it, and
 *   bash-preexec replaces ours at its first prompt - no cmd / done marks
 *   then, the prompt and folder marks still come.
 *
 * The first precmd claims and sources the launch script exactly like zsh's.
 * The typed launch line starts with a space (`HISTCONTROL=ignorespace` keeps
 * it out of history where set); HISTIGNORE gets it as well.
 */
const BASHRC = `# double0 shell integration - reports each command for the Inputs list.
# Runs your own ~/.bashrc, then adds prompt hooks (a private plan
# in the double0 repo).
if [[ -n \${DOUBLE0_BASH_LOGIN:-} ]]; then
  # A remote host's shell: what a login bash reads (/etc/profile, then the
  # first of ~/.bash_profile, ~/.bash_login, ~/.profile - which usually
  # sources ~/.bashrc itself), since --rcfile only works without -l.
  builtin unset DOUBLE0_BASH_LOGIN
  [[ -f /etc/profile ]] && builtin source /etc/profile
  if [[ -f ~/.bash_profile ]]; then
    builtin source ~/.bash_profile
  elif [[ -f ~/.bash_login ]]; then
    builtin source ~/.bash_login
  elif [[ -f ~/.profile ]]; then
    builtin source ~/.profile
  fi
elif [[ -f ~/.bashrc ]]; then
  builtin source ~/.bashrc
fi
# The agent CLIs' install folders, after the user's files - a login file
# that resets PATH (Debian's /etc/profile) has had its say (agent-bins.ts),
# and the agent shims back in front of them all (claude-shim.ts).
${AGENT_BINS_SNIPPET}
${SHIM_PATH_SNIPPET}
if [[ $- == *i* && -z \${__double0_hooks:-} ]]; then
  __double0_hooks=1
  __double0_launch=${zshQuote(LAUNCH_LINE.trim())}
  __double0_ran=
  __double0_pwd=
  __double0_armed=
  __double0_hist=
  HISTIGNORE="\${HISTIGNORE:+$HISTIGNORE:}$__double0_launch: $__double0_launch"
  __double0_b64() {
    builtin printf '%s' "$1" | command base64 | command tr -d '\\n'
  }
  __double0_histline() {
    HISTTIMEFORMAT= builtin history 1 2>/dev/null
  }
  __double0_precmd() {
    local ec=$?
    __double0_armed=
    if [[ $PWD != "$__double0_pwd" ]]; then
      __double0_pwd=$PWD
      builtin printf '\\033]${INPUT_OSC};cwd;%s\\007' "$(__double0_b64 "$PWD")"
    fi
    if [[ -n \${${LAUNCH_ENV}:-} && -e \${${LAUNCH_ENV}:-} ]] &&
      command mv -- "$${LAUNCH_ENV}" "$${LAUNCH_ENV}${LAUNCH_SOURCED_SUFFIX}" 2>/dev/null; then
      builtin source "$${LAUNCH_ENV}${LAUNCH_SOURCED_SUFFIX}"
    fi
    if [[ -n $__double0_ran ]]; then
      builtin printf '\\033]${INPUT_OSC};done;%s\\007' "$ec"
      __double0_ran=
    fi
    builtin printf '\\033]${INPUT_OSC};ps\\007'
    __double0_hist=$(__double0_histline)
    return $ec
  }
  __double0_arm() {
    local ec=$?
    __double0_armed=1
    return $ec
  }
  __double0_preexec() {
    [[ -n $__double0_armed ]] || return 0
    case $BASH_COMMAND in __double0_*) return 0 ;; esac
    # Inside a function: extdebug / functrace hand the trap down to every
    # function body, ours included - never a line the user typed.
    [[ \${#FUNCNAME[@]} -gt 1 ]] && return 0
    # A key binding (bind -x: fzf's or atuin's Ctrl+R) or a completion
    # function runs between prompts; bash sets these only while it does.
    [[ -n \${READLINE_LINE+x}\${COMP_LINE+x} ]] && return 0
    __double0_armed=
    local line
    line=$(__double0_histline)
    if [[ -n $line && $line != "$__double0_hist" && $line =~ ^[[:space:]]*[0-9]+\\*?[[:space:]]+(.*)$ ]]; then
      line=\${BASH_REMATCH[1]}
    else
      line=$BASH_COMMAND
    fi
    [[ \${line## } == "$__double0_launch" ]] && return 0
    __double0_ran=1
    builtin printf '\\033]${INPUT_OSC};cmd;%s\\007' "$(__double0_b64 "\${line:0:${COMMAND_CHARS}}")"
  }
  if [[ -z $(trap -p DEBUG) ]]; then
    trap '__double0_preexec' DEBUG
  fi
  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
    PROMPT_COMMAND=(__double0_precmd "\${PROMPT_COMMAND[@]}" __double0_arm)
  else
    # Joined with newlines, never ';': PROMPT_COMMAND="history -a; $PROMPT_COMMAND"
    # leaves a trailing '; ', and '; ;' is a syntax error at every prompt (a
    # trailing newline or '# comment' broke a ';' join as well; review,
    # 2026-10-29).
    __double0_nl=$'\\n'
    PROMPT_COMMAND="__double0_precmd$__double0_nl\${PROMPT_COMMAND:+$PROMPT_COMMAND$__double0_nl}__double0_arm"
  fi
fi
`;

/** The bash integration folder's files, by name. */
export function bashIntegrationFiles(): Record<string, string> {
  return { [BASH_RC_NAME]: BASHRC };
}

/**
 * The integration for a spawn of `shell` when it is bash, or null. `dir`
 * holds the file above. A login shell would ignore --rcfile, but a local
 * bash gets the file on Linux only, where shells start without -l (only a
 * macOS shell is a login one - launch-materialize.ts › loginShellArgs).
 */
export function bashIntegration(shell: string, dir: string): ShellIntegration | null {
  const name = shell.split(/[\\/]/).pop()?.replace(/^-/, '') ?? '';
  if (name !== 'bash') return null;
  return { env: {}, args: ['--rcfile', `${dir}/${BASH_RC_NAME}`] };
}
