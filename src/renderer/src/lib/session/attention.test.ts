import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The seen/unseen contract of the finished mark: 'finished' means "stopped
 * while you were away", so ONLY the user looking at the session may clear it -
 * opening it, or refocusing a window that already shows it. Nothing else.
 */

const { rows } = vi.hoisted(() => ({
  rows: new Map<string, { id: string; status: string }>(),
}));
vi.mock('@renderer/lib/collections', () => ({
  agentSessionsCollection: {
    get: (id: string) => rows.get(id),
    update: (id: string, mutate: (draft: { status: string }) => void) => {
      const row = rows.get(id);
      if (row) mutate(row);
    },
  },
}));

async function load() {
  vi.resetModules(); // focusedSessionId is module-level state
  return import('@renderer/lib/session/attention');
}

beforeEach(() => {
  rows.clear();
  rows.set('s1', { id: 's1', status: 'finished' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

describe('markSessionSeen', () => {
  it('clears the finished mark of the watched session to idle', async () => {
    const m = await load();
    m.setFocusedSession('s1');
    expect(rows.get('s1')!.status).toBe('idle');
  });

  it('does nothing for a session not on screen', async () => {
    const m = await load();
    m.setFocusedSession('other');
    m.markSessionSeen('s1');
    expect(rows.get('s1')!.status).toBe('finished');
  });

  it('does nothing while the window is unfocused - glancing needs focus', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const m = await load();
    m.setFocusedSession('s1');
    expect(rows.get('s1')!.status).toBe('finished');
  });

  it('leaves every other status alone', async () => {
    for (const status of ['idle', 'active', 'needs-input', 'archived']) {
      rows.set('s1', { id: 's1', status });
      const m = await load();
      m.setFocusedSession('s1');
      expect(rows.get('s1')!.status).toBe(status);
    }
  });

  it('clears the mark when the window regains focus on an open session', async () => {
    // The session finished while the app was in the background, its window
    // still showing it: coming back to the app IS looking at it.
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const m = await load();
    m.setFocusedSession('s1');
    expect(rows.get('s1')!.status).toBe('finished');
    focus.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    expect(rows.get('s1')!.status).toBe('idle');
  });
});

describe('isSessionWatched', () => {
  it('is true only for the focused session in a focused window', async () => {
    const m = await load();
    m.setFocusedSession('s1');
    expect(m.isSessionWatched('s1')).toBe(true);
    expect(m.isSessionWatched('other')).toBe(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(m.isSessionWatched('s1')).toBe(false);
  });
});
