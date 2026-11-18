import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginSessionTurn,
  clearSessionActivity,
  decodeToolPayload,
  finishSessionTurn,
  getSessionActivity,
  noteSessionWaiting,
  noteToolDone,
  noteToolStart,
  useSessionActivity,
  useSessionActivityMap,
} from '@renderer/lib/session/activity';

/** base64 of UTF-8 text, the way the hook script builds a payload. */
const b64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const tool = (name: string, arg = ''): string => b64(`${name}\n${arg}`);

const S = 'session-1';

afterEach(() => {
  clearSessionActivity(S);
  clearSessionActivity('other');
});

describe('decodeToolPayload', () => {
  it('splits the tool name from its argument', () => {
    expect(decodeToolPayload(tool('Edit', '/repo/src/a.ts'))).toEqual({
      tool: 'Edit',
      arg: '/repo/src/a.ts',
    });
  });

  it('reads an argument-less call, a trailing newline from echo included', () => {
    expect(decodeToolPayload(b64('TodoWrite\n\n'))).toEqual({ tool: 'TodoWrite', arg: null });
    expect(decodeToolPayload(b64('TodoWrite'))).toEqual({ tool: 'TodoWrite', arg: null });
  });

  it('keeps non-ASCII arguments intact', () => {
    expect(decodeToolPayload(tool('Write', 'docs/übersicht.md'))?.arg).toBe('docs/übersicht.md');
  });

  it('is null for an empty, missing or undecodable payload', () => {
    expect(decodeToolPayload(undefined)).toBeNull();
    expect(decodeToolPayload('')).toBeNull();
    expect(decodeToolPayload('***')).toBeNull();
    expect(decodeToolPayload(b64('\nonly-an-arg'))).toBeNull();
  });

  it("reads the agent type a subagent's call carries; the main agent's own stays untagged", () => {
    expect(decodeToolPayload(b64('Read\n/repo/README.md\ngeneral-purpose\n'))).toEqual({
      tool: 'Read',
      arg: '/repo/README.md',
      agent: 'general-purpose',
    });
    expect(decodeToolPayload(b64('TodoWrite\n\nagent\n'))).toEqual({
      tool: 'TodoWrite',
      arg: null,
      agent: 'agent',
    });
    expect(decodeToolPayload(tool('Read', '/repo/README.md'))).not.toHaveProperty('agent');
  });
});

describe('a turn, tool by tool', () => {
  it('opens on the prompt, follows each tool, and sums up at the end', () => {
    beginSessionTurn(S);
    expect(getSessionActivity(S)).toMatchObject({ turnOpen: true, current: null, commands: 0 });

    noteToolStart(S, tool('Read', 'src/a.ts'));
    expect(getSessionActivity(S)?.current).toEqual({ tool: 'Read', arg: 'src/a.ts' });

    noteToolDone(S, tool('Edit', 'src/a.ts'));
    noteToolDone(S, tool('Edit', 'src/a.ts')); // same file twice counts once
    noteToolDone(S, tool('Write', 'src/b.ts'));
    noteToolDone(S, tool('Bash', 'pnpm test'));
    noteToolDone(S, tool('Read', 'src/c.ts')); // reading edits nothing
    expect(getSessionActivity(S)).toMatchObject({
      current: { tool: 'Read', arg: 'src/c.ts' },
      editedFiles: ['src/a.ts', 'src/b.ts'],
      commands: 1,
    });

    expect(finishSessionTurn(S)).toBe('Finished - 2 files edited');
    // The live entry is gone: nothing is running any more.
    expect(getSessionActivity(S)).toBeNull();
  });

  it('opens the turn on a tool marker too, when the prompt marker was missed', () => {
    // A window that starts observing mid-turn sees tools before any prompt.
    noteToolDone(S, tool('Bash', 'ls'));
    expect(getSessionActivity(S)?.turnOpen).toBe(true);
    expect(finishSessionTurn(S)).toBe('Finished - 1 command run');
  });

  it('sums up nothing when no turn was open - a /clear must not overwrite the last summary', () => {
    expect(finishSessionTurn(S)).toBeNull();
    noteSessionWaiting(S, b64('Waiting'));
    expect(getSessionActivity(S)?.turnOpen).toBe(false);
    expect(finishSessionTurn(S)).toBeNull();
  });

  it('starts every prompt from zero', () => {
    beginSessionTurn(S);
    noteToolDone(S, tool('Edit', 'a.ts'));
    beginSessionTurn(S);
    expect(getSessionActivity(S)).toMatchObject({ editedFiles: [], commands: 0, current: null });
  });

  it('ignores undecodable tool payloads', () => {
    beginSessionTurn(S);
    noteToolStart(S, '***');
    noteToolDone(S, undefined);
    expect(getSessionActivity(S)).toMatchObject({ current: null, editedFiles: [], commands: 0 });
  });
});

describe('the blocked-on-you message', () => {
  it('records the notification message and drops it once a tool runs', () => {
    beginSessionTurn(S);
    noteSessionWaiting(S, b64('Claude needs your permission'));
    expect(getSessionActivity(S)?.waiting).toBe('Claude needs your permission');
    noteToolDone(S, tool('Bash', 'ls'));
    expect(getSessionActivity(S)?.waiting).toBeNull();
  });

  it('keeps the pending tool alongside the message', () => {
    noteToolStart(S, tool('Bash', 'pnpm db:migrate'));
    noteSessionWaiting(S, b64('Claude needs your permission'));
    expect(getSessionActivity(S)).toMatchObject({
      current: { tool: 'Bash', arg: 'pnpm db:migrate' },
      waiting: 'Claude needs your permission',
    });
  });

  it('records a bare marker as no message', () => {
    beginSessionTurn(S);
    noteSessionWaiting(S, undefined);
    expect(getSessionActivity(S)?.waiting).toBeNull();
  });
});

describe('clearSessionActivity', () => {
  it('forgets the session and nothing else', () => {
    beginSessionTurn(S);
    beginSessionTurn('other');
    clearSessionActivity(S);
    expect(getSessionActivity(S)).toBeNull();
    expect(getSessionActivity('other')?.turnOpen).toBe(true);
  });
});

describe('the hooks', () => {
  it('hands out a fresh map per change and a stable entry for an untouched session', () => {
    const map = renderHook(useSessionActivityMap);
    const one = renderHook(() => useSessionActivity(S));
    const before = map.result.current;
    act(() => beginSessionTurn('other'));
    expect(map.result.current).not.toBe(before);
    expect(one.result.current).toBeNull();
    act(() => noteToolStart(S, tool('Edit', 'a.ts')));
    expect(one.result.current?.current).toEqual({ tool: 'Edit', arg: 'a.ts' });
    const entry = one.result.current;
    act(() => noteToolStart('other', tool('Read', 'b.ts')));
    expect(one.result.current).toBe(entry);
  });
});
