import { describe, expect, it, vi } from 'vitest';
import { createRelaunchOnQuit } from './relaunch-on-quit';

describe('a restart held until the quit is certain', () => {
  it('runs nothing when agreed - only when the quit goes through', () => {
    const relaunch = vi.fn();
    const before = vi.fn();
    const r = createRelaunchOnQuit(relaunch);
    expect(r.arm({ beforeRelaunch: before })).toBe(true);
    expect(before).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(r.commit()).toBe(true);
    expect(before).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    // Once: a second quit pass relaunches nothing more.
    expect(r.commit()).toBe(false);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('drops a restart whose quit was called off, so a later quit never runs it', () => {
    // An unsaved editor refused to close after the user agreed: the restart
    // (and what it prepares - a fresh start's marker) must not happen at the
    // next ordinary quit, hours later.
    const relaunch = vi.fn();
    const before = vi.fn();
    const aborted = vi.fn();
    const r = createRelaunchOnQuit(relaunch);
    r.arm({ beforeRelaunch: before, onAborted: aborted });
    r.abort();
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(r.held()).toBe(false);
    expect(r.commit()).toBe(false);
    expect(before).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('holds one restart at a time', () => {
    const r = createRelaunchOnQuit(vi.fn());
    expect(r.arm({ beforeRelaunch: vi.fn() })).toBe(true);
    expect(r.arm({ beforeRelaunch: vi.fn() })).toBe(false);
  });

  it('quits without relaunching when the preparation fails', () => {
    const relaunch = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = createRelaunchOnQuit(relaunch);
    r.arm({
      beforeRelaunch: () => {
        throw new Error('disk full');
      },
    });
    expect(r.commit()).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
