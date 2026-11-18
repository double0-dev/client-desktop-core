import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPENCODE_CONFIG_ENV,
  OPENCODE_STATUS_PLUGIN,
  opencodeConfigContent,
  opencodeConfigExport,
} from './opencode-status-plugin';
import { OPENCODE_SESSION_RECORD_ENV } from './agent-resume';
import {
  INPUT_OSC,
  PROMPT_PAYLOAD_BYTES,
  STATUS_OSC,
  STATUS_OWNER_ENV,
} from './claude-status-hooks';
import { programFromHookJson, promptFromHookJson } from './terminal-inputs';

/**
 * The plugin is exercised under a REAL node (as OpenCode runs it under Bun):
 * a harness imports the generated file, calls its hooks with the event
 * shapes a live OpenCode 1.17.20 handed the probe (scripts/probe-opencode-
 * hooks.py), and the markers it wrote to the "pty" (a file) are decoded.
 * After the steps the harness records the status-owner variable as the
 * plugin's process sees it and as a child shell inherits it (`env.out`).
 */

const HARNESS = `import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [plugin, script, envOut, ...cli] = process.argv.slice(2)
// As OpenCode's own process sees it: its binary, then the user's arguments.
process.argv = [process.argv[0], 'opencode', ...cli]
const mod = await import(pathToFileURL(plugin).href)
const hooks = await mod.DoubleZeroStatus({ directory: '/acme/production-pipeline' })
for (const step of JSON.parse(readFileSync(script, 'utf8'))) {
  // A nested plugin installs no hooks at all.
  await hooks[step.hook]?.(...step.args)
}
const child = spawnSync('sh', ['-c', 'printf %s "$${STATUS_OWNER_ENV}"'], { encoding: 'utf8' }).stdout
writeFileSync(envOut, (process.env.${STATUS_OWNER_ENV} ?? '') + '\\n' + child)
`;

type Step = { hook: string; args: unknown[] };
type Marker = { code: string; verb: string; payload: string | null };

const MAIN = 'ses_efd99bf2cffe5s5wMVZhGkYukW';
const CHILD = 'ses_child0000000000000000000';

// Event shapes from the probe log, trimmed to what the plugin reads.
const ev = (type: string, properties: unknown): Step => ({
  hook: 'event',
  args: [{ event: { type, properties } }],
});
const created = (id: string, extra: Record<string, unknown> = {}): Step =>
  ev('session.created', {
    sessionID: id,
    info: { id, title: 'New session', agent: 'build', ...extra },
  });
const status = (id: string, type: 'busy' | 'idle'): Step =>
  ev('session.status', { sessionID: id, status: { type } });
const idle = (id: string): Step => ev('session.idle', { sessionID: id });
const message = (id: string, text: string): Step => ({
  hook: 'chat.message',
  args: [
    {
      sessionID: id,
      agent: 'build',
      model: { providerID: 'opencode', modelID: 'claude-haiku-4-5' },
    },
    { message: {}, parts: [{ type: 'text', text, messageID: 'msg_1', sessionID: id }] },
  ],
});
const toolBefore = (id: string, tool: string, args: unknown): Step => ({
  hook: 'tool.execute.before',
  args: [{ tool, sessionID: id, callID: 'toolu_1' }, { args }],
});
const toolAfter = (id: string, tool: string, args: unknown): Step => ({
  hook: 'tool.execute.after',
  args: [
    { tool, sessionID: id, callID: 'toolu_1', args },
    { title: 'x', output: '', metadata: {} },
  ],
});
const QUESTIONS = [
  {
    question: 'Continue?',
    header: 'Confirmation',
    options: [
      { label: 'Yes', description: 'Proceed with the next step' },
      { label: 'No', description: 'Stop here' },
    ],
  },
];

describe.skipIf(process.platform === 'win32')('OPENCODE_STATUS_PLUGIN under a real node', () => {
  let dir: string;
  let tty: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'double0-opencode-plugin-'));
    tty = join(dir, 'tty');
    writeFileSync(join(dir, 'plugin.mjs'), OPENCODE_STATUS_PLUGIN, 'utf8');
    writeFileSync(join(dir, 'harness.mjs'), HARNESS, 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (steps: Step[], env: Record<string, string> = {}, cli: string[] = []) => {
    writeFileSync(join(dir, 'steps.json'), JSON.stringify(steps), 'utf8');
    return spawnSync(
      process.execPath,
      [
        join(dir, 'harness.mjs'),
        join(dir, 'plugin.mjs'),
        join(dir, 'steps.json'),
        join(dir, 'env.out'),
        ...cli,
      ],
      {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DOUBLE0_TTY: tty, ...env },
        encoding: 'utf8',
      },
    );
  };
  /** `<the plugin's own process.env value>\n<what a child shell inherited>`. */
  const ownerSeen = (): string => readFileSync(join(dir, 'env.out'), 'utf8');
  const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');
  /** Every marker written to the pty, in order. */
  const markers = (): Marker[] => {
    if (!existsSync(tty)) return [];
    const out: Marker[] = [];
    // eslint-disable-next-line no-control-regex
    const re = /\x1b\](679[01]);([a-z-]+)(?:;([^\x07]*))?\x07/g;
    for (const m of readFileSync(tty, 'utf8').matchAll(re)) {
      out.push({ code: m[1], verb: m[2], payload: m[3] ?? null });
    }
    return out;
  };
  const verbs = (): string[] =>
    markers().map((m) => `${m.code === INPUT_OSC ? 'input:' : ''}${m.verb}`);

  it('arms marker mode as it loads and ends once when the TUI disposes it', () => {
    const r = run([{ hook: 'dispose', args: [] }], { DOUBLE0_TTY: tty });
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
    // The process-exit belt must not add a second `ended`.
    expect(verbs()).toEqual(['ready', 'ended']);
    expect(markers()[0].code).toBe(STATUS_OSC);
  });

  it('opens a turn on the prompt, with the Inputs mark, and finishes it exactly once', () => {
    run([
      created(MAIN),
      message(MAIN, 'Run the command `ls -la`'),
      status(MAIN, 'busy'),
      status(MAIN, 'busy'),
      status(MAIN, 'idle'),
      idle(MAIN),
      // The live CLI emits the idle pair twice at the end of a turn.
      status(MAIN, 'idle'),
      idle(MAIN),
    ]);
    expect(verbs()).toEqual(['ready', 'running', 'input:prompt', 'finished', 'ended']);
    // The mark is what main's Inputs list reads: the program and the prompt.
    const json = decode(markers()[2].payload!);
    expect(programFromHookJson(json)).toBe('opencode');
    expect(promptFromHookJson(json)).toEqual({
      text: 'Run the command `ls -la`',
      truncated: false,
    });
  });

  it('opens a turn without a prompt when a session just turns busy - a continued one', () => {
    run([created(MAIN), status(MAIN, 'busy'), status(MAIN, 'busy'), idle(MAIN)]);
    expect(verbs()).toEqual(['ready', 'running', 'finished', 'ended']);
  });

  it('never finishes a turn it did not see open', () => {
    // The TUI starts with its last session idle; a stray idle says nothing.
    run([created(MAIN), idle(MAIN), status(MAIN, 'idle')]);
    expect(verbs()).toEqual(['ready', 'ended']);
  });

  it("reports each tool call with its name and headline argument, in the hook script's shape", () => {
    run([
      created(MAIN),
      message(MAIN, 'x'),
      toolBefore(MAIN, 'bash', { command: 'ls -la', description: 'List files' }),
      toolAfter(MAIN, 'bash', { command: 'ls -la', description: 'List files' }),
      toolBefore(MAIN, 'read', { filePath: '/acme/src/token.service.ts' }),
      toolBefore(MAIN, 'question', { questions: QUESTIONS }),
      toolBefore(MAIN, 'bash', { command: 'cd x\nls' }),
    ]);
    const tools = markers().filter((m) => m.verb.startsWith('tool-'));
    expect(tools.map((m) => [m.verb, decode(m.payload!)])).toEqual([
      ['tool-start', 'bash\nls -la\n'],
      ['tool-done', 'bash\nls -la\n'],
      ['tool-start', 'read\n/acme/src/token.service.ts\n'],
      // No headline key: an empty second line, like the hook script's.
      ['tool-start', 'question\n\n'],
      // A newline inside an argument stays an escape, never a payload line.
      ['tool-start', 'bash\ncd x\\nls\n'],
    ]);
  });

  it("tags a child session's tools with its agent, and lets only the parent open or close the turn", () => {
    run([
      created(MAIN),
      message(MAIN, 'delegate'),
      toolBefore(MAIN, 'task', { description: 'Review the auth changes' }),
      created(CHILD, { parentID: MAIN, agent: 'explore' }),
      // The subagent's own prompt and tools: work, but the parent's turn.
      message(CHILD, 'review auth'),
      status(CHILD, 'busy'),
      toolBefore(CHILD, 'grep', { pattern: 'refreshToken' }),
      toolAfter(CHILD, 'grep', { pattern: 'refreshToken' }),
      idle(CHILD),
      status(CHILD, 'idle'),
      toolAfter(MAIN, 'task', { description: 'Review the auth changes' }),
      idle(MAIN),
    ]);
    expect(verbs()).toEqual([
      'ready',
      'running',
      'input:prompt',
      'tool-start',
      'tool-start',
      'tool-done',
      'tool-done',
      'finished',
      'ended',
    ]);
    const tools = markers().filter((m) => m.verb.startsWith('tool-'));
    expect(decode(tools[1].payload!)).toBe('grep\nrefreshToken\nexplore\n');
    expect(decode(tools[3].payload!)).toBe('task\nReview the auth changes\n');
  });

  it('asks a question in the shape the renderer decodes, and lifts it when answered', () => {
    run([
      created(MAIN),
      message(MAIN, 'x'),
      toolBefore(MAIN, 'question', { questions: QUESTIONS }),
      ev('question.asked', { id: 'que_1', sessionID: MAIN, questions: QUESTIONS, tool: {} }),
      // Replies for a request never asked say nothing.
      ev('question.replied', { sessionID: MAIN, requestID: 'que_other', answers: [['Yes']] }),
      ev('question.replied', { sessionID: MAIN, requestID: 'que_1', answers: [['Yes']] }),
      toolAfter(MAIN, 'question', { questions: QUESTIONS }),
      idle(MAIN),
    ]);
    expect(verbs()).toEqual([
      'ready',
      'running',
      'input:prompt',
      'tool-start',
      'question',
      'question-done',
      'tool-done',
      'finished',
      'ended',
    ]);
    const q = JSON.parse(decode(markers()[4].payload!)) as {
      tool_input: { questions: Array<{ question: string; options: Array<{ label: string }> }> };
    };
    expect(q.tool_input.questions[0].question).toBe('Continue?');
    expect(q.tool_input.questions[0].options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  // The request as 1.17.20 publishes it (driven live with `permission.bash:
  // ask`, 2026-10-03): no title - the kind and the patterns it covers; the
  // reply names the request by `requestID`, never `permissionID`. The first
  // version read fields that do not exist and never lifted a wait.
  const asked = (id: string, command: string): Step =>
    ev('permission.asked', {
      id,
      sessionID: MAIN,
      permission: 'bash',
      patterns: [command],
      metadata: { command },
      always: [`${command.split(' ')[0]} *`],
      tool: { messageID: 'msg_1', callID: 'toolu_1' },
    });
  const replied = (id: string, reply: 'once' | 'always' | 'reject'): Step =>
    ev('permission.replied', { sessionID: MAIN, requestID: id, reply });

  it('flags a permission once, lifts it on the reply, and the approved tool ends the turn', () => {
    run([
      created(MAIN),
      message(MAIN, 'x'),
      // The ask comes from inside the tool: tool.execute.before fires first (live).
      toolBefore(MAIN, 'bash', { command: 'ls -la' }),
      asked('per_1', 'ls -la'),
      // Published again for the same id (the TUI replaces it in place): not a second wait.
      asked('per_1', 'ls -la'),
      // A reply for a request never asked says nothing.
      replied('per_other', 'once'),
      replied('per_1', 'once'),
      toolAfter(MAIN, 'bash', { command: 'ls -la' }),
      idle(MAIN),
    ]);
    expect(verbs()).toEqual([
      'ready',
      'running',
      'input:prompt',
      'tool-start',
      'needs-input',
      'question-done',
      'tool-done',
      'finished',
      'ended',
    ]);
    expect(decode(markers()[4].payload!)).toBe('Permission for bash: ls -la');
  });

  it('lifts a rejected permission too - the turn then ends idle, with no tool to heal it', () => {
    // Live: Esc on the dialog replies "reject", no tool.execute.after follows,
    // and the session goes idle. Without the lift the tab would sit on
    // needs-input until `finished` - and would have stayed there for good had
    // the model gone on working instead of stopping.
    run([
      created(MAIN),
      message(MAIN, 'x'),
      toolBefore(MAIN, 'bash', { command: 'ls -la' }),
      asked('per_1', 'ls -la'),
      replied('per_1', 'reject'),
      status(MAIN, 'idle'),
      idle(MAIN),
    ]);
    expect(verbs()).toEqual([
      'ready',
      'running',
      'input:prompt',
      'tool-start',
      'needs-input',
      'question-done',
      'finished',
      'ended',
    ]);
  });

  it('names a permission without patterns by its kind alone, and one without a kind not at all', () => {
    run([
      created(MAIN),
      message(MAIN, 'x'),
      ev('permission.asked', {
        id: 'per_1',
        sessionID: MAIN,
        permission: 'doom_loop',
        patterns: [],
      }),
      ev('permission.asked', { id: 'per_2', sessionID: MAIN }),
    ]);
    const waits = markers().filter((m) => m.verb === 'needs-input');
    expect(waits.map((m) => (m.payload === null ? null : decode(m.payload)))).toEqual([
      'Permission for doom_loop',
      null,
    ]);
  });

  describe('only the top-level agent of a tab reports', () => {
    it('marks its own process, and so the bash tool’s children, as under it', () => {
      run([created(MAIN)]);
      // process.env first, then what `sh -c` spawned from that process saw -
      // the bash tool spawns the same way (verified live on 1.17.20).
      expect(ownerSeen()).toBe('opencode\nopencode');
    });

    it('says nothing, keeps nothing and marks nothing when loaded under another agent', () => {
      // An `opencode run …` from Claude's Bash tool: the inline config, the
      // pty device and the record file are all inherited from the parent tab.
      const record = join(dir, 'record');
      const r = run(
        [
          created(MAIN),
          message(MAIN, 'x'),
          toolBefore(MAIN, 'bash', { command: 'ls' }),
          idle(MAIN),
          { hook: 'dispose', args: [] },
        ],
        { [STATUS_OWNER_ENV]: 'claude', [OPENCODE_SESSION_RECORD_ENV]: record },
      );
      expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
      // Not even `ready` or the process-exit `ended`.
      expect(existsSync(tty)).toBe(false);
      expect(existsSync(record)).toBe(false);
      expect(ownerSeen()).toBe('claude\nclaude');
    });
  });

  it('stays silent in a non-interactive run (`opencode run`, `serve`)', () => {
    for (const sub of ['run', 'serve']) {
      const r = run([created(MAIN), message(MAIN, 'x'), idle(MAIN)], {}, [sub, 'hello']);
      expect(r).toMatchObject({ status: 0, stderr: '' });
      expect(existsSync(tty)).toBe(false);
    }
  });

  it("records the tab's live top-level session, never a child's, and drops a deleted one", () => {
    const record = join(dir, 'record');
    run(
      [
        created(MAIN),
        created(CHILD, { parentID: MAIN, agent: 'explore' }),
        ev('session.updated', {
          sessionID: MAIN,
          info: { id: MAIN, title: 'renamed', agent: 'build' },
        }),
      ],
      { DOUBLE0_TTY: tty, [OPENCODE_SESSION_RECORD_ENV]: record },
    );
    expect(readFileSync(record, 'utf8')).toBe(MAIN);
    run([created(MAIN), ev('session.deleted', { info: { id: MAIN } })], {
      DOUBLE0_TTY: tty,
      [OPENCODE_SESSION_RECORD_ENV]: record,
    });
    expect(existsSync(record)).toBe(false);
    // Unpinned launch: no record at all.
    run([created(MAIN)]);
    expect(existsSync(record)).toBe(false);
  });

  it('caps the prompt mark at the payload budget, leaving the head main can read', () => {
    run([created(MAIN), message(MAIN, 'x'.repeat(10_000))]);
    const payload = markers()[2].payload!;
    expect(Buffer.from(payload, 'base64').length).toBe(PROMPT_PAYLOAD_BYTES);
    const prompt = promptFromHookJson(decode(payload));
    expect(prompt?.truncated).toBe(true);
    expect(prompt?.text.startsWith('xxxx')).toBe(true);
  });

  it('never fails or prints, with no pty to write to or one it cannot open', () => {
    expect(run([created(MAIN), message(MAIN, 'x')], { DOUBLE0_TTY: '' })).toMatchObject({
      status: 0,
      stdout: '',
      stderr: '',
    });
    expect(existsSync(tty)).toBe(false);
    // A directory is not writable as a file.
    expect(run([created(MAIN), message(MAIN, 'x')], { DOUBLE0_TTY: dir })).toMatchObject({
      status: 0,
      stdout: '',
      stderr: '',
    });
  });
});

describe('the inline config that loads the plugin', () => {
  it('names the plugin by file URL, the spec OpenCode imports as is', () => {
    expect(opencodeConfigContent('/tmp/double0-opencode/double0-status.js')).toBe(
      '{"plugin":["file:///tmp/double0-opencode/double0-status.js"]}',
    );
  });

  it('exports it only when the user has no runtime overrides of their own', () => {
    const line = opencodeConfigExport('/tmp/double0-opencode/double0-status.js');
    expect(line).toBe(
      `[ -n "\${${OPENCODE_CONFIG_ENV}:-}" ] || export ${OPENCODE_CONFIG_ENV}='{"plugin":["file:///tmp/double0-opencode/double0-status.js"]}'`,
    );
  });

  it.skipIf(process.platform === 'win32')(
    "leaves the user's own overrides untouched under a real sh - theirs over our status",
    () => {
      const line = opencodeConfigExport('/tmp/p.js');
      const probe = `${line}; printf '%s' "$${OPENCODE_CONFIG_ENV}"`;
      // A clean env: run inside an app terminal, the variable is already set
      // (to the app's own plugin) and this half of the test read it.
      expect(
        spawnSync('sh', ['-c', probe], {
          env: { PATH: process.env.PATH ?? '' },
          encoding: 'utf8',
        }).stdout,
      ).toBe('{"plugin":["file:///tmp/p.js"]}');
      expect(
        spawnSync('sh', ['-c', probe], {
          env: { PATH: process.env.PATH ?? '', [OPENCODE_CONFIG_ENV]: '{"model":"x"}' },
          encoding: 'utf8',
        }).stdout,
      ).toBe('{"model":"x"}');
    },
  );
});
