import { describe, expect, it } from 'vitest';
import { layoutPtyIds, staleBusySessionIds } from './stale-sessions';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const TAB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('layoutPtyIds', () => {
  it('reads the pty ids off a persisted layout and tolerates garbage', () => {
    expect(
      layoutPtyIds({
        tabs: { t1: { ptyId: TAB, title: 'zsh' }, t2: { kind: 'editor' }, t3: null },
      }),
    ).toEqual([TAB]);
    expect(layoutPtyIds(null)).toEqual([]);
    expect(layoutPtyIds({ tabs: 'nope' })).toEqual([]);
    expect(layoutPtyIds('x')).toEqual([]);
  });
});

describe('staleBusySessionIds', () => {
  const sessions = [
    { id: S1, status: 'active' },
    { id: S2, status: 'needs-input' },
    { id: S3, status: 'idle' },
  ];

  it('leaves runtime sessions to their extension', () => {
    expect(
      staleBusySessionIds([{ id: S1, status: 'active', runtime: 'gadget-runtime' }], [], []),
    ).toEqual([]);
  });

  it('picks busy sessions none of whose terminals is alive', () => {
    // S1's conversation shell lives on in the daemon; S2 has nothing left.
    expect(staleBusySessionIds(sessions, [], [`conversation:${S1}`])).toEqual([S2]);
  });

  it('counts a layout tab, the setup shell and a command shell as alive', () => {
    const layouts = [{ sessionId: S1, layout: { tabs: { t: { ptyId: TAB } } } }];
    expect(staleBusySessionIds(sessions, layouts, [TAB])).toEqual([S2]);
    expect(staleBusySessionIds(sessions, [], [`setup:${S2}`])).toEqual([S1]);
    expect(staleBusySessionIds(sessions, [], [`commands:${S2}:build`])).toEqual([S1]);
  });

  it('never touches idle, finished or archived sessions, and resets every busy one with nothing live', () => {
    expect(staleBusySessionIds(sessions, [], [])).toEqual([S1, S2]);
    expect(
      staleBusySessionIds(
        [
          { id: S3, status: 'finished' },
          { id: S1, status: 'archived' },
        ],
        [],
        [],
      ),
    ).toEqual([]);
  });

  it('judges only the sessions of its own host', () => {
    // a private plan › 15: the boot sweep knows only
    // this machine's terminals - a remote session whose host has not answered
    // yet must keep its status, not be reset for lacking a LOCAL terminal.
    const remote = [
      { id: S1, status: 'active', projectId: 'local-project' },
      { id: S2, status: 'needs-input', projectId: 'acme-on-build-box' },
      { id: S3, status: 'active', projectId: null },
    ];
    const hostOfProject = (projectId: string): string | null =>
      projectId === 'acme-on-build-box' ? 'build-box' : null;
    expect(staleBusySessionIds(remote, [], [], { hostId: null, hostOfProject })).toEqual([S1, S3]);
    // Once build-box lists its terminals, its own sweep judges S2 alone.
    expect(staleBusySessionIds(remote, [], [], { hostId: 'build-box', hostOfProject })).toEqual([
      S2,
    ]);
    expect(
      staleBusySessionIds(remote, [], [`conversation:${S2}`], {
        hostId: 'build-box',
        hostOfProject,
      }),
    ).toEqual([]);
    // No filter: every busy session, as before.
    expect(staleBusySessionIds(remote, [], [])).toEqual([S1, S2, S3]);
  });
});
