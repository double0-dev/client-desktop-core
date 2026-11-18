import { describe, expect, it } from 'vitest';
import {
  CODEX_HOOK_EVENTS,
  CODEX_SHIM_HOOKS_ENV,
  codexHookOverrides,
  codexHooksFile,
  tomlString,
} from './codex-status-hooks';

const SCRIPT = '/tmp/double0-status-hook.sh';

/** `[matcher, verb]` per group of one event's override, in declared order. */
function mapping(event: string): Array<[string | undefined, string]> {
  const line = codexHookOverrides(SCRIPT).find((l) => l.startsWith(`hooks.${event}=`));
  expect(line, event).toBeDefined();
  const groups = [
    ...line!.matchAll(/\{(?:matcher="([^"]*)",)?hooks=\[\{type="command",command="([^"]*)"\}\]\}/g),
  ];
  expect(groups.length).toBeGreaterThan(0);
  return groups.map((g) => {
    // The command is the script, single-quoted for sh, plus exactly one verb.
    const m = /^'([^']+)' ([a-z-]+)$/.exec(g[2]);
    expect(m, g[2]).not.toBeNull();
    expect(m![1]).toBe(SCRIPT);
    return [g[1], m![2]];
  });
}

describe('codexHookOverrides - Codex lifecycle → marker verb', () => {
  it('arms marker mode when the agent starts or resumes, and parks it after a /new', () => {
    // One value per group, never `startup|resume`: whether Codex matches a
    // lifecycle matcher as a regex is unverified, exact strings work either way.
    expect(mapping('SessionStart')).toEqual([
      ['startup', 'ready'],
      ['resume', 'ready'],
      ['clear', 'finished'],
      // Every source (no matcher): the record a following view reads.
      [undefined, 'session'],
    ]);
  });

  it('maps a turn starting / ending to prompt / finished, the CLI exiting to ended', () => {
    expect(mapping('UserPromptSubmit')).toEqual([[undefined, 'prompt']]);
    expect(mapping('Stop')).toEqual([[undefined, 'finished']]);
    expect(mapping('SessionEnd')).toEqual([[undefined, 'ended']]);
  });

  it('settles an interrupted turn quietly - nothing finished', () => {
    // Stop does not fire on an interrupt; `ready` idles the pty in main
    // without a finished mark or alert, matching the renderer's Esc handling.
    expect(mapping('Interrupt')).toEqual([[undefined, 'ready']]);
  });

  it('flags every approval request (asking a following view) and reports every tool call', () => {
    expect(mapping('PermissionRequest')).toEqual([['.*', 'permission']]);
    expect(mapping('PreToolUse')).toEqual([['.*', 'tool-start']]);
    expect(mapping('PostToolUse')).toEqual([['.*', 'tool-done']]);
  });

  it('writes one override per mapped event and nothing for compaction or subagents', () => {
    const events = codexHookOverrides(SCRIPT).map((l) => /^hooks\.([A-Za-z]+)=/.exec(l)![1]);
    expect(events).toEqual(CODEX_HOOK_EVENTS.map(([event]) => event));
    // Compaction is mid-turn; a subagent's tools already fire the parent's
    // PreToolUse / PostToolUse.
    for (const absent of ['PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop']) {
      expect(events).not.toContain(absent);
    }
  });

  it('writes each override as the TOML the -c flag parses', () => {
    expect(codexHookOverrides(SCRIPT)[1]).toBe(
      `hooks.SessionEnd=[{hooks=[{type="command",command="'${SCRIPT}' ended"}]}]`,
    );
    expect(codexHookOverrides(SCRIPT)[6]).toBe(
      `hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="'${SCRIPT}' tool-start"}]}]`,
    );
  });

  it('escapes a script path for both the shell and TOML', () => {
    // A quote in the path is `'\''` for sh, whose backslash TOML doubles.
    const [line] = codexHookOverrides("/tmp/it's here/hook.sh");
    expect(line).toContain(`command="'/tmp/it'\\\\''s here/hook.sh' ready"`);
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('lists the overrides one per line, newline-terminated, for the shim to read', () => {
    const file = codexHooksFile(SCRIPT);
    expect(file.endsWith('\n')).toBe(true);
    const lines = file.split('\n').slice(0, -1);
    expect(lines).toEqual(codexHookOverrides(SCRIPT));
    // Distinct keys: the shim may apply them in any order.
    expect(new Set(lines.map((l) => l.split('=')[0])).size).toBe(lines.length);
    expect(CODEX_SHIM_HOOKS_ENV).toBe('DOUBLE0_CODEX_HOOKS');
  });
});

describe('codexHooksFile - instructions', () => {
  it('adds developer_instructions as one line, newlines escaped', () => {
    const file = codexHooksFile('/x/hook.sh', 'line one\nsays "hi"');
    const lines = file.trimEnd().split('\n');
    expect(lines.at(-1)).toBe('developer_instructions="line one\\nsays \\"hi\\""');
    expect(codexHooksFile('/x/hook.sh').includes('developer_instructions')).toBe(false);
  });
});
