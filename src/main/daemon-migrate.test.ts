import { describe, expect, it } from 'vitest';
import {
  AUTO_MOVE_IDLE_MS,
  autoMovable,
  daemonRows,
  isBusy,
  neverMovesByItself,
  olderBuildIds,
  trackIdle,
  wouldLoseConversation,
  type MoveProbe,
} from './daemon-migrate';
import type { DaemonInfo } from './terminal-backend';

const daemon = (buildId: string, current: boolean, ids: string[]): DaemonInfo => ({
  socketPath: `/tmp/d/daemon-v1-${buildId}.sock`,
  buildId,
  current,
  ids,
});
const agent = (id: string, status: MoveProbe['status']): MoveProbe => ({
  id,
  marker: true,
  status,
  foregroundBusy: false,
  resumable: true,
});
const shell = (id: string, foregroundBusy: boolean): MoveProbe => ({
  id,
  marker: false,
  status: null,
  foregroundBusy,
  resumable: false,
});

describe('olderBuildIds', () => {
  it("lists what older builds' daemons hold, never this build's", () => {
    const d = [
      daemon('0.7.7', true, ['a']),
      daemon('0.7.6', false, ['b', 'c']),
      daemon('0.7.4', false, ['d']),
    ];
    expect(olderBuildIds(d)).toEqual(['b', 'c', 'd']);
  });

  it('moves nothing while this build has no daemon to move to', () => {
    // A daemon that failed to start: the old ones are all there is.
    expect(olderBuildIds([daemon('0.7.6', false, ['b'])])).toEqual([]);
    expect(olderBuildIds([])).toEqual([]);
  });
});

describe('neverMovesByItself', () => {
  it('keeps setup and Commands shells: a fresh one would run its command again or lose its output', () => {
    expect(neverMovesByItself('setup:s1')).toBe(true);
    expect(neverMovesByItself('commands:s1:test')).toBe(true);
    expect(neverMovesByItself('host-signin:h:claude:n')).toBe(true);
    expect(neverMovesByItself('conversation:s1')).toBe(false);
    expect(neverMovesByItself('7d0c1e2a-tab')).toBe(false);
  });
});

describe('isBusy', () => {
  it('reads an agent by its status and a plain shell by its foreground program', () => {
    expect(isBusy(agent('a', 'running'))).toBe(true);
    expect(isBusy(agent('a', 'needs-input'))).toBe(true);
    expect(isBusy(agent('a', 'idle'))).toBe(false);
    // A marker-driven terminal with no status yet is not known idle.
    expect(isBusy(agent('a', null))).toBe(true);
    expect(isBusy(shell('s', true))).toBe(true);
    expect(isBusy(shell('s', false))).toBe(false);
  });
});

describe('trackIdle + autoMovable', () => {
  const t0 = 1_000_000;

  it('moves an agent only once it has sat idle for the whole wait', () => {
    let since = trackIdle(new Map(), [agent('a', 'idle')], t0);
    expect(autoMovable([agent('a', 'idle')], since, t0)).toEqual([]);
    since = trackIdle(since, [agent('a', 'idle')], t0 + AUTO_MOVE_IDLE_MS - 1);
    expect(autoMovable([agent('a', 'idle')], since, t0 + AUTO_MOVE_IDLE_MS - 1)).toEqual([]);
    since = trackIdle(since, [agent('a', 'idle')], t0 + AUTO_MOVE_IDLE_MS);
    expect(autoMovable([agent('a', 'idle')], since, t0 + AUTO_MOVE_IDLE_MS)).toEqual(['a']);
  });

  it('starts the wait over after any turn - an idle agent may still run a background shell', () => {
    let since = trackIdle(new Map(), [agent('a', 'idle')], t0);
    since = trackIdle(since, [agent('a', 'running')], t0 + 5 * 60_000);
    expect(since.has('a')).toBe(false);
    since = trackIdle(since, [agent('a', 'idle')], t0 + 6 * 60_000);
    const late = t0 + 6 * 60_000 + AUTO_MOVE_IDLE_MS - 1;
    expect(autoMovable([agent('a', 'idle')], since, late)).toEqual([]);
  });

  it('never moves a plain shell or a setup / Commands shell by itself', () => {
    const probes = [
      shell('plain', false),
      agent('setup:s1', 'idle'),
      agent('commands:s1:dev', 'idle'),
    ];
    const since = trackIdle(new Map(), probes, t0);
    expect(autoMovable(probes, since, t0 + 10 * AUTO_MOVE_IDLE_MS)).toEqual([]);
  });

  // Codex has no continuity yet, and an agent typed by hand into a shell has
  // no record and no start command: moved, either would simply be gone.
  it('never moves an agent whose conversation the fresh start cannot resume', () => {
    const codex = { ...agent('conversation:c', 'idle'), resumable: false };
    const since = trackIdle(new Map(), [codex], t0);
    expect(autoMovable([codex], since, t0 + 10 * AUTO_MOVE_IDLE_MS)).toEqual([]);
    expect(wouldLoseConversation(codex)).toBe(true);
    expect(wouldLoseConversation(agent('conversation:a', 'idle'))).toBe(false);
    // A busy one is counted as busy, not as lost.
    expect(wouldLoseConversation({ ...codex, status: 'running' })).toBe(false);
  });

  it('forgets a terminal no longer probed (moved, closed, opened by a window)', () => {
    const since = trackIdle(new Map([['gone', t0]]), [agent('a', 'idle')], t0 + 1);
    expect([...since.keys()]).toEqual(['a']);
  });
});

describe('daemonRows', () => {
  it("counts each daemon's terminals and busy ones, this build first", () => {
    const rows = daemonRows(
      [daemon('0.7.6', false, ['a', 'b', 'c']), daemon('0.7.7', true, ['d'])],
      [agent('a', 'running'), agent('b', 'idle'), shell('c', true), agent('d', 'needs-input')],
    );
    expect(rows).toEqual([
      {
        socketPath: '/tmp/d/daemon-v1-0.7.7.sock',
        buildId: '0.7.7',
        current: true,
        terminals: 1,
        busy: 1,
      },
      {
        socketPath: '/tmp/d/daemon-v1-0.7.6.sock',
        buildId: '0.7.6',
        current: false,
        terminals: 3,
        busy: 2,
      },
    ]);
  });
});
