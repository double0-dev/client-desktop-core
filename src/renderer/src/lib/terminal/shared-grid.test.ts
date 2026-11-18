import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAIM_AFTER_INPUT_MS,
  applyGrid,
  claimOnInteraction,
  followedGrid,
  isUserInput,
  noteTerminalInteraction,
  resetSharedGridForTest,
  resizeKindFor,
  resizePty,
  startSharedGridFeed,
} from './shared-grid';

// Two laptops on one host (a private plan › 14): the one
// the user works at sets the grid; the other fits its xterm and never fights.
describe('shared-grid', () => {
  const resize = vi.fn();
  let gridListener: ((g: { id: string; cols: number; rows: number; own: boolean }) => void) | null;

  beforeEach(() => {
    resetSharedGridForTest();
    resize.mockClear();
    gridListener = null;
    window.api = {
      terminal: {
        resize,
        onGrid: (cb: typeof gridListener) => {
          gridListener = cb;
          return () => undefined;
        },
      },
    } as unknown as typeof window.api;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims only shortly after the user interacted', () => {
    expect(resizeKindFor(undefined, 1000)).toBe('passive');
    expect(resizeKindFor(1000, 1000 + CLAIM_AFTER_INPUT_MS - 1)).toBe('claim');
    expect(resizeKindFor(1000, 1000 + CLAIM_AFTER_INPUT_MS)).toBe('passive');
  });

  it("tells the user's bytes from what xterm answers on the pty's behalf", () => {
    for (const user of ['a', '\r', '\x1b[A', '\x03', 'pasted text', '\x1b[<0;10;5M']) {
      expect(isUserInput(user)).toBe(true);
    }
    // Focus reports, device attributes, cursor position, OSC / DCS replies.
    for (const generated of [
      '\x1b[I',
      '\x1b[O',
      '\x1b[?62;22c',
      '\x1b[12;40R',
      '\x1b]11;rgb:0000/0000/0000\x1b\\',
      '\x1bP1$r0m\x1b\\',
      // DA2, a kitty keyboard-mode answer, a window size report, and two
      // replies in one chunk - what a joining laptop's replay makes xterm send.
      '\x1b[>0;276;0c',
      '\x1b[?1u',
      '\x1b[8;40;120t',
      '\x1b[?62;22c\x1b[12;40R',
      '',
    ]) {
      expect(isUserInput(generated)).toBe(false);
    }
  });

  it('sends a refit as passive, and as a claim right after typing', () => {
    resizePty('t1', 100, 30);
    noteTerminalInteraction('t1');
    resizePty('t1', 120, 40);
    expect(resize.mock.calls).toEqual([
      ['t1', 100, 30, 'passive'],
      ['t1', 120, 40, 'claim'],
    ]);
  });

  it("fits the xterm to another computer's grid - never the pty - and lets go when it is ours again", () => {
    const term = { cols: 80, rows: 24, resize: vi.fn() };
    startSharedGridFeed(() => term);
    gridListener!({ id: 't1', cols: 120, rows: 40, own: false });
    expect(term.resize).toHaveBeenCalledWith(120, 40);
    expect(resize).not.toHaveBeenCalled();
    expect(followedGrid('t1')).toEqual({ cols: 120, rows: 40 });
    gridListener!({ id: 't1', cols: 120, rows: 40, own: true });
    expect(followedGrid('t1')).toBeNull();
  });

  it('holds a followed grid on a refit nobody asked for, and lets a claim through (M4 review)', async () => {
    const { holdFollowedGrid } = await import('./shared-grid');
    const term = { cols: 80, rows: 24, resize: vi.fn() };
    expect(holdFollowedGrid('t9', term)).toBe(false);
    applyGrid('t9', { cols: 120, rows: 40, own: false }, undefined);
    expect(holdFollowedGrid('t9', term)).toBe(true);
    expect(term.resize).toHaveBeenCalledWith(120, 40);
    expect(resize).not.toHaveBeenCalled();
    noteTerminalInteraction('t9');
    expect(holdFollowedGrid('t9', term)).toBe(false);
  });

  it('takes a followed terminal back the moment the user types or clicks into it - and only then', () => {
    const refit = vi.fn();
    applyGrid('t1', { cols: 120, rows: 40, own: false }, undefined);
    // xterm answering a query is not the user.
    claimOnInteraction('t1', '\x1b[I', refit);
    expect(refit).not.toHaveBeenCalled();
    expect(followedGrid('t1')).not.toBeNull();
    claimOnInteraction('t1', 'l', refit);
    expect(refit).toHaveBeenCalledTimes(1);
    expect(followedGrid('t1')).toBeNull();
    // Not following any more: typing refits nothing.
    claimOnInteraction('t1', 's', refit);
    expect(refit).toHaveBeenCalledTimes(1);
    // A click counts as the user too.
    applyGrid('t1', { cols: 120, rows: 40, own: false }, undefined);
    claimOnInteraction('t1', null, refit);
    expect(refit).toHaveBeenCalledTimes(2);
  });
});
