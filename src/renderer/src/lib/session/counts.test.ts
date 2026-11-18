import { describe, expect, it } from 'vitest';
import {
  countedSessions,
  isLiveSessionStatus,
  projectSessionMeta,
} from '@renderer/lib/session/counts';

const PIPELINE = 'production-pipeline';
const DASHBOARD = 'web-dashboard';

function s(id: string, status: string, projectId: string | null = PIPELINE) {
  return { id, status, projectId };
}

describe('isLiveSessionStatus', () => {
  // This predicate is the whole point of the breathing status dot: the two
  // states worth looking at move, the parked ones don't. Widen it by accident
  // and every row in the sidebar pulses, which no colour assertion catches.
  it('is true while the agent is working', () => {
    expect(isLiveSessionStatus('active')).toBe(true);
  });

  it('is true while the agent is blocked on the user', () => {
    expect(isLiveSessionStatus('needs-input')).toBe(true);
  });

  it.each(['idle', 'done', 'archived'])('is false for %s', (status) => {
    expect(isLiveSessionStatus(status)).toBe(false);
  });
});

describe('countedSessions', () => {
  it('leaves archived sessions out of the tally', () => {
    const list = [s('a', 'active'), s('b', 'archived'), s('c', 'idle')];
    expect(countedSessions(list).map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('keeps every live status, including the legacy done one', () => {
    const list = [s('a', 'idle'), s('b', 'active'), s('c', 'needs-input'), s('d', 'done')];
    expect(countedSessions(list)).toHaveLength(4);
  });
});

describe('projectSessionMeta', () => {
  it('counts a project by its live sessions only', () => {
    const meta = projectSessionMeta([
      s('a', 'idle'),
      s('b', 'archived'),
      s('c', 'archived'),
      s('d', 'needs-input'),
    ]);
    expect(meta.get(PIPELINE)?.count).toBe(2);
  });

  it('drops a project from the map once all its sessions are archived', () => {
    // The panel renders "-" for a missing entry, so an archive-everything
    // project must not keep showing a number.
    const meta = projectSessionMeta([s('a', 'archived'), s('b', 'archived')]);
    expect(meta.has(PIPELINE)).toBe(false);
  });

  it('flags running and waiting projects for the status dot', () => {
    const meta = projectSessionMeta([
      s('a', 'active'),
      s('b', 'idle'),
      s('c', 'needs-input', DASHBOARD),
      s('d', 'idle', DASHBOARD),
    ]);
    expect(meta.get(PIPELINE)).toEqual({
      count: 2,
      active: true,
      needsInput: false,
      finished: false,
    });
    expect(meta.get(DASHBOARD)).toEqual({
      count: 2,
      active: false,
      needsInput: true,
      finished: false,
    });
  });

  it('leaves a project with only idle live sessions dot-free', () => {
    const meta = projectSessionMeta([s('a', 'archived'), s('b', 'idle')]);
    expect(meta.get(PIPELINE)).toEqual({
      count: 1,
      active: false,
      needsInput: false,
      finished: false,
    });
  });

  it('skips sessions with no project', () => {
    const meta = projectSessionMeta([s('a', 'active', null), s('b', 'active')]);
    expect(meta.size).toBe(1);
    expect(meta.get(PIPELINE)?.count).toBe(1);
  });
});

describe('the finished-unseen roll-up', () => {
  it('flags a project holding a session that finished while the user was away', () => {
    const meta = projectSessionMeta([s('a', 'finished'), s('b', 'idle')]);
    expect(meta.get(PIPELINE)).toEqual({
      count: 2,
      active: false,
      needsInput: false,
      finished: true,
    });
  });

  it('keeps the finished dot still - not a live status', () => {
    // The mark asks for a glance, not attention: no breathing halo, no band.
    expect(isLiveSessionStatus('finished')).toBe(false);
  });
});
