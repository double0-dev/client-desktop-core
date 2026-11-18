import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHILDREN_CACHE_MS,
  FIRST_ANSWER_TIMEOUT_MS,
  WindowsChildren,
  parseChildrenLine,
  runsProgram,
} from './win-children';

/** A PowerShell stand-in: records the questions, answers when told. */
function fakePowerShell() {
  const spawned: Array<{ asked: string[]; answer: (line: string) => void; killed: boolean }> = [];
  const spawn = (): ChildProcessWithoutNullStreams => {
    const proc = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const entry = {
      asked: [] as string[],
      answer: (l: string) => stdout.write(`${l}\r\n`),
      killed: false,
    };
    stdin.on('data', (d: Buffer) => entry.asked.push(...d.toString().split('\n').filter(Boolean)));
    Object.assign(proc, {
      stdin,
      stdout,
      stderr: new PassThrough(),
      unref: () => undefined,
      kill: () => {
        entry.killed = true;
        return true;
      },
    });
    spawned.push(entry);
    return proc;
  };
  return { spawn, spawned };
}

afterEach(() => vi.useRealTimers());

describe('WindowsChildren', () => {
  it('asks one long-lived PowerShell and reuses an answer for a moment', async () => {
    let now = 0;
    const ps = fakePowerShell();
    const kids = new WindowsChildren(() => now, ps.spawn);
    const first = kids.busy(4242);
    await vi.waitFor(() => expect(ps.spawned[0]?.asked).toEqual(['4242']));
    ps.spawned[0].answer('4242 7:claude.exe');
    expect(await first).toBe(true);
    // Cached: a following view polls faster than the OS needs asking.
    expect(await kids.busy(4242)).toBe(true);
    expect(ps.spawned[0].asked).toEqual(['4242']);
    now += CHILDREN_CACHE_MS;
    const again = kids.busy(4242);
    await vi.waitFor(() => expect(ps.spawned[0].asked).toEqual(['4242', '4242']));
    ps.spawned[0].answer('4242');
    expect(await again).toBe(false);
    expect(ps.spawned).toHaveLength(1);
    kids.dispose();
  });

  // Every later answer would land on the wrong question.
  it('starts over when an answer is out of step', async () => {
    const ps = fakePowerShell();
    const kids = new WindowsChildren(Date.now, ps.spawn);
    const a = kids.children(1);
    const b = kids.children(2);
    await vi.waitFor(() => expect(ps.spawned[0]?.asked).toEqual(['1', '2']));
    ps.spawned[0].answer('2 9:node.exe');
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(ps.spawned[0].killed).toBe(true);
    const c = kids.children(3);
    await vi.waitFor(() => expect(ps.spawned[1]?.asked).toEqual(['3']));
    // A late line from the stopped one, while the new one's question is
    // open, answers nothing.
    ps.spawned[0].answer('3 1:stale.exe');
    await new Promise((r) => setTimeout(r, 10));
    ps.spawned[1].answer('3 9:node.exe');
    expect(await c).toEqual([{ pid: 9, name: 'node.exe' }]);
    kids.dispose();
  });

  it('gives up on a PowerShell that never answers, and an unknown is never cached', async () => {
    vi.useFakeTimers();
    const ps = fakePowerShell();
    const kids = new WindowsChildren(Date.now, ps.spawn);
    const a = kids.busy(1);
    // A cold start gets the long wait, not the warm one.
    await vi.advanceTimersByTimeAsync(FIRST_ANSWER_TIMEOUT_MS - 1);
    expect(ps.spawned[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await a).toBe(false);
    expect(ps.spawned[0].killed).toBe(true);
    const b = kids.children(1);
    await vi.waitFor(() => expect(ps.spawned[1]?.asked).toEqual(['1']));
    ps.spawned[1].answer('1');
    expect(await b).toEqual([]);
    kids.dispose();
  });

  it('answers unknown for every open question when the PowerShell exits', async () => {
    const ps = fakePowerShell();
    const kids = new WindowsChildren(Date.now, ps.spawn);
    const a = kids.children(1);
    await vi.waitFor(() => expect(ps.spawned).toHaveLength(1));
    kids.dispose();
    expect(await a).toBeNull();
  });
});

describe('parseChildrenLine', () => {
  it("reads the asked pid and each child's pid and name", () => {
    expect(parseChildrenLine('4242 11044:conhost.exe 16700:claude.exe\r')).toEqual({
      pid: 4242,
      children: [
        { pid: 11044, name: 'conhost.exe' },
        { pid: 16700, name: 'claude.exe' },
      ],
    });
    expect(parseChildrenLine('4242')).toEqual({ pid: 4242, children: [] });
  });

  it('skips what is not an answer', () => {
    expect(parseChildrenLine('')).toBeNull();
    expect(parseChildrenLine('WARNING: something')).toBeNull();
    expect(parseChildrenLine('4242 garbage 7:node.exe')).toEqual({
      pid: 4242,
      children: [{ pid: 7, name: 'node.exe' }],
    });
  });
});

describe('runsProgram', () => {
  // A shell started without ConPTY gets a console host child of its own -
  // never the user's program (measured: an idle cmd.exe under node).
  it('does not count the console host', () => {
    expect(runsProgram([])).toBe(false);
    expect(runsProgram([{ pid: 1, name: 'conhost.exe' }])).toBe(false);
    expect(runsProgram([{ pid: 1, name: 'Conhost.EXE' }])).toBe(false);
    expect(
      runsProgram([
        { pid: 1, name: 'conhost.exe' },
        { pid: 2, name: 'claude.exe' },
      ]),
    ).toBe(true);
  });
});
