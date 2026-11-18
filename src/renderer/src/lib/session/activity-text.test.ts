import { describe, expect, it } from 'vitest';
import {
  EMPTY_ACTIVITY,
  describeTool,
  describeWant,
  finishedLine,
  isEditTool,
  isShellTool,
  resolveSessionLine,
  runningLine,
  waitingLine,
  type SessionActivity,
} from '@renderer/lib/session/activity-text';

const activity = (over: Partial<SessionActivity>): SessionActivity => ({
  ...EMPTY_ACTIVITY,
  turnOpen: true,
  ...over,
});

describe('describeTool - what a tool call is doing', () => {
  it('names the file for the file tools, without its directory', () => {
    expect(describeTool({ tool: 'Edit', arg: '/repo/src/auth/token.service.ts' })).toBe(
      'Editing token.service.ts',
    );
    expect(describeTool({ tool: 'MultiEdit', arg: 'src/a.ts' })).toBe('Editing a.ts');
    expect(describeTool({ tool: 'NotebookEdit', arg: 'nb/train.ipynb' })).toBe(
      'Editing train.ipynb',
    );
    expect(describeTool({ tool: 'Write', arg: '/repo/README.md' })).toBe('Writing README.md');
    expect(describeTool({ tool: 'Read', arg: 'C:\\repo\\src\\index.ts' })).toBe('Reading index.ts');
  });

  it('shows the first line of a shell command, collapsed and capped', () => {
    expect(describeTool({ tool: 'Bash', arg: 'pnpm   test' })).toBe('Running pnpm test');
    expect(describeTool({ tool: 'Bash', arg: 'pnpm test\\ncd x' })).toBe('Running pnpm test');
    const long = 'x'.repeat(80);
    expect(describeTool({ tool: 'Bash', arg: long })).toBe(`Running ${'x'.repeat(59)}…`);
  });

  it('drops the dangling backslash the hook leaves at an escaped quote', () => {
    // `echo "hi"` reaches the hook as `echo \"hi\"` and is cut at the first
    // quote: `echo \` - the row must not show that backslash.
    expect(describeTool({ tool: 'Bash', arg: 'echo \\' })).toBe('Running echo');
  });

  it('quotes a search pattern, names a delegated task, hosts a fetch', () => {
    expect(describeTool({ tool: 'Grep', arg: 'refreshToken' })).toBe('Searching "refreshToken"');
    expect(describeTool({ tool: 'Glob', arg: '**/*.test.ts' })).toBe('Searching "**/*.test.ts"');
    expect(describeTool({ tool: 'Task', arg: 'Review the auth changes' })).toBe(
      'Delegating: Review the auth changes',
    );
    expect(describeTool({ tool: 'WebFetch', arg: 'https://docs.example.com/a/b?x=1' })).toBe(
      'Fetching docs.example.com',
    );
    expect(describeTool({ tool: 'WebSearch', arg: 'vitest fake timers' })).toBe(
      'Searching the web: vitest fake timers',
    );
  });

  it('reads an MCP tool name as server: tool, and falls back to Using', () => {
    expect(describeTool({ tool: 'mcp__github__create_issue', arg: null })).toBe(
      'Using github: create_issue',
    );
    expect(describeTool({ tool: 'SomethingNew', arg: null })).toBe('Using SomethingNew');
  });

  it('has a phrase for every tool even without an argument', () => {
    expect(describeTool({ tool: 'Edit', arg: null })).toBe('Editing a file');
    expect(describeTool({ tool: 'Bash', arg: null })).toBe('Running a command');
    expect(describeTool({ tool: 'TodoWrite', arg: null })).toBe('Planning');
    expect(describeTool({ tool: 'AskUserQuestion', arg: null })).toBe('Asking a question');
  });

  it("reads OpenCode's lowercase tool names and Codex's the same as Claude's", () => {
    // The names as OpenCode 1.17.20 reports them to its plugin hooks.
    expect(describeTool({ tool: 'edit', arg: '/repo/src/token.service.ts' })).toBe(
      'Editing token.service.ts',
    );
    expect(describeTool({ tool: 'write', arg: 'README.md' })).toBe('Writing README.md');
    expect(describeTool({ tool: 'read', arg: 'src/index.ts' })).toBe('Reading index.ts');
    expect(describeTool({ tool: 'bash', arg: 'ls -la' })).toBe('Running ls -la');
    expect(describeTool({ tool: 'grep', arg: 'refreshToken' })).toBe('Searching "refreshToken"');
    expect(describeTool({ tool: 'task', arg: 'Review the auth changes' })).toBe(
      'Delegating: Review the auth changes',
    );
    expect(describeTool({ tool: 'webfetch', arg: 'https://docs.example.com/a' })).toBe(
      'Fetching docs.example.com',
    );
    expect(describeTool({ tool: 'question', arg: null })).toBe('Asking a question');
    expect(describeTool({ tool: 'todowrite', arg: null })).toBe('Planning');
    expect(describeTool({ tool: 'skill', arg: 'verify' })).toBe('Running skill verify');
    // Codex's canonical hook names.
    expect(describeTool({ tool: 'apply_patch', arg: '/repo/a.ts' })).toBe('Editing a.ts');
    expect(describeTool({ tool: 'shell', arg: 'pnpm test' })).toBe('Running pnpm test');
    // Case never decides the phrase; an unknown tool keeps its own spelling.
    expect(describeTool({ tool: 'SomethingNew', arg: null })).toBe('Using SomethingNew');
  });
});

describe('describeWant - what a blocked agent asks leave to do', () => {
  it('phrases the pending tool as a request', () => {
    expect(describeWant({ tool: 'Bash', arg: 'pnpm db:migrate' })).toBe(
      'Wants to run pnpm db:migrate',
    );
    expect(describeWant({ tool: 'Edit', arg: '/repo/.env' })).toBe('Wants to edit .env');
    expect(describeWant({ tool: 'Write', arg: 'notes.md' })).toBe('Wants to write notes.md');
    expect(describeWant({ tool: 'Read', arg: '/etc/hosts' })).toBe('Wants to read hosts');
    expect(describeWant({ tool: 'WebFetch', arg: 'https://example.com/x' })).toBe(
      'Wants to fetch example.com',
    );
    expect(describeWant({ tool: 'mcp__jira__transition', arg: null })).toBe(
      'Wants to use jira: transition',
    );
  });

  it('treats the plan-approval dialog as a review, not a request', () => {
    expect(describeWant({ tool: 'ExitPlanMode', arg: null })).toBe('Plan ready for review');
  });

  it("phrases OpenCode's tools the same way", () => {
    expect(describeWant({ tool: 'bash', arg: 'rm -rf dist' })).toBe('Wants to run rm -rf dist');
    expect(describeWant({ tool: 'edit', arg: '/repo/.env' })).toBe('Wants to edit .env');
    expect(describeWant({ tool: 'question', arg: null })).toBe('Asking a question');
  });
});

describe('the tool classes that feed the turn counters', () => {
  it('counts every editing tool as an edit and every shell tool as a command', () => {
    for (const t of [
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Write',
      'apply_patch',
      'edit',
      'write',
    ]) {
      expect(isEditTool(t), t).toBe(true);
    }
    for (const t of ['Bash', 'shell', 'exec_command', 'bash']) expect(isShellTool(t), t).toBe(true);
    expect(isEditTool('Read')).toBe(false);
    expect(isEditTool('read')).toBe(false);
    expect(isShellTool('Grep')).toBe(false);
  });
});

describe('runningLine', () => {
  it('says Working… before the first tool of a turn', () => {
    expect(runningLine(activity({}))).toBe('Working…');
  });

  it('adds the file count once the turn has touched two files', () => {
    const one = activity({ current: { tool: 'Edit', arg: 'a.ts' }, editedFiles: ['a.ts'] });
    expect(runningLine(one)).toBe('Editing a.ts');
    const three = activity({
      current: { tool: 'Bash', arg: 'pnpm test' },
      editedFiles: ['a.ts', 'b.ts', 'c.ts'],
    });
    expect(runningLine(three)).toBe('Running pnpm test · 3 files so far');
  });
});

describe('waitingLine', () => {
  it('prefers the pending tool, then the notification message, then a generic line', () => {
    expect(
      waitingLine(activity({ current: { tool: 'Bash', arg: 'rm -rf dist' }, waiting: 'x' })),
    ).toBe('Wants to run rm -rf dist');
    expect(waitingLine(activity({ waiting: 'Claude needs your permission' }))).toBe(
      'Claude needs your permission',
    );
    expect(waitingLine(EMPTY_ACTIVITY)).toBe('Needs your input');
  });
});

describe('finishedLine - the summary persisted when a turn ends', () => {
  it('counts edited files first, then commands, else says only that it finished', () => {
    expect(finishedLine(activity({ editedFiles: ['a', 'b', 'c'], commands: 2 }))).toBe(
      'Finished - 3 files edited',
    );
    expect(finishedLine(activity({ editedFiles: ['a'] }))).toBe('Finished - 1 file edited');
    expect(finishedLine(activity({ commands: 1 }))).toBe('Finished - 1 command run');
    expect(finishedLine(activity({ commands: 4 }))).toBe('Finished - 4 commands run');
    // Never "no changes": the turn knows only its own tools, and an earlier
    // turn's new files were still sitting in the folder when this said so.
    expect(finishedLine(activity({}))).toBe('Finished');
  });
});

describe('resolveSessionLine - the one line under a session name', () => {
  const detail = 'Finished - 2 files edited';

  it('answers a blocked session with its question, in warning tone', () => {
    expect(
      resolveSessionLine({
        status: 'needs-input',
        activity: activity({ current: { tool: 'Bash', arg: 'ls' } }),
        question: { question: 'Which auth strategy?', options: [] },
        detail,
      }),
    ).toEqual({ text: 'Which auth strategy?', tone: 'warning', live: true });
  });

  it('otherwise says what the blocked agent wants, even with no activity known', () => {
    expect(
      resolveSessionLine({
        status: 'needs-input',
        activity: activity({ current: { tool: 'Bash', arg: 'pnpm db:migrate' } }),
        question: null,
        detail,
      }),
    ).toEqual({ text: 'Wants to run pnpm db:migrate', tone: 'warning', live: true });
    expect(
      resolveSessionLine({ status: 'needs-input', activity: null, question: null, detail }),
    ).toEqual({ text: 'Needs your input', tone: 'warning', live: true });
  });

  it('shows live activity for a working session with an open turn', () => {
    expect(
      resolveSessionLine({
        status: 'active',
        activity: activity({ current: { tool: 'Edit', arg: 'x/token.service.ts' } }),
        question: null,
        detail,
      }),
    ).toEqual({ text: 'Editing token.service.ts', tone: 'muted', live: true });
  });

  it('says a working session is working when this window never saw its turn open', () => {
    // The status is persisted and shared; the activity lives only in the
    // window that heard the turn start. After a renderer reload mid-turn, or
    // in the main window while the session runs torn off, the row showed the
    // LAST turn's "Finished" summary beside a working dot.
    for (const known of [null, { ...EMPTY_ACTIVITY, waiting: 'Claude needs your permission' }]) {
      expect(
        resolveSessionLine({ status: 'active', activity: known, question: null, detail }),
      ).toEqual({ text: 'Working…', tone: 'muted', live: true });
    }
    expect(
      resolveSessionLine({ status: 'active', activity: null, question: null, detail: '' }),
    ).toEqual({ text: 'Working…', tone: 'muted', live: true });
  });

  it('never shows a closed turn as the running line', () => {
    const closed = activity({ turnOpen: false, current: { tool: 'Edit', arg: 'x/old.ts' } });
    expect(
      resolveSessionLine({ status: 'active', activity: closed, question: null, detail })?.text,
    ).toBe('Working…');
  });

  it('marks a line live exactly while the session works or waits on you', () => {
    // The sidebar hides a session's folder chip behind a live line and brings
    // it back for the summary. Live follows the status, not the window's
    // activity: every path that closes a turn (finished, ended, ready, the
    // last shell exiting) settles the status in the same handler, so the chip
    // is back as soon as the dot stops saying the session works.
    const running = activity({ current: { tool: 'Bash', arg: 'pnpm test' } });
    expect(
      resolveSessionLine({ status: 'active', activity: running, question: null, detail })?.live,
    ).toBe(true);
    expect(
      resolveSessionLine({ status: 'active', activity: null, question: null, detail })?.live,
    ).toBe(true);
    expect(
      resolveSessionLine({ status: 'idle', activity: running, question: null, detail })?.live,
    ).toBe(false);
  });

  it('shows the persisted detail for parked sessions, and nothing when there is none', () => {
    for (const status of ['idle', 'finished', 'archived'] as const) {
      expect(resolveSessionLine({ status, activity: null, question: null, detail })).toEqual({
        text: detail,
        tone: 'muted',
        live: false,
      });
      expect(resolveSessionLine({ status, activity: null, question: null, detail: '' })).toBeNull();
    }
  });
});
