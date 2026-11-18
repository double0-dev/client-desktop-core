import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { presentImperative, unmountClosedImperativeRoots } from '@renderer/lib/imperative-root';

afterEach(() => {
  vi.useRealTimers();
});

/** Opens a root showing `<p>{label}</p>` and hands back its `done`. */
function open(label: string): { answer: Promise<string>; done: (v: string) => void } {
  let done: (v: string) => void = () => {};
  let answer!: Promise<string>;
  act(() => {
    answer = presentImperative<string>((d) => {
      done = d;
      return <p>{label}</p>;
    });
  });
  return { answer, done };
}

const shown = (label: string): boolean =>
  [...document.body.querySelectorAll('p')].some((p) => p.textContent === label);

describe('presentImperative', () => {
  it('resolves with the answer and keeps the root through the close animation', async () => {
    vi.useFakeTimers();
    const { answer, done } = open('Delete?');
    expect(shown('Delete?')).toBe(true);
    act(() => done('yes'));
    await expect(answer).resolves.toBe('yes');
    // Still mounted while the close animation plays.
    expect(shown('Delete?')).toBe(true);
    act(() => vi.advanceTimersByTime(250));
    expect(shown('Delete?')).toBe(false);
  });

  it('unmounts an answered root at once when flushed, and its timer never fires again', () => {
    vi.useFakeTimers();
    const { done } = open('Remove worktree?');
    act(() => done('no'));
    expect(vi.getTimerCount()).toBe(1);
    // What the renderer test setup does after every test: a timer left
    // pending fired after the environment was torn down (v0.7.0 / v0.7.1).
    act(() => unmountClosedImperativeRoots());
    expect(shown('Remove worktree?')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves a dialog that has not answered yet mounted', () => {
    const { done } = open('Still open');
    act(() => unmountClosedImperativeRoots());
    expect(shown('Still open')).toBe(true);
    act(() => done('closed'));
    act(() => unmountClosedImperativeRoots());
    expect(shown('Still open')).toBe(false);
  });
});
