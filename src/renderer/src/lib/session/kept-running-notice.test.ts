import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';
import {
  countKeptRunning,
  keptRunningNoticeText,
  sessionOfTerminalId,
} from '@renderer/lib/session/kept-running-notice';

/**
 * The kept-running launch notice: which sessions the daemon's terminals
 * belong to, how the notice words it, and the once-per-window store behind
 * the banner.
 */

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

describe('sessionOfTerminalId', () => {
  it('reads the session off the eager and command shells, not off a shell tab', () => {
    expect(sessionOfTerminalId(`conversation:${S1}`)).toBe(S1);
    expect(sessionOfTerminalId(`setup:${S1}`)).toBe(S1);
    expect(sessionOfTerminalId(`commands:${S2}:lint`)).toBe(S2);
    expect(sessionOfTerminalId('7f3a9c2e-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('countKeptRunning', () => {
  it('counts distinct sessions across their terminals', () => {
    expect(
      countKeptRunning([`conversation:${S1}`, `commands:${S1}:dev`, `conversation:${S2}`]),
    ).toEqual({ sessions: 2, terminals: 3, unmapped: 0 });
  });

  it('maps a shell tab to its session through the persisted layouts', () => {
    const layouts = [
      { sessionId: S1, layout: { tabs: { t1: { ptyId: 'shell-a' }, t2: { ptyId: 'shell-b' } } } },
      // A layout the server could not decode must not break the count.
      { sessionId: S2, layout: null },
    ];
    expect(countKeptRunning(['shell-a', 'shell-b', `conversation:${S2}`], layouts)).toEqual({
      sessions: 2,
      terminals: 3,
      unmapped: 0,
    });
  });

  it('counts a terminal no layout knows as unmapped', () => {
    expect(countKeptRunning([`conversation:${S1}`, 'orphan-shell'])).toEqual({
      sessions: 1,
      terminals: 2,
      unmapped: 1,
    });
  });
});

describe('keptRunningNoticeText', () => {
  it('counts sessions when every terminal has one, singular and plural', () => {
    expect(keptRunningNoticeText({ sessions: 1, terminals: 2, unmapped: 0 })).toBe(
      '1 session kept running while double0 was closed',
    );
    expect(keptRunningNoticeText({ sessions: 3, terminals: 5, unmapped: 0 })).toBe(
      '3 sessions kept running while double0 was closed',
    );
  });

  it('falls back to terminals when one could not be placed', () => {
    expect(keptRunningNoticeText({ sessions: 1, terminals: 2, unmapped: 1 })).toBe(
      '2 terminals kept running while double0 was closed',
    );
    expect(keptRunningNoticeText({ sessions: 0, terminals: 1, unmapped: 1 })).toBe(
      '1 terminal kept running while double0 was closed',
    );
  });
});

describe('the notice store', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function load(answer: { terminalIds: string[] } | null, layouts: unknown[] = []) {
    const launchNotice = vi.fn(async () => answer);
    const list = vi.fn(async () => layouts);
    stubApi({
      sessions: { setKeepRunning: vi.fn(), stopAll: vi.fn(), launchNotice },
      layout: { list, save: vi.fn() },
    });
    const scope = await import('@renderer/lib/workspace/project-scope');
    const store = await import('@renderer/lib/session/kept-running-notice');
    return { store, scope, launchNotice, list };
  }

  it('asks main once on first use and words the answer', async () => {
    const { store, launchNotice } = await load({
      terminalIds: [`conversation:${S1}`, `conversation:${S2}`],
    });
    const first = renderHook(() => store.useKeptRunningNotice());
    const second = renderHook(() => store.useKeptRunningNotice());
    expect(first.result.current).toBeNull();
    await act(async () => {});
    expect(first.result.current).toEqual({
      text: '2 sessions kept running while double0 was closed',
    });
    // Two banners (two mounted session views) share one answer.
    expect(second.result.current).toEqual(first.result.current);
    expect(launchNotice).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when main has nothing to say', async () => {
    const { store } = await load(null);
    const { result } = renderHook(() => store.useKeptRunningNotice());
    await act(async () => {});
    expect(result.current).toBeNull();
  });

  it('never asks from a project window - the notice belongs to the main window', async () => {
    const { store, scope, launchNotice } = await load({ terminalIds: [`conversation:${S1}`] });
    scope.setProjectScope({ projectId: 'p1', projectName: 'acme' });
    const { result } = renderHook(() => store.useKeptRunningNotice());
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(launchNotice).not.toHaveBeenCalled();
  });

  it('dismissing hides it for the window, and nothing re-asks', async () => {
    const { store, launchNotice } = await load({ terminalIds: [`conversation:${S1}`] });
    const { result, unmount } = renderHook(() => store.useKeptRunningNotice());
    await act(async () => {});
    expect(result.current).not.toBeNull();
    act(() => store.dismissKeptRunningNotice());
    expect(result.current).toBeNull();
    unmount();
    const again = renderHook(() => store.useKeptRunningNotice());
    await act(async () => {});
    expect(again.result.current).toBeNull();
    expect(launchNotice).toHaveBeenCalledTimes(1);
  });
});
