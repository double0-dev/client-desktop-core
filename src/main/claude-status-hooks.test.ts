import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INPUT_OSC,
  MARKER_DIR_ENV,
  MARKER_WRITE_SECONDS,
  PROMPT_PAYLOAD_BYTES,
  STATUS_HOOK_SCRIPT,
  STATUS_OSC,
  USAGE_FILE_ENV,
  claudeStatusSettings,
  gitBashPath,
  windowsClaudeCommand,
} from './claude-status-hooks';
import { CODEX_SESSION_RECORD_ENV, SESSION_RECORD_ENV } from './agent-resume';

type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string }> };
type Settings = { hooks: Record<string, HookEntry[]> };

const SCRIPT = '/tmp/double0-status-hook.sh';

/** `[matcher, verb]` per entry of one event, in declared order. */
function mapping(event: string): Array<[string | undefined, string]> {
  const settings = claudeStatusSettings(SCRIPT) as Settings;
  return (settings.hooks[event] ?? []).map((entry) => {
    expect(entry.hooks).toHaveLength(1);
    const [h] = entry.hooks;
    expect(h.type).toBe('command');
    // The command is the script plus exactly one verb argument.
    const m = /^'([^']+)' ([a-z-]+)$/.exec(h.command);
    expect(m, h.command).not.toBeNull();
    expect(m![1]).toBe(SCRIPT);
    return [entry.matcher, m![2]];
  });
}

/** Cap on one synchronous run of a script under a real `sh` (see `run`). */
const SYNC_RUN_MS = 10_000;

describe('claudeStatusSettings - Claude lifecycle → marker verb', () => {
  it('maps a turn starting / ending to prompt (running + the prompt) / finished', () => {
    expect(mapping('UserPromptSubmit')).toEqual([[undefined, 'prompt']]);
    expect(mapping('Stop')).toEqual([[undefined, 'finished']]);
  });

  it('ends a turn that failed on an API error too', () => {
    // Stop never fires for such a turn; StopFailure does. Unmapped, the session
    // sat on "working" until the next prompt.
    expect(mapping('StopFailure')).toEqual([[undefined, 'finished']]);
  });

  it('maps the blocked-on-you notifications to needs-input, not idle_prompt', () => {
    // idle_prompt = a parked agent, which is idle by spec - never needs-input.
    expect(mapping('Notification')).toEqual([
      ['permission_prompt', 'needs-input'],
      ['agent_needs_input', 'needs-input'],
      ['elicitation_dialog', 'needs-input'],
    ]);
  });

  it('marks needs-input the moment a permission dialog opens', () => {
    // The Notification for a permission prompt arrives ~6s after the dialog;
    // PermissionRequest fires as it opens (verified on CLI 2.1.258) - and
    // right after the PreToolUse that names the tool, so the row can say
    // "Wants to run …" at once. No matcher: every dialog counts.
    // `permission` = the same marker, plus a following view's answer channel.
    expect(mapping('PermissionRequest')).toEqual([[undefined, 'permission']]);
    // Long enough for a person to answer in the view.
    const settings = claudeStatusSettings(SCRIPT) as {
      hooks: { PermissionRequest: Array<{ hooks: Array<{ timeout?: number }> }> };
    };
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBe(600);
  });

  it('maps the agent exiting to ended', () => {
    expect(mapping('SessionEnd')).toEqual([[undefined, 'ended']]);
  });

  it('arms marker mode the moment the agent launches or resumes', () => {
    // Without this, every Claude the app starts (fresh or --resume) sits in
    // the renderer's output/quiet fallback until its first prompt - where the
    // resume transcript reads as work, the 8s quiet window as finishing, and
    // the idle-prompt bell as needs-input (the constant false alerts of
    // 2026-09-02). 'ready' must not fire on clear (finished covers it) or
    // compact (mid-turn).
    expect(mapping('SessionStart')).toContainEqual(['startup|resume', 'ready']);
    expect(mapping('SessionStart').filter(([, verb]) => verb === 'ready')).toEqual([
      ['startup|resume', 'ready'],
    ]);
  });

  it('re-arms marker mode after a /clear, and only after a /clear', () => {
    // `/clear` fires SessionEnd (→ ended → renderer fallback mode) and then
    // SessionStart{source:"clear"}. Without this entry the terminal stays in
    // fallback until the next prompt and Claude's idle bell reads as
    // needs-input. `compact` must NOT be matched: it fires mid-turn, and a
    // 'finished' there would idle a working session.
    expect(mapping('SessionStart')).toContainEqual(['clear', 'finished']);
    expect(mapping('SessionStart').filter(([, verb]) => verb === 'finished')).toEqual([
      ['clear', 'finished'],
    ]);
  });

  it('records the live session id on EVERY SessionStart', () => {
    // `/clear` and an in-Claude `/resume` move the tab to a new session id;
    // relaunching the original after a restart reopens an OLDER conversation.
    // The record must be unmatched so startup/resume/clear/compact all refresh
    // it - a matcher here would silently miss one of the transitions.
    expect(mapping('SessionStart')).toContainEqual([undefined, 'session']);
  });

  it('reports every tool call before and after it runs, questions and plans included', () => {
    // The wildcard entries carry the tool name + argument (the session row's
    // "Editing token.service.ts"); the PostToolUse one is ALSO the heal for a
    // sticky needs-input - tool-done implies running - so no separate
    // 'running' entry is needed there. The specific matchers stay: a
    // question is a needs-input with content, a plan exit a needs-input.
    expect(mapping('PreToolUse')).toEqual([
      ['AskUserQuestion', 'question'],
      ['ExitPlanMode', 'needs-input'],
      ['*', 'tool-start'],
    ]);
    expect(mapping('PostToolUse')).toEqual([
      ['AskUserQuestion', 'question-done'],
      ['*', 'tool-done'],
    ]);
  });
});

describe('STATUS_HOOK_SCRIPT', () => {
  it('always exits 0 and never writes to stdout', () => {
    // A nonzero PreToolUse exit would BLOCK the agent's tool call, and
    // UserPromptSubmit stdout is injected into the conversation as context.
    expect(STATUS_HOOK_SCRIPT.trim().endsWith('exit 0')).toBe(true);
    expect(STATUS_HOOK_SCRIPT).toContain('exec 2>/dev/null');
    // Every printf targets the captured pty device - or, for the session
    // record, the per-tab file - never the inherited stdout.
    // A printf inside a command substitution `$(…)` builds a value (a base64
    // payload), it doesn't print - strip those before judging the line.
    const printfs = STATUS_HOOK_SCRIPT.split('\n')
      .map((l) => l.replace(/\$\((?:[^()]|\([^()]*\))*\)/g, ''))
      .filter((l) => l.includes('printf'));
    expect(printfs.length).toBeGreaterThan(0);
    for (const line of printfs) {
      // The one exception: PermissionRequest's decision, which IS its stdout.
      if (line.includes('"hookEventName":"PermissionRequest"')) continue;
      expect(line).toMatch(/> "\$(out|record|record\.(?:transcript|pid)|req\.tmp)"(?: |$)/);
    }
    // And no echo at all: /bin/sh's echo rewrites the `\n` escapes inside a
    // JSON value into real newlines (xpg_echo), mangling multi-line commands.
    expect(STATUS_HOOK_SCRIPT).not.toMatch(/\becho\b/);
  });

  it('emits the private OSC the renderer scans for', () => {
    expect(STATUS_HOOK_SCRIPT).toContain(`\\033]${STATUS_OSC};%s\\007`);
    expect(STATUS_OSC).toBe('6790');
  });
});

describe.skipIf(process.platform === 'win32')('STATUS_HOOK_SCRIPT under a real sh', () => {
  const ID = '08d219a2-2b4f-46e3-a0d7-b9b5d2e857ad';
  // The shape Claude Code hands SessionStart hooks on stdin (from a live probe).
  const START = `{"session_id":"${ID}","transcript_path":"/x/${ID}.jsonl","cwd":"/x","hook_event_name":"SessionStart","source":"clear"}`;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'double0-hook-'));
    writeFileSync(join(dir, 'hook.sh'), STATUS_HOOK_SCRIPT, 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Every synchronous run is capped: `spawnSync` blocks the worker's event
  // loop, so a stuck child (a 200 KB stdin write and the hook's `cat` both
  // left waiting on the pipe, seen once on a loaded Mac) would otherwise hang
  // the whole run - the test timeout can never fire.
  const run = (verb: string, input: string, env: Record<string, string>) =>
    spawnSync('sh', [join(dir, 'hook.sh'), verb], {
      input,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DOUBLE0_TTY: '/dev/null', ...env },
      encoding: 'utf8',
      timeout: SYNC_RUN_MS,
    });

  it('records the session id from a SessionStart payload, bare, to the named file', () => {
    const record = join(dir, 'record');
    const r = run('session', START, { DOUBLE0_SESSION_FILE: record });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(readFileSync(record, 'utf8')).toBe(ID);
  });

  it("records the transcript's path next to the session id", () => {
    const record = join(dir, 'record');
    run('session', START, { DOUBLE0_SESSION_FILE: record });
    expect(readFileSync(`${record}.transcript`, 'utf8')).toBe(`/x/${ID}.jsonl`);
    // Not a transcript path: nothing.
    rmSync(`${record}.transcript`);
    run('session', START.replace(`/x/${ID}.jsonl`, 'relative.txt'), {
      DOUBLE0_SESSION_FILE: record,
    });
    expect(existsSync(`${record}.transcript`)).toBe(false);
  });

  it("records Claude's pid - the hook's parent - next to the session id", () => {
    const record = join(dir, 'record');
    run('session', START, { DOUBLE0_SESSION_FILE: record });
    // Here the parent is this test's node (spawnSync runs sh directly).
    expect(readFileSync(`${record}.pid`, 'utf8')).toBe(String(process.pid));
  });

  it('overwrites an earlier record - the tab moved on', () => {
    const record = join(dir, 'record');
    writeFileSync(record, 'b7ea93b3-832f-4164-8d30-02b3dce74356', 'utf8');
    run('session', START, { DOUBLE0_SESSION_FILE: record });
    expect(readFileSync(record, 'utf8')).toBe(ID);
  });

  it('records a Codex thread in the Codex record, never the Claude one', () => {
    // The tab's next `claude` resumes whatever the Claude record names: a
    // Codex thread id there would be a conversation that does not exist.
    const claude = join(dir, 'record');
    const codex = join(dir, 'codex-record');
    const thread = '019fe258-58f5-78c3-b609-73aaebe1ac82';
    const r = run(
      'session',
      `{"session_id":"${thread}","transcript_path":"/c/sessions/rollout-x-${thread}.jsonl","source":"startup"}`,
      { DOUBLE0_SESSION_FILE: claude, DOUBLE0_CODEX_SESSION_FILE: codex, DOUBLE0_AGENT: 'codex' },
    );
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(existsSync(claude)).toBe(false);
    expect(readFileSync(codex, 'utf8')).toBe(thread);
    expect(readFileSync(`${codex}.transcript`, 'utf8')).toBe(
      `/c/sessions/rollout-x-${thread}.jsonl`,
    );
    expect(readFileSync(`${codex}.pid`, 'utf8')).toBe(String(process.pid));
  });

  it('spells the record variables as agent-resume.ts names them', () => {
    expect(STATUS_HOOK_SCRIPT).toContain(`\${${SESSION_RECORD_ENV}:-}`);
    expect(STATUS_HOOK_SCRIPT).toContain(`\${${CODEX_SESSION_RECORD_ENV}:-}`);
  });

  // Windows (a ConPTY has no device to write to): each invocation's markers
  // go to a file of their own in the marker folder, published by a rename.
  describe('with a marker folder (Windows)', () => {
    const markers = () => join(dir, 'markers');
    const published = () =>
      readdirSync(markers())
        .sort()
        .map((n) => ({ name: n, text: readFileSync(join(markers(), n), 'utf8') }));

    beforeEach(() => mkdirSync(markers()));

    it('writes each marker to a published file of its own, never to stdout', () => {
      const env = { [MARKER_DIR_ENV]: markers(), DOUBLE0_TTY: '' };
      expect(run('running', '', env)).toMatchObject({ status: 0, stdout: '' });
      expect(run('finished', '{}', env)).toMatchObject({ status: 0, stdout: '' });
      const files = published();
      // Order is the stamp's job, and only Windows' `date` has nanoseconds:
      // here two files can share a second, so compare as a set.
      expect(files.map((f) => f.text).sort()).toEqual(
        [`\x1b]${STATUS_OSC};finished\x07`, `\x1b]${STATUS_OSC};running\x07`].sort(),
      );
      for (const f of files) expect(f.name).toMatch(/^\d+-\d+\.m$/);
    });

    it('publishes a permission marker before it waits for a view answer', () => {
      const record = join(dir, 'record');
      mkdirSync(`${record}.ask`);
      const child = spawn('sh', [join(dir, 'hook.sh'), 'permission'], {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          [MARKER_DIR_ENV]: markers(),
          DOUBLE0_SESSION_FILE: record,
        },
      });
      child.stdin.end('{"tool_name":"Bash"}');
      return vi
        .waitFor(() => {
          expect(published().map((f) => f.text)).toEqual([`\x1b]${STATUS_OSC};needs-input\x07`]);
        })
        .finally(() => child.kill());
    });

    it('writes no marker file when there is nothing to say', () => {
      // A tool-start without a tool name prints nothing: no empty file either.
      run('tool-start', '{}', { [MARKER_DIR_ENV]: markers() });
      expect(readdirSync(markers())).toEqual([]);
    });

    it("records a Windows transcript path unescaped, and no pid (msys can't see Claude)", () => {
      const record = join(dir, 'record');
      const winPath = `C:\\\\Users\\\\emmaw\\\\.claude\\\\projects\\\\C--acme\\\\${ID}.jsonl`;
      run('session', START.replace(`/x/${ID}.jsonl`, winPath), {
        DOUBLE0_SESSION_FILE: record,
        [MARKER_DIR_ENV]: markers(),
      });
      expect(readFileSync(record, 'utf8')).toBe(ID);
      expect(readFileSync(`${record}.transcript`, 'utf8')).toBe(
        `C:\\Users\\emmaw\\.claude\\projects\\C--acme\\${ID}.jsonl`,
      );
      expect(existsSync(`${record}.pid`)).toBe(false);
      expect(readdirSync(markers())).toEqual([]);
    });
  });

  it('records nothing for an unpinned launch or a payload without a uuid', () => {
    const record = join(dir, 'record');
    expect(run('session', START, {}).status).toBe(0);
    expect(existsSync(record)).toBe(false);
    run('session', '{"session_id":"garbage"}', { DOUBLE0_SESSION_FILE: record });
    expect(existsSync(record)).toBe(false);
  });

  it("removes the tab's status line capture when Claude exits, not when a session merely ends", () => {
    // Back at the shell prompt the status bar must stop naming the account.
    // `/clear` and an in-Claude `/resume` end a session in a CLI that runs on.
    const usage = join(dir, 'conversation%3Aabc.usage');
    const env = { DOUBLE0_TTY: join(dir, 'tty'), [USAGE_FILE_ENV]: usage };
    const end = (reason: string) =>
      run('ended', `{"hook_event_name":"SessionEnd","reason":"${reason}"}`, env);
    for (const reason of ['clear', 'resume']) {
      writeFileSync(usage, 'capture');
      expect(end(reason)).toMatchObject({ status: 0, stdout: '' });
      expect(existsSync(usage)).toBe(true);
      expect(readFileSync(join(dir, 'tty'), 'utf8')).toBe(`\x1b]${STATUS_OSC};ended\x07`);
    }
    for (const reason of ['prompt_input_exit', 'logout', 'other']) {
      writeFileSync(usage, 'capture');
      expect(end(reason)).toMatchObject({ status: 0, stdout: '' });
      expect(existsSync(usage)).toBe(false);
    }
    // No capture file to remove: still quiet, still exit 0.
    expect(run('ended', '{"reason":"other"}', {})).toMatchObject({ status: 0, stdout: '' });
  });

  it("leaves a Codex tab's capture alone - its pid, not this hook, says when the CLI is gone", () => {
    // A Codex SessionEnd may be a /new, not an exit; the capture carries the
    // CLI's pid, and its reader drops it once that has exited.
    const usage = join(dir, 'conversation%3Aabc.usage');
    writeFileSync(usage, 'capture');
    const r = run('ended', '{"hook_event_name":"SessionEnd","reason":"other"}', {
      DOUBLE0_TTY: join(dir, 'tty'),
      [USAGE_FILE_ENV]: usage,
      DOUBLE0_AGENT: 'codex',
    });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(existsSync(usage)).toBe(true);
    expect(readFileSync(join(dir, 'tty'), 'utf8')).toBe(`\x1b]${STATUS_OSC};ended\x07`);
  });

  it('keeps the other verbs off the record file', () => {
    const record = join(dir, 'record');
    const r = run('finished', '{}', { DOUBLE0_SESSION_FILE: record });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(record)).toBe(false);
  });

  // A FIFO nobody reads blocks open() for writing, exactly as the device of
  // a pty that hung up does (a closed tab): the hook and the agent waiting on
  // it used to hang there for good (2026-11-05).
  it('gives up on a marker the pty never takes, and still exits 0', () => {
    const fifo = join(dir, 'fifo');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    // The real timeout is 10 s; the same script with a 1 s one.
    writeFileSync(
      join(dir, 'quick.sh'),
      STATUS_HOOK_SCRIPT.replace(`sleep ${MARKER_WRITE_SECONDS} <`, 'sleep 1 <'),
      'utf8',
    );
    const started = Date.now();
    const r = spawnSync('sh', [join(dir, 'quick.sh'), 'ended'], {
      input: '{"reason":"other"}',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DOUBLE0_TTY: fifo },
      encoding: 'utf8',
      timeout: 8000,
    });
    expect(r.error).toBeUndefined(); // not killed by the 8 s cap above
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('writes to a live pty at once, leaving no sleep behind', () => {
    // A first version raced: the timer's `sleep` outlived the hook on almost
    // every call. A duration no other process uses makes a stray findable.
    const seconds = 4000 + (process.pid % 997);
    writeFileSync(
      join(dir, 'odd.sh'),
      STATUS_HOOK_SCRIPT.replace(`sleep ${MARKER_WRITE_SECONDS} <`, `sleep ${seconds} <`),
      'utf8',
    );
    const started = Date.now();
    for (let i = 0; i < 20; i++) {
      const r = spawnSync('sh', [join(dir, 'odd.sh'), 'ended'], {
        input: '{"reason":"other"}',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DOUBLE0_TTY: join(dir, 'tty') },
        encoding: 'utf8',
        timeout: SYNC_RUN_MS,
      });
      expect(r.status).toBe(0);
    }
    expect(marker()).toEqual({ verb: 'ended', payload: null });
    expect(Date.now() - started).toBeLessThan(8000);
    const strays = spawnSync('pgrep', ['-f', `^sleep ${seconds}$`], { encoding: 'utf8' });
    expect(strays.stdout.trim()).toBe('');
  });

  // The marker the script wrote to the pty device (here: a file), decoded.
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const marker = (): { verb: string; payload: string | null } | null => {
    const tty = join(dir, 'tty');
    if (!existsSync(tty)) return null;
    const m = new RegExp(`^${ESC}\\]${STATUS_OSC};([a-z-]+)(?:;([^${BEL}]*))?${BEL}$`).exec(
      readFileSync(tty, 'utf8'),
    );
    return m ? { verb: m[1], payload: m[2] ?? null } : null;
  };
  const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');
  const runToTty = (verb: string, input: string) =>
    run(verb, input, { DOUBLE0_TTY: join(dir, 'tty') });

  // Real PreToolUse / PostToolUse / Notification payloads from a live probe
  // (Claude Code 2.1.258), trimmed to the fields the script reads.
  const WRITE_PRE =
    '{"session_id":"x","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"/repo/work/hello.txt","content":"hello"},"tool_use_id":"toolu_1"}';
  const BASH_POST =
    '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls -la /repo/work","description":"List files"},"tool_response":{"stdout":"total 40\\n{\\"command\\": \\"not this one\\"}","stderr":""},"tool_use_id":"toolu_2"}';
  const PERMISSION =
    '{"hook_event_name":"Notification","message":"Claude needs your permission","notification_type":"permission_prompt","title":"Claude Code"}';

  it('opens the turn and forwards the head of the prompt payload, base64', () => {
    const json = `{"session_id":"s","hook_event_name":"UserPromptSubmit","prompt":"fix the flaky test\\nplease"}`;
    const r = runToTty('prompt', json);
    expect(r).toMatchObject({ status: 0, stdout: '' });
    const written = readFileSync(join(dir, 'tty'), 'utf8');
    const m = new RegExp(
      `^${ESC}\\]${STATUS_OSC};running${BEL}${ESC}\\]${INPUT_OSC};prompt;([A-Za-z0-9+/=]+)${BEL}$`,
    ).exec(written);
    expect(m, written).not.toBeNull();
    expect(decode(m![1])).toBe(json);
  });

  it('files the prompt under the CLI that ran the hook, when one is named', () => {
    // The `codex` shim exports DOUBLE0_AGENT: the Inputs list must not call
    // a Codex prompt "Claude Code". Claude's own payload stays verbatim.
    const json = `{"session_id":"s","hook_event_name":"UserPromptSubmit","prompt":"fix it"}`;
    const r = run('prompt', json, { DOUBLE0_TTY: join(dir, 'tty'), DOUBLE0_AGENT: 'codex' });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    const payload = new RegExp(`;prompt;([^${BEL}]+)${BEL}`).exec(
      readFileSync(join(dir, 'tty'), 'utf8'),
    )![1];
    expect(decode(payload)).toBe(`{"program":"codex","hook":${json}`);
  });

  it('caps a long prompt and still reads all of stdin', () => {
    // Claude writes the whole JSON; a hook that stopped reading early would
    // leave it writing into a closed pipe.
    const json = `{"prompt":"${'x'.repeat(200_000)}"}`;
    const r = runToTty('prompt', json);
    expect(r).toMatchObject({ status: 0, stdout: '' });
    const payload = new RegExp(`;prompt;([^${BEL}]+)${BEL}`).exec(
      readFileSync(join(dir, 'tty'), 'utf8'),
    )![1];
    expect(decode(payload)).toBe(json.slice(0, PROMPT_PAYLOAD_BYTES));
  });

  it('forwards a tool call as its name and headline argument', () => {
    const r = runToTty('tool-start', WRITE_PRE);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const m = marker();
    expect(m?.verb).toBe('tool-start');
    expect(decode(m!.payload!)).toBe('Write\n/repo/work/hello.txt\n');
  });

  it('reads the FIRST occurrence of a key - tool_input, not a tool_response that echoes it', () => {
    runToTty('tool-done', BASH_POST);
    expect(decode(marker()!.payload!)).toBe('Bash\nls -la /repo/work\n');
  });

  it('keeps an escaped newline in a command literal (no echo mangling)', () => {
    runToTty('tool-start', '{"tool_name":"Bash","tool_input":{"command":"cd x \\nls"}}');
    expect(decode(marker()!.payload!)).toBe('Bash\ncd x \\nls\n');
  });

  it('cuts a value at its first escaped quote and caps each line', () => {
    runToTty('tool-start', '{"tool_name":"Bash","tool_input":{"command":"echo \\"hi\\""}}');
    expect(decode(marker()!.payload!)).toBe('Bash\necho \\\n');
    const long = 'x'.repeat(500);
    runToTty('tool-start', `{"tool_name":"Read","tool_input":{"file_path":"${long}"}}`);
    expect(decode(marker()!.payload!)).toBe(`Read\n${'x'.repeat(300)}\n`);
  });

  it('falls back through the argument keys, and to none', () => {
    runToTty(
      'tool-start',
      '{"tool_name":"Grep","tool_input":{"pattern":"refreshToken","path":"src"}}',
    );
    expect(decode(marker()!.payload!)).toBe('Grep\nrefreshToken\n');
    runToTty('tool-start', '{"tool_name":"TodoWrite","tool_input":{"todos":[]}}');
    expect(decode(marker()!.payload!)).toBe('TodoWrite\n\n');
  });

  it('emits nothing for a payload without a tool name', () => {
    const r = runToTty('tool-done', '{"hook_event_name":"PostToolUse"}');
    expect(r.status).toBe(0);
    expect(marker()).toBeNull();
  });

  it('carries the notification message with needs-input, bare when there is none', () => {
    runToTty('needs-input', PERMISSION);
    const m = marker();
    expect(m?.verb).toBe('needs-input');
    expect(decode(m!.payload!)).toBe('Claude needs your permission');
    runToTty('needs-input', '{"hook_event_name":"PreToolUse","tool_name":"ExitPlanMode"}');
    expect(marker()).toEqual({ verb: 'needs-input', payload: null });
  });

  // A background subagent's Bash call, as the parent's PreToolUse hook sees it
  // (Claude Code 2.1.278): the CLI adds agent_id / agent_type ahead of the tool.
  const SUBAGENT_PRE =
    '{"session_id":"x","cwd":"/repo","permission_mode":"auto","agent_id":"ad5e11b915155e5fa","agent_type":"general-purpose","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls -la","description":"List files"},"tool_use_id":"toolu_3"}';

  it("tags a subagent's tool call with its agent type, the main agent's own stays untagged", () => {
    runToTty('tool-start', SUBAGENT_PRE);
    expect(decode(marker()!.payload!)).toBe('Bash\nls -la\ngeneral-purpose\n');
    runToTty(
      'tool-done',
      SUBAGENT_PRE.replace('"agent_type":"general-purpose"', '"agent_type":""'),
    );
    expect(decode(marker()!.payload!)).toBe('Bash\nls -la\nagent\n');
    // No agent_id: two lines, exactly as before.
    runToTty('tool-start', WRITE_PRE);
    expect(decode(marker()!.payload!)).toBe('Write\n/repo/work/hello.txt\n');
  });

  it('is not fooled by an agent_id mentioned inside the tool input', () => {
    // A prompt that quotes the key is an escaped string, not a field.
    runToTty(
      'tool-start',
      '{"tool_name":"Agent","tool_input":{"prompt":"the payload has \\"agent_id\\": \\"x\\" in it","description":"Probe"}}',
    );
    expect(decode(marker()!.payload!)).toBe('Agent\nProbe\n');
  });

  it("does not tag the main agent's call whose tool takes an agent_id parameter", () => {
    // A real, unescaped field INSIDE tool_input (an MCP tool's parameter). Read
    // from anywhere, it tagged the main agent's call as a subagent's, and the
    // renderer then skipped it as the heal for a sticky needs-input.
    runToTty(
      'tool-done',
      '{"session_id":"x","permission_mode":"auto","hook_event_name":"PostToolUse","tool_name":"mcp__tracker__assign","tool_input":{"agent_id":"svc-7","agent_type":"triage","query":"open bugs"},"tool_response":{}}',
    );
    expect(decode(marker()!.payload!)).toBe('mcp__tracker__assign\nopen bugs\n');
  });

  // Stop payloads from a live probe (Claude Code 2.1.278): the main agent's
  // turn ends while the background subagent it launched still works, and a
  // later one once nothing is left.
  const STOP_BG_AGENT =
    '{"session_id":"x","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"I started the background agent.","background_tasks":[{"id":"ad5e11b915155e5fa","type":"subagent","status":"running","description":"Run ls and date","agent_type":"general-purpose"}],"session_crons":[]}';
  const STOP_DONE =
    '{"session_id":"x","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"39","background_tasks":[],"session_crons":[]}';

  it('holds the finished marker while a background subagent is still working', () => {
    // The bug: Stop → finished → "session finished" alert while the subagent
    // runs on, then its next tool flipped the row back to running - a loop
    // per background agent. The subagent's hand-back re-invokes the main
    // agent (a fresh UserPromptSubmit / Stop), so nothing is lost by waiting.
    const r = runToTty('finished', STOP_BG_AGENT);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(marker()).toBeNull();
  });

  it("holds it whatever the task's description says, and in either key order", () => {
    // The description is the agent's free text. A bracket-scoped match ended
    // at the first `]` or `}` inside it, missed the running subagent and
    // brought the false "finished" alert back.
    const withTasks = (tasks: string): string =>
      STOP_DONE.replace('"background_tasks":[]', `"background_tasks":${tasks}`);
    for (const tasks of [
      '[{"id":"a1","type":"subagent","status":"running","description":"Fix [urgent] bug"}]',
      '[{"id":"a1","type":"subagent","status":"running","description":"Map {a} to ]["}]',
      '[{"id":"a1","type":"subagent","status":"running","usage":{"tokens":3},"description":"x"}]',
      '[{"id":"a0","type":"subagent","status":"completed","description":"Done]"},{"id":"a1","type":"subagent","status":"running","description":"y"}]',
      '[{"id":"a1","status":"running","type":"subagent","description":"Reordered"}]',
      '[\n  {\n    "id": "a1",\n    "type": "subagent",\n    "status": "running"\n  }\n]',
    ]) {
      runToTty('finished', withTasks(tasks));
      expect(marker(), tasks).toBeNull();
    }
  });

  it('is not fooled by the task shape quoted inside a message', () => {
    // An escaped copy of the pair in the agent's last message is text, not a
    // running task: the turn really finished.
    runToTty(
      'finished',
      STOP_DONE.replace(
        '"last_assistant_message":"39"',
        '"last_assistant_message":"the hook sees \\"type\\":\\"subagent\\",\\"status\\":\\"running\\" there"',
      ),
    );
    expect(marker()).toEqual({ verb: 'finished', payload: null });
  });

  it('finishes once the background work is gone, or when only a shell runs on', () => {
    runToTty('finished', STOP_DONE);
    expect(marker()).toEqual({ verb: 'finished', payload: null });
    rmSync(join(dir, 'tty'));
    // A background shell (a dev server) never re-invokes the agent - holding
    // finished for it would pin the session active for good.
    runToTty(
      'finished',
      STOP_DONE.replace(
        '"background_tasks":[]',
        '"background_tasks":[{"id":"b1","type":"shell","status":"running","description":"pnpm dev"}]',
      ),
    );
    expect(marker()).toEqual({ verb: 'finished', payload: null });
    rmSync(join(dir, 'tty'));
    // A subagent that already completed does not count either.
    runToTty(
      'finished',
      STOP_DONE.replace(
        '"background_tasks":[]',
        '"background_tasks":[{"id":"a1","type":"subagent","status":"completed","description":"Done","agent_type":"Explore"}]',
      ),
    );
    expect(marker()).toEqual({ verb: 'finished', payload: null });
  });

  it('finishes on a /clear SessionStart and on a payload without a task list', () => {
    runToTty('finished', START);
    expect(marker()).toEqual({ verb: 'finished', payload: null });
    rmSync(join(dir, 'tty'));
    runToTty('finished', '{}');
    expect(marker()).toEqual({ verb: 'finished', payload: null });
  });
});

describe.skipIf(process.platform === 'win32')('the `permission` verb under a real sh', () => {
  // A live PermissionRequest payload (CLI 2.1.289), trimmed: no tool_use_id.
  const REQUEST =
    '{"session_id":"s","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"node -e 1"},"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"node -e 1"}],"behavior":"allow","destination":"localSettings"}]}';
  let dir: string;
  let record: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'double0-perm-'));
    writeFileSync(join(dir, 'hook.sh'), STATUS_HOOK_SCRIPT, 'utf8');
    record = join(dir, 'record');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Run the verb; resolves with its stdout once it exits. */
  const start = (
    hold = false,
    verb = 'permission',
    extraEnv: Record<string, string> = {},
    input = REQUEST,
  ) => {
    const child = spawn('sh', [join(dir, 'hook.sh'), verb], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        DOUBLE0_TTY: join(dir, 'tty'),
        DOUBLE0_SESSION_FILE: record,
        ...extraEnv,
      },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    const done = new Promise<{ code: number | null; stdout: string }>((resolve) =>
      child.on('exit', (code) => resolve({ code, stdout })),
    );
    // `hold`: the hook waits on its stdin until `release` - a test can set
    // the stage before the hook acts.
    const release = () => child.stdin.end(input);
    if (!hold) release();
    return { child, done, release };
  };
  const pendingRequest = async (): Promise<string> => {
    let found: string | undefined;
    await vi.waitFor(() => {
      found = readdirSync(`${record}.ask`).find((n) => n.endsWith('.req'));
      expect(found).toBeDefined();
    });
    return join(`${record}.ask`, found!);
  };

  it('marks needs-input and answers nothing when no view follows the tab', async () => {
    const { done } = start();
    expect(await done).toEqual({ code: 0, stdout: '' });
    expect(readFileSync(join(dir, 'tty'), 'utf8')).toBe(`\x1b]${STATUS_OSC};needs-input\x07`);
  });

  it("files the request under its pid and prints the view's answer as the decision", async () => {
    mkdirSync(`${record}.ask`);
    const { child, done } = start();
    const req = await pendingRequest();
    expect(req.endsWith(`${child.pid}.req`)).toBe(true);
    expect(readFileSync(req, 'utf8')).toBe(REQUEST);
    writeFileSync(req.replace(/\.req$/, '.ans'), 'allow\n');
    const { code, stdout } = await done;
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(readdirSync(`${record}.ask`)).toEqual([]);
  });

  it('adds the rules with an always-allow, and denies with a reason', async () => {
    mkdirSync(`${record}.ask`);
    const rules =
      '[{"type":"addRules","rules":[{"toolName":"Bash"}],"behavior":"allow","destination":"localSettings"}]';
    let run = start();
    writeFileSync((await pendingRequest()).replace(/\.req$/, '.ans'), `always\n${rules}\n`);
    expect(JSON.parse((await run.done).stdout).hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedPermissions: JSON.parse(rules),
    });
    run = start();
    writeFileSync((await pendingRequest()).replace(/\.req$/, '.ans'), 'deny');
    expect(JSON.parse((await run.done).stdout).hookSpecificOutput.decision).toMatchObject({
      behavior: 'deny',
    });
  });

  it("passes an answered question's input back as updatedInput", async () => {
    mkdirSync(`${record}.ask`);
    const run = start();
    const input = {
      questions: [{ question: 'Which color?' }],
      answers: { 'Which color?': 'Blue' },
    };
    writeFileSync(
      (await pendingRequest()).replace(/\.req$/, '.ans'),
      `answer\n${JSON.stringify(input)}\n`,
    );
    expect(JSON.parse((await run.done).stdout).hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedInput: input,
    });
  });

  it('asks the view from the old needs-input verb too (a Claude launched before `permission`), never for Codex', async () => {
    mkdirSync(`${record}.ask`);
    const run = start(false, 'needs-input');
    writeFileSync((await pendingRequest()).replace(/\.req$/, '.ans'), 'allow\n');
    expect(JSON.parse((await run.done).stdout).hookSpecificOutput.decision.behavior).toBe('allow');
    expect(readFileSync(join(dir, 'tty'), 'utf8')).toContain(`${STATUS_OSC};needs-input`);
    // Codex maps its PermissionRequest to needs-input as well: left alone.
    const codex = start(false, 'needs-input', { DOUBLE0_AGENT: 'codex' });
    expect(await codex.done).toEqual({ code: 0, stdout: '' });
    // A Notification is no request.
    const note = start(
      false,
      'needs-input',
      {},
      '{"hook_event_name":"Notification","message":"hi"}',
    );
    expect(await note.done).toEqual({ code: 0, stdout: '' });
    expect(readdirSync(`${record}.ask`)).toEqual([]);
  });

  it("asks a Codex tab's view through the Codex record", async () => {
    const codex = join(dir, 'codex-record');
    mkdirSync(`${codex}.ask`);
    // The Claude record's folder exists too: Codex must not file there.
    mkdirSync(`${record}.ask`);
    const run = start(false, 'permission', {
      DOUBLE0_AGENT: 'codex',
      DOUBLE0_CODEX_SESSION_FILE: codex,
    });
    let found: string | undefined;
    await vi.waitFor(() => {
      found = readdirSync(`${codex}.ask`).find((n) => n.endsWith('.req'));
      expect(found).toBeDefined();
    });
    expect(readdirSync(`${record}.ask`)).toEqual([]);
    writeFileSync(join(`${codex}.ask`, found!.replace(/\.req$/, '.ans')), 'deny\n');
    // Codex reads Claude's decision shape (0.160.0): behavior + message only.
    expect(JSON.parse((await run.done).stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'The user declined this in double0.' },
      },
    });
  });

  it('ignores an answer left over from an earlier hook with the same pid', async () => {
    mkdirSync(`${record}.ask`);
    const run = start(true);
    // Written before this hook filed its request: removed, never read.
    writeFileSync(join(`${record}.ask`, `${run.child.pid}.ans`), 'allow\n');
    run.release();
    const req = await pendingRequest();
    expect(existsSync(req.replace(/\.req$/, '.ans'))).toBe(false);
    writeFileSync(req.replace(/\.req$/, '.ans'), 'deny');
    expect(JSON.parse((await run.done).stdout).hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('gives up silently when main withdraws the request, and tidies up when killed', async () => {
    mkdirSync(`${record}.ask`);
    let run = start();
    rmSync(await pendingRequest());
    expect(await run.done).toEqual({ code: 0, stdout: '' });
    // Claude kills the hook when its own dialog is answered first.
    run = start();
    await pendingRequest();
    run.child.kill('SIGTERM');
    expect((await run.done).stdout).toBe('');
    await vi.waitFor(() => expect(readdirSync(`${record}.ask`)).toEqual([]));
  });
});

describe('the injected status line', () => {
  it('is left out unless asked for, so the hook mapping alone never takes the slot', () => {
    expect('statusLine' in (claudeStatusSettings(SCRIPT) as object)).toBe(false);
  });

  it("carries an extension's status line entry as given", () => {
    const line = { type: 'command', command: "'/tmp/gadget-line.sh'", padding: 2 };
    expect((claudeStatusSettings(SCRIPT, line) as { statusLine: unknown }).statusLine).toEqual(
      line,
    );
  });
});

describe("claudeStatusSettings - an extension's agent tools", () => {
  it('allows their commands and adds their instructions to every session start', () => {
    const plain = claudeStatusSettings(SCRIPT) as Record<string, unknown>;
    expect(plain.permissions).toBeUndefined();
    const s = claudeStatusSettings(SCRIPT, undefined, {
      instructionsPath: '/x/gadget-instructions.md',
      allow: ['Bash(gadget:*)'],
    }) as {
      permissions: { allow: string[] };
      hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    };
    expect(s.permissions.allow).toEqual(['Bash(gadget:*)']);
    const last = s.hooks.SessionStart.at(-1)!;
    expect(last.matcher).toBeUndefined();
    expect(last.hooks[0].command).toBe("cat '/x/gadget-instructions.md'");
  });
});

describe('Windows launch', () => {
  const has =
    (...paths: string[]) =>
    (p: string): boolean =>
      paths.includes(p);

  it('finds the Git Bash beside a git.exe on PATH (Git\\cmd and Git\\bin)', () => {
    const bash = 'D:\\Tools\\Git\\bin\\bash.exe';
    expect(
      gitBashPath(
        { Path: 'C:\\Windows\\System32;D:\\Tools\\Git\\cmd\\' },
        has('D:\\Tools\\Git\\cmd\\git.exe', bash),
      ),
    ).toBe(bash);
    expect(
      gitBashPath({ PATH: 'D:\\Tools\\Git\\bin' }, has('D:\\Tools\\Git\\bin\\git.exe', bash)),
    ).toBe(bash);
  });

  it('falls back to the default install, and honours the override Claude Code reads', () => {
    const installed = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(gitBashPath({ ProgramFiles: 'C:\\Program Files' }, has(installed))).toBe(installed);
    expect(
      gitBashPath(
        { CLAUDE_CODE_GIT_BASH_PATH: 'E:\\git\\bash.exe', ProgramFiles: 'C:\\Program Files' },
        has('E:\\git\\bash.exe', installed),
      ),
    ).toBe('E:\\git\\bash.exe');
  });

  // No Git Bash = Claude Code runs the status line in PowerShell, which would
  // print the script's path as the status line instead of running it.
  it('answers null when Claude Code would fall back to PowerShell', () => {
    expect(gitBashPath({ Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, has())).toBe(
      null,
    );
    // A stale override is what Claude Code itself trusts - no guessing past it.
    expect(
      gitBashPath(
        { CLAUDE_CODE_GIT_BASH_PATH: 'E:\\gone\\bash.exe', ProgramFiles: 'C:\\Program Files' },
        has('C:\\Program Files\\Git\\bin\\bash.exe'),
      ),
    ).toBe(null);
  });

  it('adds the settings flag with a forward-slash path both Windows shells read', () => {
    expect(
      windowsClaudeCommand(
        'claude --model opus',
        'C:\\Users\\Emma Wilson\\AppData\\Local\\Temp\\double0-claude-usage-settings.json',
      ),
    ).toBe(
      'claude --settings "C:/Users/Emma Wilson/AppData/Local/Temp/double0-claude-usage-settings.json" --model opus',
    );
    expect(windowsClaudeCommand('claude', 'C:\\t\\s.json')).toBe('claude --settings "C:/t/s.json"');
  });
});
