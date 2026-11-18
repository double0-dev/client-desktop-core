import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdleExitWatch, isIdle } from './idle-exit';

afterEach(() => vi.useRealTimers());

describe('isIdle', () => {
  it('is idle only with no terminals and no clients', () => {
    expect(isIdle({ terminals: 0, clients: 0 })).toBe(true);
    expect(isIdle({ terminals: 1, clients: 0 })).toBe(false);
    expect(isIdle({ terminals: 0, clients: 1 })).toBe(false);
  });
});

describe('IdleExitWatch', () => {
  it('exits once the grace elapsed with the daemon idle throughout', () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const watch = new IdleExitWatch(1000, onExit);
    watch.update({ terminals: 0, clients: 0 });
    expect(watch.armed).toBe(true);
    vi.advanceTimersByTime(999);
    expect(onExit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(watch.armed).toBe(false);
  });

  it('cancels the exit when a client or a terminal shows up within the grace', () => {
    // An app that quits and relaunches (an update) reconnects within seconds;
    // the daemon must still be there with its terminals.
    vi.useFakeTimers();
    const onExit = vi.fn();
    const watch = new IdleExitWatch(1000, onExit);
    watch.update({ terminals: 0, clients: 0 });
    vi.advanceTimersByTime(800);
    watch.update({ terminals: 0, clients: 1 });
    expect(watch.armed).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(onExit).not.toHaveBeenCalled();
    // Idle again: a fresh full grace, not the remainder.
    watch.update({ terminals: 0, clients: 0 });
    vi.advanceTimersByTime(999);
    expect(onExit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('keeps one timer across repeated idle updates and stops on dispose', () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const watch = new IdleExitWatch(1000, onExit);
    watch.update({ terminals: 0, clients: 0 });
    vi.advanceTimersByTime(600);
    watch.update({ terminals: 0, clients: 0 });
    vi.advanceTimersByTime(400);
    expect(onExit).toHaveBeenCalledTimes(1);
    const second = new IdleExitWatch(1000, onExit);
    second.update({ terminals: 0, clients: 0 });
    second.dispose();
    vi.advanceTimersByTime(2000);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
