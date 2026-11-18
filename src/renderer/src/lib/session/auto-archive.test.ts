import { describe, expect, it } from 'vitest';
import { expiredArchivedSessionIds, newlyExpiredSessions, staleSessionIds } from './auto-archive';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const now = Date.UTC(2026, 7, 25, 12);

function session(id: string, ageMs: number, status = 'idle') {
  return { id, status, updatedAt: new Date(now - ageMs) };
}

describe('staleSessionIds', () => {
  it('picks sessions untouched for longer than the threshold and leaves fresher ones', () => {
    const sessions = [
      session('fresh', 1 * DAY),
      session('six-days', 6 * DAY),
      session('eight-days', 8 * DAY),
      session('needs-input-old', 9 * DAY, 'needs-input'),
    ];
    expect(staleSessionIds(sessions, now, WEEK)).toEqual(['eight-days', 'needs-input-old']);
  });

  it('follows the configured threshold', () => {
    const sessions = [session('five-hours', 5 * HOUR), session('two-days', 2 * DAY)];
    expect(staleSessionIds(sessions, now, 4 * HOUR)).toEqual(['five-hours', 'two-days']);
    expect(staleSessionIds(sessions, now, 1 * DAY)).toEqual(['two-days']);
    expect(staleSessionIds(sessions, now, 3 * DAY)).toEqual([]);
  });

  it('is strictly past the threshold - exactly one week old stays', () => {
    expect(staleSessionIds([session('edge', WEEK)], now, WEEK)).toEqual([]);
    expect(staleSessionIds([session('edge', WEEK + 1)], now, WEEK)).toEqual(['edge']);
  });

  it('never touches an already archived session', () => {
    expect(staleSessionIds([session('old', 30 * DAY, 'archived')], now, WEEK)).toEqual([]);
  });

  it('accepts updatedAt as an ISO string (how it arrives over IPC)', () => {
    const s = { id: 'iso', status: 'idle', updatedAt: new Date(now - 10 * DAY).toISOString() };
    expect(staleSessionIds([s], now, WEEK)).toEqual(['iso']);
  });
});

describe('expiredArchivedSessionIds', () => {
  function archived(id: string, archivedAgoMs: number | null, status = 'archived') {
    return {
      id,
      status,
      // updatedAt is deliberately fresh: a rename in the archive bumps it, and
      // must not restart - or stand in for - the archive clock.
      updatedAt: new Date(now - HOUR),
      archivedAt: archivedAgoMs == null ? null : new Date(now - archivedAgoMs),
    };
  }

  it('counts from the archive date, not the last write', () => {
    const sessions = [archived('long-ago', 31 * DAY), archived('recent', 29 * DAY)];
    expect(expiredArchivedSessionIds(sessions, now, 30 * DAY)).toEqual(['long-ago']);
  });

  it('is strictly past the threshold', () => {
    expect(expiredArchivedSessionIds([archived('edge', 30 * DAY)], now, 30 * DAY)).toEqual([]);
    expect(expiredArchivedSessionIds([archived('edge', 30 * DAY + 1)], now, 30 * DAY)).toEqual([
      'edge',
    ]);
  });

  it('never deletes a session that is out of the archive, whatever it carries', () => {
    // The stamp is cleared on unarchive, but a stale optimistic row may still hold it.
    expect(expiredArchivedSessionIds([archived('back', 90 * DAY, 'idle')], now, DAY)).toEqual([]);
  });

  it('never deletes an archived session with no archive date', () => {
    expect(expiredArchivedSessionIds([archived('unknown', null)], now, HOUR)).toEqual([]);
  });

  it('accepts archivedAt as an ISO string', () => {
    const s = { ...archived('iso', 0), archivedAt: new Date(now - 3 * DAY).toISOString() };
    expect(expiredArchivedSessionIds([s], now, 2 * DAY)).toEqual(['iso']);
  });
});

describe('newlyExpiredSessions', () => {
  const at = (id: string, archivedAgoMs: number) => ({
    id,
    status: 'archived',
    updatedAt: new Date(now),
    archivedAt: new Date(now - archivedAgoMs),
  });
  const sessions = [at('ten-days', 10 * DAY), at('forty-days', 40 * DAY), at('an-hour', HOUR)];
  const off = { autoDelete: false, deleteAfterMs: 30 * DAY };
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it('turning deletion on names every session it would delete at once', () => {
    expect(ids(newlyExpiredSessions(sessions, now, off, { ...off, autoDelete: true }))).toEqual([
      'forty-days',
    ]);
  });

  it('shortening the time names only the sessions the old time kept', () => {
    const thirty = { autoDelete: true, deleteAfterMs: 30 * DAY };
    const week = { autoDelete: true, deleteAfterMs: 7 * DAY };
    expect(ids(newlyExpiredSessions(sessions, now, thirty, week))).toEqual(['ten-days']);
  });

  it('lengthening the time or turning deletion off asks nothing', () => {
    const week = { autoDelete: true, deleteAfterMs: 7 * DAY };
    const thirty = { autoDelete: true, deleteAfterMs: 30 * DAY };
    expect(newlyExpiredSessions(sessions, now, week, thirty)).toEqual([]);
    expect(newlyExpiredSessions(sessions, now, week, off)).toEqual([]);
  });
});
