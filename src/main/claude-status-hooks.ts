/**
 * Claude Code status-hook wiring - the PURE part of the Claude agent adapter
 * (see AGENT_ADAPTERS in launch-plan.ts): the hook script and the `--settings`
 * document that maps Claude's lifecycle events onto the 6790 marker verbs the
 * renderer understands (lib/session/status.ts). No Electron / fs imports here,
 * so the mapping is unit-testable; launch-materialize.ts writes these to disk and injects
 * the flag.
 *
 * Verify a mapping change against the REAL CLI, not the docs - hook semantics
 * have surprised us before (`/clear` fires SessionEnd; see the SessionStart
 * entry below). `scripts/probe-claude-hooks.py` drives `claude --settings`
 * under a pty and logs every hook event and every standalone BEL.
 */

// --- Agent status signalling -------------------------------------------------
//
// Session status must be driven by REAL signals from the agent, not guessed from
// "is a process alive" (that misreads every quiet-but-parked Claude as waiting
// on you). Claude Code isn't a shell, so it emits no OSC 133 command marks - but
// its hook system fires on every lifecycle event we care about: turn started
// (UserPromptSubmit), turn ended (Stop), and blocked on the user (Notification,
// AskUserQuestion, ExitPlanMode). We inject those hooks, scoped to sessions we
// launch, via `claude --settings <file>`; each one runs a tiny script that
// writes an invisible private OSC marker (code 6790, with a lifecycle verb)
// straight to the session's pty device ($DOUBLE0_TTY, captured by the launch
// shell - hook processes have no controlling tty) - it reaches node-pty's
// output stream (so `observeSessionStatus` catches it) while xterm.js drops the
// unknown OSC without rendering anything. See lib/session-status.ts.
export const STATUS_OSC = '6790';

/**
 * The input marks' OSC code (terminal-inputs.ts): the shell integration's
 * `ps` / `cmd` / `done`, the `prompt` below, and main's position tags. Kept
 * apart from 6790 on purpose - any 6790 verb arms marker mode (the stream
 * then reads as an agent speaking the protocol), and a plain shell with
 * integration must stay on the fallback heuristics.
 */
export const INPUT_OSC = '6791';

/**
 * How long the `permission` verb waits for a following view's answer (a clock
 * deadline, not a poll count - the polls' own cost adds up): well inside the
 * hook's 600s timeout (claudeStatusSettings).
 */
export const PERMISSION_WAIT_SECONDS = 560;

/**
 * How long the hook waits on one marker write to the pty before giving up
 * (`emit` in STATUS_HOOK_SCRIPT). Generous on purpose: a live pty whose reader
 * is paused for flow control can hold a write for a while, and a marker given
 * up on is a status lost. A hung-up pty never answers at all.
 */
export const MARKER_WRITE_SECONDS = 10;

/** Bytes of a UserPromptSubmit stdin the `prompt` verb forwards (the JSON's head). */
export const PROMPT_PAYLOAD_BYTES = 4000;

/**
 * Env var naming the pty's status line capture file - an extension's status
 * line (launch-materialize.ts › AgentStatusLine) owns the folder. Unset
 * without one: the `codex` shim and the `ended` hook then write and remove
 * nothing.
 */
export const USAGE_FILE_ENV = 'DOUBLE0_USAGE_FILE';

/**
 * Env var naming the pty's marker folder - Windows only, where a ConPTY has
 * no device the hook could write to. Set, the hook script writes each
 * invocation's markers to a file of their own there (`<ns stamp>-<pid>.m`,
 * written as `.tmp` and renamed, so a reader never sees half of one) and
 * `PtyHost` splices them into the terminal's output stream (marker-inbox.ts) -
 * from there on everything reads them exactly as it reads a pty's.
 */
export const MARKER_DIR_ENV = 'DOUBLE0_MARKER_DIR';

/**
 * Env var naming the CLI the hook script serves, for the parts of the script
 * that differ by agent: unset for Claude Code (the original), `codex` when the
 * `codex` shim injected the hooks (claude-shim.ts). The `prompt` verb wraps
 * its payload as `{"program":"<name>","hook":<stdin head>` so the Inputs list
 * files the prompt under the right program (terminal-inputs.ts), and `ended`
 * leaves a Codex tab's status line capture alone - that capture carries the
 * CLI's pid and goes when it exits (its reader drops it), while a Codex SessionEnd may
 * mean `/new`, not an exit.
 */
export const AGENT_NAME_ENV = 'DOUBLE0_AGENT';

/**
 * Env var naming the agent that reports a tab's status - set, for its own
 * process and so for every descendant, by whatever injected that agent's
 * status hooks or plugin: the `claude` / `codex` shims export it before they
 * exec the real binary with the hooks, the OpenCode plugin sets it in
 * `process.env` as it loads (claude-shim.ts, opencode-status-plugin.ts). The
 * injection points READ it first: an agent's tool shell inherits the agent's
 * whole env - the pty device, the hook files, the inline OpenCode config,
 * the PATH shims - so a `claude -p`, `codex exec` or `opencode run` an agent
 * runs INSIDE its own tool would otherwise get the same hooks and write
 * `ready` / `running` / `ended` into the parent tab's pty, ending the parent's
 * turn or retiring its marker mode mid-run. With the variable set, a shim
 * execs the plain binary (no hooks, no pin, no status line capture) and the plugin
 * installs no hooks: only the TOP-LEVEL agent of a tab speaks. The value
 * names that agent (`claude` / `codex` / `opencode`); only its presence
 * matters. Never set it on the launch line: the top-level agent's own
 * injection must still see it unset. The plain `claude` adapter line
 * (launch-plan.ts) exports none of the shim / plugin env, so nothing nested
 * under it can inject in the first place.
 */
export const STATUS_OWNER_ENV = 'DOUBLE0_STATUS_OWNER';

/**
 * The script the injected hooks run, with the marker verb as $1. For `question`
 * (Claude's AskUserQuestion about to run) it forwards the hook's whole stdin
 * JSON - which carries tool_input with the question + options - base64-encoded,
 * so the renderer can show WHAT is being asked without any shell-side JSON
 * parsing. `tr` strips GNU base64's line wrapping (macOS base64 doesn't wrap);
 * the payload is capped below the renderer's OSC carry buffer (CARRY_MAX in
 * session-status.ts), degrading to the bare needs-input marker, which still
 * flips the status.
 *
 * `$record` is the tab's record file: $DOUBLE0_SESSION_FILE (agent-resume.ts),
 * or under Codex ($DOUBLE0_AGENT=codex) $DOUBLE0_CODEX_SESSION_FILE - a Codex
 * thread id must never land in the Claude record the tab's next `claude`
 * resumes from. Both names are spelled out here (no fs-importing module in
 * this file); the test pins them to agent-resume.ts.
 *
 * `session` (every SessionStart) emits no marker at all: it pulls `session_id`
 * out of the hook's stdin JSON and writes it bare to `$record` -
 * the per-tab record the next launch resumes from (see agent-resume.ts). That
 * is what keeps a tab on the conversation it is actually in after a `/clear`
 * or an in-Claude `/resume`, both of which move it to a new session id. The
 * id is checked for uuid length so a malformed payload can't poison the record,
 * and nothing is written when the launch wasn't pinned (variable unset). The
 * payload's `transcript_path` goes next to it (`<record>.transcript`): the
 * conversation file an extension's view over the tab reads - Claude
 * picks the folder (its config dir, the cwd slug), so it is recorded rather
 * than guessed. So does Claude's pid (`<record>.pid` - the hook's parent, or
 * its grandparent when a `sh -c` sits between, verified on 2.1.289): such a
 * view types a prompt only while that process lives, since a killed Claude
 * sends no SessionEnd and the tab's markers would still claim it.
 *
 * `needs-input` with a PermissionRequest payload (the mapping a Claude
 * launched before `permission` existed still has - this script is rewritten
 * under it at app start) asks the view the same way; never under Codex.
 *
 * `permission` (PermissionRequest) emits the bare needs-input marker, then -
 * only when a view follows the tab, i.e. the `<record>.ask` folder exists
 * - asks there: it writes the payload to `<record>.ask/<pid>.req` (the request
 * carries no tool_use_id, so the hook's own pid names it) and polls for
 * `<pid>.ans` (`allow`, `deny`, or `always` followed by a line holding the
 * permission rules to add, or `answer` followed by the tool's updated input -
 * an AskUserQuestion's answers). An answer is printed as the PermissionRequest
 * decision - the ONE place the script writes to stdout, which is that hook's
 * decision channel. Main removing the request (the TUI answered first, the
 * view closed) ends the wait silently; so does the wait running out. Claude
 * shows its own dialog meanwhile and kills the hook if that is answered first;
 * the trap tidies the request away then.
 *
 * Never `echo` a JSON value: /bin/sh's echo (xpg_echo) turns the `\\n` inside a
 * multi-line command into a real newline (verified: a probe's `echo "$json"`
 * split its log at every escaped newline) - `printf '%s'` keeps it literal.
 *
 * `tool-start` / `tool-done` (every PreToolUse / PostToolUse) forward WHAT the
 * agent is doing: the tool's name and its headline argument - the first of
 * file_path, notebook_path, command, pattern, description, url, query, skill
 * found in the hook's stdin JSON - as base64 of `<name>\n<arg>`, each line
 * capped at 300 chars. `field` reads the FIRST occurrence of a key on the
 * assumption that tool_input precedes tool_response in the payload (it does:
 * hook JSON is emitted in declaration order), so an edited file whose content
 * happens to contain `"command": "` can't hijack the value. A value is cut at
 * its first escaped quote (`[^"]*` - no alternation in BSD sed's BRE); the
 * renderer trims the dangling backslash. Values are never parsed as JSON
 * here: this is a headline, not a record.
 *
 * A tool call made by a SUBAGENT - the Agent tool's worker, whose hooks fire
 * in the same process and write to the same pty - carries its `agent_type`
 * (or `agent` when the CLI leaves it empty) as a third payload line, keyed off
 * the `agent_id` the CLI adds to such payloads (verified on 2.1.278). Only
 * the payload's head - everything before `"tool_input"` - is searched: the
 * CLI puts `agent_id` among the envelope keys, and a tool whose own input
 * has an `agent_id` parameter (an MCP tool) must not tag the MAIN agent's
 * call. The renderer shows the call like any other but never lets it lift
 * needs-input: a BACKGROUND subagent works on while the main agent sits at a
 * permission dialog, and its tools completing must not read as the user
 * answering.
 *
 * `finished` (Stop) reads stdin for the same reason: the main agent's Stop
 * fires while a background subagent it launched is still working (the stdin
 * lists it under `background_tasks` as `"type":"subagent","status":"running"`,
 * verified on 2.1.278), and the agent is re-invoked - a fresh
 * UserPromptSubmit/Stop pair - when that subagent reports back. Emitting
 * `finished` there fired a "session finished" alert for a session still at
 * work and flipped it back to running on the subagent's next tool. So no
 * marker while a subagent runs on; ONLY a subagent counts - a background
 * shell (`"type":"shell"`, a dev server) never re-invokes anything and would
 * pin the session active forever. A payload without the list (an older CLI,
 * the SessionStart `clear` that also emits this verb) finishes as before.
 * The check matches the adjacent `type`/`status` pair (either order) rather
 * than scoping to the array: a task's `description` is the agent's free text,
 * and a `]` or `}` in it ended a bracket-scoped match early, dropped the
 * running subagent and brought the false alert back. An escaped copy of the
 * pair inside a string (`\"type\":\"subagent\"`) cannot match.
 *
 * `ended` (SessionEnd) also removes the tab's status line capture
 * ($DOUBLE0_USAGE_FILE, when set) when the CLI is really exiting, so nothing
 * reads a tab back at its shell prompt as still running that agent.
 * Not for `clear` or `resume` (the CLI's own SessionEnd reasons, read off
 * 2.1.278): the process runs on into a new session, and its status line
 * would only write the same config dir back.
 *
 * `prompt` (UserPromptSubmit) emits `running` exactly as before, then the
 * input mark the status bar's Inputs list is built from: the first
 * PROMPT_PAYLOAD_BYTES of the hook's stdin JSON, base64-encoded, as
 * `6791;prompt;<payload>`. The prompt is the JSON's last key (after
 * `prompt_id`, verified on 2.1.278), and main reads it leniently from the
 * head (terminal-inputs.ts `promptFromHookJson`) - no JSON parsing in sh. The
 * rest of stdin is drained so a long prompt never meets a closed pipe. Both
 * markers go out in ONE write, running first. Under another CLI
 * ($DOUBLE0_AGENT set - the `codex` shim) the head is wrapped as
 * `{"program":"codex","hook":…` so the list files it under that program;
 * Claude's payload is unchanged.
 *
 * The script is shared by every CLI whose hook protocol is Claude's - Codex
 * runs it too (codex-status-hooks.ts); its own hook stdin carries the same
 * keys, so nothing here is Claude-specific but the `finished` task check
 * (harmless elsewhere: no list, no hold).
 *
 * `needs-input` reads stdin too - the Notification hook's `message` ("Claude
 * needs your permission") rides along base64-encoded so the row
 * can say what the agent is blocked on when no tool precedes it. The verb is
 * also used by ExitPlanMode's PreToolUse entry, whose stdin has no message:
 * the bare marker is emitted, exactly as before.
 *
 * The marker goes to $DOUBLE0_TTY - the session pty's device, captured by the
 * launch shell (see augmentAgentCommand) - NOT /dev/tty: Claude spawns hook
 * processes without a controlling terminal, so /dev/tty fails to open there
 * (verified live; it's kept only as a fallback for exotic setups). On Windows
 * it goes to a file in $DOUBLE0_MARKER_DIR instead (MARKER_DIR_ENV), published
 * by `publish` - a no-op elsewhere - once written: at the end, and before
 * `ask_viewer` starts its long wait. The session record there holds no pid: the
 * hook's msys `ps` sees Claude, a native process, as pid 1.
 *
 * Every marker goes through `emit`, which can never hang the hook. Once a tab
 * has closed (its pty hung up), `open()` on the old device waits for a
 * carrier that never comes. The hook then hung forever, and so did the
 * agent waiting on it: the demo's fake agent ran its SessionEnd hook after
 * the hangup and both lived on for days (2026-11-05). So the tty write runs
 * in the background and the hook waits on a plain `sleep
 * MARKER_WRITE_SECONDS` started BEFORE it: the writer kills that sleep once
 * its write landed (a live pty: at once), else the sleep runs out and the
 * writer is killed. Both are direct children whose pids are known before
 * anything is signalled, so nothing outlives the hook. A watchdog subshell
 * with a TERM trap raced on every shell (the parent ended it before its
 * trap or `$!` was set) and orphaned a sleep holding the hook's stdout,
 * which an agent waits on to close. The sleep's stdio is /dev/null for the
 * same reason. A marker file (Windows) never blocks and is written directly.
 *
 * Hard rules: ALWAYS exit 0 - a nonzero PreToolUse hook exit would BLOCK the
 * agent's tool call - and NEVER write to stdout (but for `permission`'s
 * decision), which UserPromptSubmit hooks
 * get injected into the conversation as context (hence `exec 2>/dev/null`
 * rather than per-command redirects: a failed open of the target device is
 * reported by sh itself, outside any per-command 2> redirect).
 */
export const STATUS_HOOK_SCRIPT = `#!/bin/sh
exec 2>/dev/null
out="\${DOUBLE0_TTY:-/dev/tty}"
publish() { :; }
if [ -n "\${${MARKER_DIR_ENV}:-}" ]; then
  out="$${MARKER_DIR_ENV}/$(date +%s%N | tr -cd '0-9')-$$.tmp"
  publish() {
    [ -s "$out" ] && mv -f "$out" "\${out%.tmp}.m"
    rm -f "$out"
  }
fi
verb="$1"
record="\${DOUBLE0_SESSION_FILE:-}"
[ "\${${AGENT_NAME_ENV}:-}" = codex ] && record="\${DOUBLE0_CODEX_SESSION_FILE:-}"
field() {
  grep -o "\\"$1\\" *: *\\"[^\\"]*\\"" | head -n 1 | sed 's/^"[^"]*" *: *"//; s/"$//'
}
emit() {
  if [ -n "\${${MARKER_DIR_ENV}:-}" ]; then
    printf "$@" > "$out"
    return 0
  fi
  sleep ${MARKER_WRITE_SECONDS} < /dev/null > /dev/null &
  nap=$!
  (
    printf "$@" > "$out"
    kill "$nap"
  ) &
  writer=$!
  wait "$nap"
  kill -9 "$writer"
  wait "$writer"
}
decide() {
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":%s}}' "$1"
}
ask_viewer() {
  ask="$record.ask"
  [ -n "$record" ] && [ -d "$ask" ] || return 0
  req="$ask/$$.req"
  ans="$ask/$$.ans"
  trap 'rm -f "$req" "$req.tmp" "$ans"; exit 0' HUP INT TERM
  rm -f "$ans"
  printf '%s' "$json" > "$req.tmp" && mv -f "$req.tmp" "$req"
  end=$(( $(date +%s) + ${PERMISSION_WAIT_SECONDS} ))
  while [ "$(date +%s)" -lt "$end" ] && [ -f "$req" ]; do
    if [ -s "$ans" ]; then
      verdict=$(head -n 1 "$ans")
      detail=$(tail -n +2 "$ans")
      rm -f "$req" "$ans"
      case "$verdict" in
        allow) decide '{"behavior":"allow"}' ;;
        always)
          [ -n "$detail" ] || detail='[]'
          decide "{\\"behavior\\":\\"allow\\",\\"updatedPermissions\\":$detail}"
          ;;
        answer)
          [ -n "$detail" ] || detail='{}'
          decide "{\\"behavior\\":\\"allow\\",\\"updatedInput\\":$detail}"
          ;;
        deny) decide '{"behavior":"deny","message":"The user declined this in double0."}' ;;
      esac
      exit 0
    fi
    sleep 0.3 || sleep 1
  done
  rm -f "$req" "$ans"
}
case "$verb" in
  question)
    payload=$(base64 | tr -d '\\n')
    if [ -n "$payload" ] && [ \${#payload} -le 6000 ]; then
      emit '\\033]${STATUS_OSC};question;%s\\007' "$payload"
    else
      emit '\\033]${STATUS_OSC};needs-input\\007'
    fi
    ;;
  session)
    json=$(cat)
    id=$(printf '%s\\n' "$json" | sed -n 's/.*"session_id" *: *"\\([^"]*\\)".*/\\1/p' | head -n 1)
    if [ -n "$record" ] && [ \${#id} -eq 36 ]; then
      printf '%s' "$id" > "$record"
      transcript=$(printf '%s\\n' "$json" | field transcript_path)
      case "$transcript" in
        /*.jsonl) printf '%s' "$transcript" > "$record.transcript" ;;
        [A-Za-z]:*.jsonl)
          # A Windows path, its backslashes still JSON-escaped.
          transcript=$(printf '%s' "$transcript" | sed 's/\\\\\\\\/\\\\/g')
          printf '%s' "$transcript" > "$record.transcript"
          ;;
      esac
      # Windows: msys \`ps\` cannot walk to Claude (a native parent reads as
      # pid 1) - main asks the OS whether the shell has a child instead.
      [ -z "\${${MARKER_DIR_ENV}:-}" ] || exit 0
      pid=$PPID
      # Up past any shell between Claude and the hook (sh -c, a zsh or fish
      # hook shell, a shell prefix wrapper) - a few levels at most.
      for _ in 1 2 3 4; do
        case "$(ps -o comm= -p "$pid" | sed 's#.*/##; s#^-##')" in
          sh|dash|bash|zsh|fish|ksh|env) pid=$(ps -o ppid= -p "$pid" | tr -d ' ') ;;
          *) break ;;
        esac
      done
      case "$pid" in
        ''|*[!0-9]*) ;;
        *) printf '%s' "$pid" > "$record.pid" ;;
      esac
    fi
    ;;
  permission)
    json=$(cat)
    emit '\\033]${STATUS_OSC};needs-input\\007'
    publish
    ask_viewer
    ;;
  tool-start|tool-done)
    json=$(cat)
    name=$(printf '%s\\n' "$json" | field tool_name)
    arg=''
    for key in file_path notebook_path command pattern description url query skill; do
      arg=$(printf '%s\\n' "$json" | field "$key")
      [ -n "$arg" ] && break
    done
    agent=''
    envelope=\${json%%'"tool_input"'*}
    if [ -n "$(printf '%s\\n' "$envelope" | field agent_id)" ]; then
      agent=$(printf '%s\\n' "$envelope" | field agent_type)
      [ -n "$agent" ] || agent=agent
    fi
    if [ -n "$name" ]; then
      if [ -n "$agent" ]; then
        payload=$(printf '%s\\n%s\\n%s\\n' "$name" "$arg" "$agent" | cut -c1-300 | base64 | tr -d '\\n')
      else
        payload=$(printf '%s\\n%s\\n' "$name" "$arg" | cut -c1-300 | base64 | tr -d '\\n')
      fi
      emit '\\033]${STATUS_OSC};%s;%s\\007' "$verb" "$payload"
    fi
    ;;
  prompt)
    if [ -n "\${${AGENT_NAME_ENV}:-}" ]; then
      payload=$({ printf '{"program":"%s","hook":' "$${AGENT_NAME_ENV}"; head -c ${PROMPT_PAYLOAD_BYTES}; } | base64 | tr -d '\\n')
    else
      payload=$(head -c ${PROMPT_PAYLOAD_BYTES} | base64 | tr -d '\\n')
    fi
    cat > /dev/null
    if [ -n "$payload" ]; then
      emit '\\033]${STATUS_OSC};running\\007\\033]${INPUT_OSC};prompt;%s\\007' "$payload"
    else
      emit '\\033]${STATUS_OSC};running\\007'
    fi
    ;;
  finished)
    json=$(cat)
    running=$(printf '%s\\n' "$json" | tr '\\n\\r\\t' '   ' | grep -o -e '"type" *: *"subagent" *, *"status" *: *"running"' -e '"status" *: *"running" *, *"type" *: *"subagent"' | grep -c .)
    if [ "\${running:-0}" -eq 0 ]; then
      emit '\\033]${STATUS_OSC};finished\\007'
    fi
    ;;
  ended)
    case "$(field reason)" in
      clear|resume) ;;
      *) [ -z "\${${USAGE_FILE_ENV}:-}" ] || [ "\${${AGENT_NAME_ENV}:-}" = codex ] || rm -f "$${USAGE_FILE_ENV}" ;;
    esac
    emit '\\033]${STATUS_OSC};ended\\007'
    ;;
  needs-input)
    json=$(cat)
    msg=$(printf '%s\\n' "$json" | field message | cut -c1-300)
    if [ -n "$msg" ]; then
      emit '\\033]${STATUS_OSC};needs-input;%s\\007' "$(printf '%s' "$msg" | base64 | tr -d '\\n')"
    else
      emit '\\033]${STATUS_OSC};needs-input\\007'
    fi
    # A Claude launched before the \`permission\` verb existed still maps its
    # PermissionRequest here; this script is rewritten under it, so a
    # following view can answer that one too. Never for Codex (its own protocol).
    if [ "$(printf '%s\\n' "$json" | field hook_event_name)" = PermissionRequest ] && [ "\${${AGENT_NAME_ENV}:-}" != codex ]; then
      publish
      ask_viewer
    fi
    ;;
  *)
    emit '\\033]${STATUS_OSC};%s\\007' "$verb"
    ;;
esac
publish
exit 0
`;

// --- Windows -----------------------------------------------------------------
//
// Claude Code on Windows runs a status line command through Git Bash, and
// through PowerShell when it finds none (code.claude.com/docs/en/statusline),
// and its hooks the same way. A ConPTY has no device the hooks could write
// their markers to, so there they go to the pty's marker folder
// (MARKER_DIR_ENV) and the host splices them into the stream. Without Git
// Bash nothing is injected: neither script could run.

/**
 * The Git Bash Claude Code will run commands under, or null: the
 * `CLAUDE_CODE_GIT_BASH_PATH` override, else the one beside a `git.exe` on
 * PATH (`Git\cmd` or `Git\bin`), else the default install. Without one the
 * status line would land in PowerShell, which cannot run the `sh` script -
 * the launch then goes without it.
 */
export function gitBashPath(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): string | null {
  const override = env.CLAUDE_CODE_GIT_BASH_PATH?.trim();
  if (override) return exists(override) ? override : null;
  const candidates: string[] = [];
  for (const raw of (env.PATH ?? env.Path ?? '').split(';')) {
    const dir = raw.trim().replace(/[\\/]+$/, '');
    if (!dir || !exists(`${dir}\\git.exe`)) continue;
    candidates.push(`${dir}\\bash.exe`, `${dir.replace(/[^\\/]+$/, '')}bin\\bash.exe`);
  }
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (root) candidates.push(`${root.replace(/[\\/]+$/, '')}\\Git\\bin\\bash.exe`);
  }
  return candidates.find(exists) ?? null;
}

/**
 * A plain `claude …` start command with our status line settings, for cmd.exe
 * and PowerShell alike (startup-typer.ts › windowsLaunch): a double-quoted
 * path with forward slashes, which both shells and Git Bash read as is.
 */
export function windowsClaudeCommand(command: string, settingsPath: string): string {
  return command.replace(/^claude/, `claude --settings "${settingsPath.replace(/\\/g, '/')}"`);
}

/**
 * The Claude Code settings we inject: `--settings` MERGES at the command-line
 * tier (it never replaces the user's ~/.claude config, and hooks are additive),
 * so the user's own hooks/permissions/auth are untouched. Verb per event:
 * agent launched or resumed → ready, blocked on a permission/input →
 * needs-input (the permission dialog opening, and its later notification), turn started → running (+ the prompt, verb `prompt`), turn ended → finished, AskUserQuestion
 * about to show / answered → question (with payload) / question-done, and
 * ExitPlanMode's approval dialog → needs-input.
 * Every tool call → tool-start (PreToolUse) / tool-done (PostToolUse) with the
 * tool's name and argument - what the session row shows while the agent works
 * (the wildcard PostToolUse entry doubles as the deterministic heal for a
 * sticky needs-input, see session-status: ANY tool completing proves the
 * agent resumed, e.g. right after the user approved its prompt). SessionEnd
 * → ended tells the renderer the agent is gone (our pty runs the SHELL, so the
 * pty doesn't exit with the agent) - it drops that terminal back to the
 * no-marker fallback heuristics. SessionStart(clear) → finished re-arms marker
 * mode after a `/clear`, which fires SessionEnd first (see the entry).
 * `statusLine` (optional) is an extension's status line command
 * (launch-materialize.ts › AgentStatusLine); without one the user's own
 * status line is left alone.
 */
export function claudeStatusSettings(
  scriptPath: string,
  statusLine?: object,
  /** An extension's agent tools: their instructions file, the commands that need no prompt. */
  tools?: { instructionsPath: string; allow: readonly string[] },
): object {
  const hook = (verb: string): object => ({
    hooks: [{ type: 'command', command: `'${scriptPath}' ${verb}` }],
  });
  const matcherHook = (matcher: string, verb: string): object => ({ matcher, ...hook(verb) });
  return {
    ...(statusLine ? { statusLine } : {}),
    // The agent runs the extension's tool without a prompt per command.
    // Permission lists merge across settings tiers: the user's stay.
    ...(tools && tools.allow.length > 0 ? { permissions: { allow: [...tools.allow] } } : {}),
    hooks: {
      Notification: ['permission_prompt', 'agent_needs_input', 'elicitation_dialog'].map(
        (matcher) => matcherHook(matcher, 'needs-input'),
      ),
      // The permission dialog itself, the moment it opens - the Notification
      // for it follows ~6s later (verified on CLI 2.1.258: PreToolUse at t,
      // PermissionRequest at t+0.1s, Notification at t+6s). Same verb; the
      // late notification is then a no-op. The script never answers the
      // request (no stdout, exit 0), so the dialog shows as it always did.
      //
      // `permission` = that same marker, then - while a view follows the
      // tab (its `.ask` folder exists) - a wait for
      // the answer given there. The TUI dialog shows meanwhile, as always;
      // whichever answers first wins (verified on CLI 2.1.289: an answer in
      // the TUI kills the waiting hook). The timeout outlasts the script's
      // own wait, so Claude never reports the hook as timed out.
      PermissionRequest: [
        { hooks: [{ type: 'command', command: `'${scriptPath}' permission`, timeout: 600 }] },
      ],
      // `prompt` = the `running` verb plus the prompt itself for the Inputs
      // list (see STATUS_HOOK_SCRIPT).
      UserPromptSubmit: [hook('prompt')],
      Stop: [hook('finished')],
      // A turn that dies on an API error (overloaded, rate limit, network,
      // expired login) fires StopFailure INSTEAD of Stop - without it the
      // session read "working" until the next prompt (2026-10-28).
      StopFailure: [hook('finished')],
      SessionEnd: [hook('ended')],
      // `/clear` on a non-empty conversation fires SessionEnd{reason:"clear"} -
      // our 'ended' - then SessionStart{source:"clear"} (verified on CLI 2.1.245;
      // an empty session fires only the SessionStart). Without this entry the
      // terminal would stay in the renderer's no-marker fallback until the next
      // prompt, where Claude's idle-prompt bell (preferredNotifChannel
      // terminal_bell, ~60s unfocused) reads as needs-input. 'finished' both
      // re-arms marker mode and states the truth: the agent is parked at an
      // idle prompt. ONLY `clear`: `compact` fires mid-turn (auto-compaction
      // between tool calls), where 'finished' would falsely idle a working
      // session; `startup`/`resume` have no preceding SessionEnd and settle via
      // the fallback rules as before.
      //
      // The unmatched `session` entry runs on EVERY SessionStart (startup,
      // resume, clear, compact) and records the live session id for the tab -
      // `clear` and an in-Claude `/resume` both move the tab to a new id, and
      // relaunching the original would reopen an older conversation (see
      // agent-resume.ts). It writes a file, never a marker.
      //
      // `startup` / `resume` (the app launching or relaunching the agent) →
      // 'ready': the agent is up and speaks the protocol, so the renderer arms
      // marker mode at once instead of sitting in the output/quiet fallback
      // until the first prompt - where the resume transcript and every repaint
      // read as work, and the idle-prompt bell as needs-input. 'ready' corrects
      // a stale running/waiting status to idle QUIETLY (nothing finished) and
      // leaves a finished-unseen mark alone. Never `compact`: mid-turn.
      SessionStart: [
        matcherHook('startup|resume', 'ready'),
        matcherHook('clear', 'finished'),
        hook('session'),
        // A SessionStart hook's stdout joins the conversation's context: the
        // few lines telling the agent the extension's tools exist (again after
        // a /clear or a compaction, which drop them).
        ...(tools
          ? [{ hooks: [{ type: 'command', command: `cat '${tools.instructionsPath}'` }] }]
          : []),
      ],
      // Every tool call reports itself before and after it runs (`tool-start`
      // / `tool-done`, with the tool's name + headline argument as payload) -
      // the session row's "Editing token.service.ts" / "Wants to run pnpm
      // test" and the end-of-turn "3 files edited" all come from these. The
      // wildcard PostToolUse entry is ALSO the deterministic heal for a sticky
      // needs-input (see session-status): ANY tool completing proves the agent
      // resumed, e.g. right after the user approved its permission prompt -
      // `tool-done` implies running. PreToolUse fires BEFORE the permission
      // prompt, which is what lets the needs-input row name the pending tool.
      PreToolUse: [
        matcherHook('AskUserQuestion', 'question'),
        matcherHook('ExitPlanMode', 'needs-input'),
        matcherHook('*', 'tool-start'),
      ],
      PostToolUse: [matcherHook('AskUserQuestion', 'question-done'), matcherHook('*', 'tool-done')],
    },
  };
}
