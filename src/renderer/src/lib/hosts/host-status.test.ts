import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import { bridgeSlots } from '@renderer/test-support';
import {
  applyHostStatuses,
  getHostStatus,
  onHostConnected,
  refreshHostStatuses,
  resetHostStatusesForTest,
  startHostStatusFeed,
  waitForHostStatus,
  type HostStatus,
} from './host-status';

// Core reads the hosts and session-view bridges through the extension's slots.
beforeEach(() => installRendererExtension(bridgeSlots()));
afterEach(() => resetRendererExtensionForTest());

/**
 * The shared "this host is connected again" hook every renderer surface that
 * read a host while it was away retries through (the language clients, the
 * explorer, an editor that failed to load).
 */

const status = (id: string, state: HostStatus['state']): HostStatus =>
  ({ id, state, message: null, details: null, facts: null, since: null }) as HostStatus;

afterEach(() => resetHostStatusesForTest());

describe('onHostConnected', () => {
  it('fires each time a host turns connected, never while it stays connected', () => {
    const seen: string[] = [];
    const off = onHostConnected((id) => seen.push(id));
    applyHostStatuses([status('build-box', 'connecting')]);
    expect(seen).toEqual([]);
    applyHostStatuses([status('build-box', 'connected')]);
    expect(seen).toEqual(['build-box']);
    // Another push with nothing new for it (a second host changed).
    applyHostStatuses([status('build-box', 'connected'), status('gpu-box', 'connecting')]);
    expect(seen).toEqual(['build-box']);
    // A drop and a reconnect: once more.
    applyHostStatuses([status('build-box', 'unreachable')]);
    applyHostStatuses([status('build-box', 'connected')]);
    expect(seen).toEqual(['build-box', 'build-box']);
    off();
    applyHostStatuses([status('build-box', 'idle')]);
    applyHostStatuses([status('build-box', 'connected')]);
    expect(seen).toEqual(['build-box', 'build-box']);
  });

  /**
   * A relaunch: the explorer read the host before this window heard any
   * status, and the first answer already says connected - that read must be
   * retried too, or it stays on "Host is unreachable".
   */
  it('fires for a host already connected in the first answer', () => {
    const seen: string[] = [];
    onHostConnected((id) => seen.push(id));
    applyHostStatuses([status('build-box', 'connected')]);
    expect(seen).toEqual(['build-box']);
  });

  it('has the new state in place when a listener runs', () => {
    const states: Array<string | undefined> = [];
    onHostConnected((id) => states.push(getHostStatus(id)?.state));
    applyHostStatuses([status('build-box', 'connected')]);
    expect(states).toEqual(['connected']);
  });

  it('subscribes to main once when the first listener comes', () => {
    const onChanged = vi.fn();
    const statuses = vi.fn(async () => [status('build-box', 'connected')]);
    const w = window as unknown as { api?: unknown };
    const before = w.api;
    w.api = { hosts: { onChanged, statuses } };
    try {
      onHostConnected(() => undefined);
      onHostConnected(() => undefined);
      expect(onChanged).toHaveBeenCalledTimes(1);
    } finally {
      w.api = before;
    }
  });

  // The core build has no hosts bridge (a private plan › M7): no host ever
  // reports, and the feed starts later if the bridge shows up after all.
  it('stays quiet with no hosts bridge, and subscribes once one is there', () => {
    const w = window as unknown as { api?: unknown };
    const before = w.api;
    w.api = {};
    try {
      expect(() => onHostConnected(() => undefined)).not.toThrow();
      expect(getHostStatus('build-box')).toBeNull();
      const onChanged = vi.fn();
      w.api = { hosts: { onChanged, statuses: vi.fn(async () => []) } };
      onHostConnected(() => undefined);
      expect(onChanged).toHaveBeenCalledTimes(1);
    } finally {
      w.api = before;
    }
  });
});

describe('waitForHostStatus', () => {
  it('resolves at once when the status already passes, later when a change does', async () => {
    applyHostStatuses([status('h1', 'connected')]);
    expect(await waitForHostStatus('h1', (s) => s.state === 'connected', 1000)).toMatchObject({
      state: 'connected',
    });
    const later = waitForHostStatus('h1', (s) => s.state === 'unreachable', 1000);
    applyHostStatuses([status('h1', 'unreachable')]);
    expect(await later).toMatchObject({ state: 'unreachable' });
  });

  it('resolves null at the timeout and stops listening', async () => {
    vi.useFakeTimers();
    try {
      const test = vi.fn((s: HostStatus) => s.state === 'unreachable');
      const waiting = waitForHostStatus('h1', test, 30_000);
      vi.advanceTimersByTime(30_000);
      expect(await waiting).toBeNull();
      test.mockClear();
      applyHostStatuses([status('h1', 'unreachable')]);
      expect(test).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('refreshHostStatuses', () => {
  // The feed asks main once per window and then follows its pushes. An
  // extension may refuse that first ask (its feature locked) and push
  // nothing afterwards: it asks the feed to read again once it would answer.
  it('asks main again for the statuses, without a second push subscription', async () => {
    const statuses = vi
      .fn<() => Promise<HostStatus[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([status('build-box', 'connected')]);
    const onChanged = vi.fn(() => () => {});
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { hosts: { statuses, onChanged } },
    });
    startHostStatusFeed();
    await vi.waitFor(() => expect(statuses).toHaveBeenCalledTimes(1));
    expect(getHostStatus('build-box')).toBeNull();
    refreshHostStatuses();
    await vi.waitFor(() => expect(getHostStatus('build-box')?.state).toBe('connected'));
    expect(onChanged).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(window, 'api');
  });

  it('does nothing before the feed started - the first ask is still to come', () => {
    const statuses = vi.fn(async () => []);
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { hosts: { statuses, onChanged: () => () => {} } },
    });
    refreshHostStatuses();
    expect(statuses).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, 'api');
  });
});
