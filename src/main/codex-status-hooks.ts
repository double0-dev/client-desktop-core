import { shellQuote } from './agent-resume';

/**
 * Codex status-hook wiring - the PURE part of the Codex agent adapter: the
 * `-c` config overrides that map Codex's lifecycle hooks onto the 6790 marker
 * verbs, through the SAME hook script Claude Code runs (claude-status-hooks.ts
 * › STATUS_HOOK_SCRIPT): Codex's hook protocol is Claude's - the same event
 * names, the same stdin JSON (`hook_event_name`, `tool_name`, `tool_input`,
 * `prompt`, `source`, `reason`), the same exit-code and stdout rules (read off
 * the 0.160.0 binary and its docs). No Electron / fs imports; terminal.ts
 * writes the override list to a file and the `codex` PATH shim
 * (claude-shim.ts › CODEX_SHIM_SCRIPT) puts the flags on the real binary's
 * argv. a private plan has the whole story.
 *
 * How it gets in: `codex -c 'hooks.<Event>=[…]'` sets a config key for that
 * invocation only, parsed as TOML; Codex MERGES hook sources ("higher-
 * precedence config layers don't replace lower-precedence hooks"), so the
 * user's own `hooks.<Event>` in config.toml / hooks.json run on beside ours.
 * No config file of theirs is touched. Verified on 0.160.0: every shape below
 * parses under `--strict-config`, also ahead of `resume` / `fork`.
 *
 * The catch - hook TRUST: Codex runs a non-managed hook only once the user has
 * trusted its hash (`/hooks` in the TUI; the trust is saved in their config as
 * `hooks.state`). Ours come in as the "Session flags" source, non-managed, so
 * the first Codex launch lists them as needing review and runs none until the
 * user trusts them once per Codex home - the hash is over the normalised hook
 * config (event, matcher, command), so it stays stable across launches as
 * long as the script path does. Until then the tab stays on the fallback
 * heuristics, exactly as before. `--dangerously-bypass-hook-trust` is NOT
 * injected: it would also run a repository's own unreviewed hooks.
 *
 * Event → verb (Codex 0.160.0, from its docs - NOT yet verified against a
 * logged-in CLI, see the plan):
 *   SessionStart startup / resume   → ready (marker mode armed at once)
 *   SessionStart clear              → finished (a /new: parked at a prompt)
 *   SessionEnd                      → ended (the CLI is gone; a plain shell
 *                                     remains)
 *   UserPromptSubmit                → prompt (= running + the Inputs mark)
 *   Stop                            → finished
 *   Interrupt (the user stopped it) → ready: idle QUIETLY, nothing finished -
 *                                     the renderer's own Esc handling already
 *                                     settled the row, this corrects main
 *   SessionStart (every source)     → session: the tab's Codex record for
 *                                     a following view - thread id, rollout
 *                                     path, pid (claude-status-hooks.ts)
 *   PermissionRequest (any tool)    → permission: needs-input, and - while a
 *                                     view follows the tab - the
 *                                     request filed for it to answer. Codex
 *                                     takes Claude's decision shape
 *                                     (allow / deny only: `updatedPermissions`
 *                                     or `updatedInput` fail the hook) and
 *                                     shows its own dialog only once the hook
 *                                     returned without one (0.160.0 source,
 *                                     `core/src/tools/approvals.rs`)
 *   PreToolUse / PostToolUse (any)  → tool-start / tool-done
 * Codex's lifecycle matchers are declared one value per group (never
 * `startup|resume`): whether it matches them as regexes is unverified, and
 * exact strings work either way. SubagentStart / SubagentStop, PreCompact /
 * PostCompact are not mapped: compaction is mid-turn, and a subagent's tool
 * calls already fire the parent's PreToolUse / PostToolUse (tagged by the
 * script when the payload carries `agent_id`).
 */

/** File under the OS temp dir listing the overrides, one per line (see CODEX_SHIM_SCRIPT). */
export const CODEX_HOOKS_FILE_NAME = 'double0-codex-hooks.conf';
/** Env var naming that file for the `codex` shim; unset = no hooks. */
export const CODEX_SHIM_HOOKS_ENV = 'DOUBLE0_CODEX_HOOKS';

type HookGroup = { matcher?: string; verb: string };

/** The mapping, in the order the overrides are written. */
export const CODEX_HOOK_EVENTS: ReadonlyArray<readonly [event: string, groups: HookGroup[]]> = [
  [
    'SessionStart',
    [
      { matcher: 'startup', verb: 'ready' },
      { matcher: 'resume', verb: 'ready' },
      { matcher: 'clear', verb: 'finished' },
      // Every source: the tab's Codex record for a following view (thread id,
      // rollout path, pid). Codex fires SessionStart at the first prompt.
      { verb: 'session' },
    ],
  ],
  ['SessionEnd', [{ verb: 'ended' }]],
  ['UserPromptSubmit', [{ verb: 'prompt' }]],
  ['Stop', [{ verb: 'finished' }]],
  ['Interrupt', [{ verb: 'ready' }]],
  ['PermissionRequest', [{ matcher: '.*', verb: 'permission' }]],
  ['PreToolUse', [{ matcher: '.*', verb: 'tool-start' }]],
  ['PostToolUse', [{ matcher: '.*', verb: 'tool-done' }]],
];

/** A TOML basic string: `"…"` with backslashes and quotes escaped. */
export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * One `-c` override per hook event: `hooks.<Event>=[{matcher="…",hooks=[{type="command",command="'<script>' <verb>"}]},…]`.
 * The command is the script path single-quoted for the shell Codex runs it
 * with, then TOML-escaped. Each line sets a DIFFERENT key, so the order the
 * shim applies them in does not matter.
 */
export function codexHookOverrides(scriptPath: string): string[] {
  return CODEX_HOOK_EVENTS.map(([event, groups]) => {
    const list = groups.map(({ matcher, verb }) => {
      const command = tomlString(`${shellQuote(scriptPath)} ${verb}`);
      const match = matcher === undefined ? '' : `matcher=${tomlString(matcher)},`;
      return `{${match}hooks=[{type="command",command=${command}}]}`;
    });
    return `hooks.${event}=[${list.join(',')}]`;
  });
}

/** The override file's content: one override per line, newline-terminated. */
export function codexHooksFile(scriptPath: string, instructions?: string): string {
  const lines = codexHookOverrides(scriptPath);
  // An extension's agent tools (their instructions) - one TOML string,
  // newlines escaped, so it stays one line of this file.
  if (instructions) lines.push(`developer_instructions=${tomlString(instructions)}`);
  return `${lines.join('\n')}\n`;
}
