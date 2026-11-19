import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CRASH_LOOP_MS,
  beginBoot,
  endStartFresh,
  isStartingFresh,
  noteCrashScreen,
  requestStartFresh,
  resetStartFreshForTest,
  startFreshRequested,
} from './start-fresh';

/**
 * A window that crashes as it opens must have a way out: a plain reload
 * restores the view that crashed it. "Start fresh" skips that restore for
 * exactly one boot, and a second crash right after a reload asks for it by
 * itself.
 */

beforeEach(() => {
  resetStartFreshForTest();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  resetStartFreshForTest();
  window.sessionStorage.clear();
});

describe('start fresh', () => {
  it('applies to the next boot only, then the window restores as usual', () => {
    beginBoot(1_000);
    expect(isStartingFresh()).toBe(false);
    requestStartFresh();
    expect(startFreshRequested()).toBe(true);
    // The reload.
    expect(beginBoot(2_000)).toBe(true);
    expect(isStartingFresh()).toBe(true);
    // Read once: the request is gone, so the boot after that restores again.
    expect(startFreshRequested()).toBe(false);
    expect(beginBoot(3_000)).toBe(false);
  });

  it('ends once the user opens something', () => {
    requestStartFresh();
    beginBoot(1_000);
    endStartFresh();
    expect(isStartingFresh()).toBe(false);
  });
});

describe('the crash loop breaker', () => {
  it('starts the next boot fresh when the window crashes again right after a reload', () => {
    beginBoot(10_000);
    // The first crash is no loop: Reload is still worth a try.
    expect(noteCrashScreen(12_000)).toBe(false);
    expect(startFreshRequested()).toBe(false);
    // Reload, and it crashes again within the window.
    beginBoot(20_000);
    expect(noteCrashScreen(20_000 + CRASH_LOOP_MS - 1)).toBe(true);
    expect(startFreshRequested()).toBe(true);
    // The next reload starts fresh by itself.
    expect(beginBoot(40_000)).toBe(true);
  });

  it('does not trip on a crash long after the reload', () => {
    beginBoot(10_000);
    noteCrashScreen(12_000);
    beginBoot(20_000);
    expect(noteCrashScreen(20_000 + CRASH_LOOP_MS + 1)).toBe(false);
    expect(startFreshRequested()).toBe(false);
  });

  it('forgets an old crash once a boot ran a while without one', () => {
    // A crash, a reload that worked for minutes, then a reload for any other
    // reason and an unrelated quick crash: no loop.
    vi.useFakeTimers();
    beginBoot(10_000);
    noteCrashScreen(12_000);
    beginBoot(20_000);
    vi.advanceTimersByTime(CRASH_LOOP_MS + 1);
    beginBoot(500_000);
    expect(noteCrashScreen(501_000)).toBe(false);
  });

  it('keeps the crash while the user reads the screen, however long before Reload', () => {
    // The forget timer erased the mark of a boot that HAD crashed (its flag
    // read false, not "no crash yet"), so anyone who read the screen for
    // 15 s before pressing Reload never got out of the loop.
    vi.useFakeTimers();
    beginBoot(10_000);
    expect(noteCrashScreen(11_000)).toBe(false);
    vi.advanceTimersByTime(CRASH_LOOP_MS + 500);
    beginBoot(40_000);
    expect(noteCrashScreen(41_000)).toBe(true);
    expect(startFreshRequested()).toBe(true);
  });

  it('counts one crash per boot however often the screen renders', () => {
    beginBoot(10_000);
    noteCrashScreen(11_000);
    beginBoot(20_000);
    expect(noteCrashScreen(21_000)).toBe(true);
    // A second render of the screen (StrictMode, a second boundary) adds nothing.
    expect(noteCrashScreen(21_500)).toBe(true);
  });
});
