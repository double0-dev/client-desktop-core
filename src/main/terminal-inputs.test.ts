import { describe, expect, it } from 'vitest';
import {
  INPUT_OSC,
  MAX_INPUT_ENTRIES,
  MAX_INPUT_TEXT,
  TerminalInputLog,
  inputTag,
  normalizeInput,
  programFromHookJson,
  promptFromHookJson,
  type InputMark,
} from './terminal-inputs';
import { STATUS_OSC } from './claude-status-hooks';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** A raw mark as the shell / hook writes it. */
const osc = (verb: string, payload?: string): string =>
  `\x1b]${INPUT_OSC};${verb}${payload === undefined ? '' : `;${payload}`}\x07`;

/** The marks a chunk carries, with their end indices - what terminal-modes hands over. */
function marksIn(chunk: string): InputMark[] {
  const out: InputMark[] = [];
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\](679[01]);([^;\x07]*)(?:;([^\x07]*))?\x07/g;
  for (const m of chunk.matchAll(re)) {
    out.push({
      code: m[1] as InputMark['code'],
      verb: m[2],
      payload: m[3],
      end: m.index + m[0].length,
    });
  }
  return out;
}

function feed(log: TerminalInputLog, chunk: string, now = 1000) {
  return log.apply(chunk, marksIn(chunk), now);
}

/** A UserPromptSubmit stdin as the CLI writes it (2.1.278 key order, trimmed). */
const hookJson = (prompt: string): string =>
  `{"session_id":"s","transcript_path":"/x.jsonl","cwd":"/repo","prompt_id":"p","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":${JSON.stringify(prompt)}}`;

describe('TerminalInputLog - shell commands', () => {
  it('records a command with its exit status, and tags where it starts and ends', () => {
    const log = new TerminalInputLog();
    const prompt = feed(log, `${osc('ps')}emmaw@acme % `);
    // The prompt is where the command about to be typed starts on screen.
    expect(prompt.data).toBe(`${osc('ps')}${inputTag('at', 1)}emmaw@acme % `);
    expect(prompt.changed).toEqual([]);

    const run = feed(log, `pnpm test\r\n${osc('cmd', b64('pnpm test'))}`, 2000);
    expect(run.data).toBe(`pnpm test\r\n${osc('cmd', b64('pnpm test'))}${inputTag('end', 1)}`);
    expect(run.changed).toMatchObject([
      { seq: 1, kind: 'command', program: 'shell', text: 'pnpm test', exitCode: null, at: 2000 },
    ]);

    const done = feed(log, `FAIL\r\n${osc('done', '1')}${osc('ps')}% `);
    expect(done.changed).toMatchObject([{ seq: 1, exitCode: 1 }]);
    // The next prompt is tagged for the NEXT seq.
    expect(done.data).toContain(`${osc('ps')}${inputTag('at', 2)}`);
    expect(log.list()).toHaveLength(1);
  });

  it('re-tags the same seq after an empty Enter - no entry, no gap', () => {
    const log = new TerminalInputLog();
    feed(log, osc('ps'));
    const again = feed(log, `\r\n${osc('ps')}`);
    expect(again.data).toContain(inputTag('at', 1));
    feed(log, osc('cmd', b64('ls')));
    expect(log.list().map((e) => e.seq)).toEqual([1]);
  });

  it('tags a command without a prompt mark at the command itself', () => {
    // A shell whose first prompt went by before the tags existed (or any gap):
    // the entry still gets a position rather than borrowing a stale one.
    const log = new TerminalInputLog();
    const r = feed(log, osc('cmd', b64('ls')));
    expect(r.data).toBe(`${osc('cmd', b64('ls'))}${inputTag('at', 1)}${inputTag('end', 1)}`);
  });

  it("never lets a command borrow a prompt's tag that another entry took", () => {
    // The prompt was tagged for seq 1, then something else became seq 1: the
    // command after it must place its own start, not rely on that tag.
    const log = new TerminalInputLog();
    feed(log, osc('ps'));
    log.addLine('SELECT 1;', 'psql', 1000, null);
    const r = feed(log, osc('cmd', b64('ls')));
    expect(r.data).toBe(`${osc('cmd', b64('ls'))}${inputTag('at', 2)}${inputTag('end', 2)}`);
  });

  it('gives a done only to the command still running', () => {
    const log = new TerminalInputLog();
    feed(log, `${osc('ps')}${osc('cmd', b64('true'))}`);
    feed(log, `${osc('done', '0')}${osc('ps')}`);
    // A stray done (a prompt redrawn) must not overwrite the recorded status.
    const stray = feed(log, `${osc('done', '130')}`);
    expect(stray.changed).toEqual([]);
    expect(log.list()[0].exitCode).toBe(0);
  });

  it('ignores an empty command line', () => {
    const log = new TerminalInputLog();
    expect(feed(log, osc('cmd', b64('   '))).changed).toEqual([]);
    expect(log.list()).toEqual([]);
  });

  it('splices tags into the right places when one chunk carries several marks', () => {
    const log = new TerminalInputLog();
    const chunk = `a${osc('ps')}b${osc('cmd', b64('ls'))}c${osc('done', '0')}d${osc('ps')}e`;
    const { data } = feed(log, chunk);
    expect(data).toBe(
      `a${osc('ps')}${inputTag('at', 1)}b${osc('cmd', b64('ls'))}${inputTag('end', 1)}c${osc('done', '0')}d${osc('ps')}${inputTag('at', 2)}e`,
    );
  });
});

describe('TerminalInputLog - agent prompts', () => {
  it('records a prompt from the hook payload and tags where it arrived', () => {
    const log = new TerminalInputLog();
    const mark = osc('prompt', b64(hookJson('fix the token refresh flakiness')));
    const r = feed(log, `frame${mark}more`);
    expect(r.data).toBe(`frame${mark}${inputTag('at', 1)}more`);
    expect(r.changed).toMatchObject([
      { seq: 1, kind: 'prompt', program: 'claude', text: 'fix the token refresh flakiness' },
    ]);
  });

  it('files a prompt under the agent its payload names - Codex, OpenCode - else Claude', () => {
    // The hook script under the codex shim wraps Claude's shape; the OpenCode
    // plugin writes its own. Without the key (Claude's verbatim stdin) the
    // program is Claude's, as before.
    const log = new TerminalInputLog();
    feed(log, osc('prompt', b64(`{"program":"codex","hook":${hookJson('fix the build')}`)));
    feed(log, osc('prompt', b64('{"program":"opencode","prompt":"add a test"}')));
    feed(log, osc('prompt', b64(hookJson('and docs'))));
    expect(log.list().map((e) => [e.program, e.text])).toEqual([
      ['codex', 'fix the build'],
      ['opencode', 'add a test'],
      ['claude', 'and docs'],
    ]);
  });

  it('counts the lines of a multi-line prompt', () => {
    const log = new TerminalInputLog();
    feed(log, osc('prompt', b64(hookJson('look at how refreshToken\nhandles skew\nand fix it'))));
    expect(log.list()[0]).toMatchObject({
      text: 'look at how refreshToken\nhandles skew\nand fix it',
      lines: 3,
    });
  });

  it('keeps a prompt the hook cut short, marked truncated', () => {
    // The hook forwards only the head of stdin; the JSON string never closes.
    const json = hookJson('x'.repeat(8000)).slice(0, 4000);
    const log = new TerminalInputLog();
    feed(log, osc('prompt', b64(json)));
    const [entry] = log.list();
    expect(entry.truncated).toBe(true);
    expect(entry.text).toBe('x'.repeat(MAX_INPUT_TEXT));
  });

  it('leaves out the report a background subagent hands back', () => {
    const log = new TerminalInputLog();
    feed(log, osc('prompt', b64(hookJson('<task-notification>\n<task-id>a1</task-id>'))));
    expect(log.list()).toEqual([]);
  });

  it("marks a run's prompts gone when the agent ends or restarts, and only that run's", () => {
    const log = new TerminalInputLog();
    const statusMark = (verb: string): string => `\x1b]${STATUS_OSC};${verb}\x07`;
    feed(log, osc('prompt', b64(hookJson('one'))));
    // /clear fires SessionEnd first: the conversation on screen is gone.
    const ended = feed(log, statusMark('ended'));
    expect(ended.changed).toMatchObject([{ seq: 1, gone: true }]);
    feed(log, osc('prompt', b64(hookJson('two'))));
    expect(log.list().map((e) => [e.text, e.gone])).toEqual([
      ['one', true],
      ['two', false],
    ]);
    // Status verbs never get a tag - they are not inputs.
    expect(feed(log, statusMark('ready')).data).toBe(statusMark('ready'));
    expect(log.list()[1].gone).toBe(true);
  });
});

describe('TerminalInputLog - lines and limits', () => {
  it('records a line the renderer reports, with its program and reference', () => {
    const log = new TerminalInputLog();
    const { entry, tag } = log.addLine('print(1 + 1)', 'python3', 5000, 7);
    expect(entry).toMatchObject({ seq: 1, kind: 'line', program: 'python3', ref: 7, at: 5000 });
    expect(tag).toBe(inputTag('at', 1));
    expect(log.addLine('  ', 'python3', 5001, 8)).toEqual({ entry: null, tag: '' });
  });

  it('keeps the newest MAX_INPUT_ENTRIES', () => {
    const log = new TerminalInputLog();
    for (let i = 0; i < MAX_INPUT_ENTRIES + 5; i++) log.addLine(`cmd ${i}`, 'sh', i, null);
    const list = log.list();
    expect(list).toHaveLength(MAX_INPUT_ENTRIES);
    expect(list[0].text).toBe('cmd 5');
    expect(list.at(-1)!.seq).toBe(MAX_INPUT_ENTRIES + 5);
  });

  it('hands out copies - the list cannot be edited from outside', () => {
    const log = new TerminalInputLog();
    log.addLine('ls', 'sh', 1, null);
    log.list()[0].text = 'rm -rf';
    expect(log.list()[0].text).toBe('ls');
  });
});

describe('promptFromHookJson', () => {
  it('reads the prompt, not prompt_id or a quoted key inside the prompt', () => {
    const text = 'explain {"prompt": "x"} and "quotes"';
    expect(promptFromHookJson(hookJson(text))).toEqual({ text, truncated: false });
  });

  it('decodes every JSON escape, unicode included', () => {
    expect(promptFromHookJson(hookJson('tab\there\\slash/é ✓ 😀'))?.text).toBe(
      'tab\there\\slash/é ✓ 😀',
    );
    expect(promptFromHookJson('{"prompt":"\\u00e9\\ud83d\\ude00"}')?.text).toBe('é😀');
  });

  it('returns null without a prompt key', () => {
    expect(promptFromHookJson('{"session_id":"s","prompt_id":"p"}')).toBeNull();
  });

  it('stops cleanly at a cut escape', () => {
    expect(promptFromHookJson('{"prompt":"abc\\')).toEqual({ text: 'abc', truncated: true });
    expect(promptFromHookJson('{"prompt":"abc\\u00')).toEqual({ text: 'abc', truncated: true });
  });
});

describe('programFromHookJson', () => {
  it('reads the agent a wrapped or plugin-written payload names at its head', () => {
    expect(programFromHookJson('{"program":"codex","hook":{"prompt":"x"}')).toBe('codex');
    expect(programFromHookJson(' {"program" : "opencode", "prompt":"x"}')).toBe('opencode');
  });

  it("is null for Claude's verbatim stdin, and for anything but a plain word", () => {
    expect(programFromHookJson('{"session_id":"s","prompt":"x"}')).toBeNull();
    // Only the head counts: a prompt mentioning the key is text.
    expect(programFromHookJson('{"prompt":"say \\"program\\": \\"x\\""}')).toBeNull();
    // A label goes on screen: no spaces, paths or capitals.
    expect(programFromHookJson('{"program":"my agent","prompt":"x"}')).toBeNull();
    expect(programFromHookJson('{"program":"Codex","prompt":"x"}')).toBeNull();
  });
});

describe('normalizeInput', () => {
  it('drops control characters and trailing blank lines, counts the rest', () => {
    expect(normalizeInput('ls\x1b[31m -la\r\n\n  \n')).toEqual({
      text: 'ls[31m -la',
      lines: 1,
      truncated: false,
    });
    expect(normalizeInput('a\nb\n\nc').lines).toBe(4);
  });
});
