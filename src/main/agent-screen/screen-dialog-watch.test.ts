import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatus } from '../terminal-modes';
import { ScreenDialogWatch, statusMarker } from './screen-dialog-watch';

const MCP = [
  '────────────────────',
  ' 3 new MCP servers found in this project',
  ' ❯ [✔] notion',
  '      Enable selected',
  ' Space to select · Esc to reject all',
];
const PROMPT = ['❯ ', '────', ' ? for shortcuts'];
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('ScreenDialogWatch', () => {
  let screen: string[] | null;
  let status: AgentStatus | null;
  let injected: string[];
  let taken: boolean;
  let watch: ScreenDialogWatch;

  beforeEach(() => {
    vi.useFakeTimers();
    screen = PROMPT;
    status = 'idle';
    injected = [];
    taken = true;
    watch = new ScreenDialogWatch({
      lines: () => screen,
      status: async () => status,
      inject: (_id, data) => {
        if (taken) injected.push(data);
        return taken;
      },
    });
  });

  afterEach(() => {
    watch.dispose();
    vi.useRealTimers();
  });

  it('marks a Claude at the MCP servers dialog as waiting, and idle again once it is answered', async () => {
    screen = MCP;
    watch.data('t');
    await vi.advanceTimersByTimeAsync(300);
    // A hook's own dialog draws a moment before its marker: not yet.
    expect(injected).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(injected).toEqual([
      statusMarker('needs-input', b64('3 new MCP servers found in this project')),
    ]);
    // Repaints of the same dialog say nothing more.
    watch.data('t');
    await vi.advanceTimersByTimeAsync(1500);
    expect(injected).toHaveLength(1);
    // Answered: back to idle quietly (`ready`), never a finished turn.
    screen = PROMPT;
    watch.data('t');
    await vi.advanceTimersByTimeAsync(300);
    expect(injected.at(-1)).toBe(statusMarker('ready'));
  });

  it("leaves a hook's own dialog to its markers", async () => {
    status = 'needs-input';
    screen = MCP;
    watch.data('t');
    await vi.advanceTimersByTimeAsync(2000);
    expect(injected).toEqual([]);
  });

  it('ends marker mode when the dialog goes with no Claude behind it (trust: "No, exit")', async () => {
    status = null;
    screen = MCP;
    watch.data('t');
    await vi.advanceTimersByTimeAsync(1500);
    expect(injected).toHaveLength(1);
    screen = ['user@host ~ %'];
    watch.data('t');
    await vi.advanceTimersByTimeAsync(300);
    expect(injected.at(-1)).toBe(statusMarker('ended'));
  });

  it('tries again when no window took the marker', async () => {
    taken = false;
    screen = MCP;
    watch.data('t');
    await vi.advanceTimersByTimeAsync(1500);
    taken = true;
    watch.data('t');
    await vi.advanceTimersByTimeAsync(300);
    expect(injected).toHaveLength(1);
  });

  it('says nothing about a terminal it has no screen copy of', async () => {
    screen = null;
    watch.data('t');
    await vi.advanceTimersByTimeAsync(2000);
    expect(injected).toEqual([]);
  });
});
