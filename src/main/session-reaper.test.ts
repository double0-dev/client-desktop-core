import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { groupAndSession, parseTpgid, systemReaper, tpgidFromProcStat } from './session-reaper';

describe('parseTpgid', () => {
  it("reads ps' tpgid column, none for a shell with no terminal", () => {
    expect(parseTpgid('  54531\n')).toBe(54531);
    expect(parseTpgid('100000')).toBe(100000);
    expect(parseTpgid('0')).toBeNull();
    expect(parseTpgid('-1')).toBeNull();
    expect(parseTpgid('')).toBeNull();
  });
});

describe('tpgidFromProcStat', () => {
  it('counts fields from the last parenthesis - a command name may hold both', () => {
    // pid (comm) state ppid pgrp session tty_nr tpgid flags …
    expect(tpgidFromProcStat('4242 (zsh) S 900 4242 4242 34816 5300 4194560 0 0')).toBe(5300);
    expect(tpgidFromProcStat('4242 (a) b (c) S 900 4242 4242 34816 5300 0')).toBe(5300);
    expect(tpgidFromProcStat('4242 (zsh) S 900 4242 4242 0 -1 0')).toBeNull();
    expect(tpgidFromProcStat('garbage')).toBeNull();
  });
});

describe('groupAndSession', () => {
  it('reads the group and session fields after the command name', () => {
    expect(groupAndSession('5300 (claude (x)) S 4242 5300 4242 34816 5300 0')).toEqual({
      pgrp: 5300,
      session: 4242,
    });
    expect(groupAndSession('junk')).toBeNull();
  });
});

describe('systemReaper', () => {
  it('is none on Windows - no process groups, no signals', () => {
    expect(systemReaper('win32')).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'tells a live group from a gone one, and ends a group on the signal',
    async () => {
      const reaper = systemReaper()!;
      // `detached` makes the child a group leader: its pid is its group id.
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      const pgid = child.pid!;
      const gone = new Promise((r) => child.once('exit', r));
      // Its own session: the group is in session `pgid`, never in another.
      expect(await reaper.stillOurs(pgid, pgid)).toBe(true);
      if (process.platform === 'linux') expect(await reaper.stillOurs(pgid, 1)).toBe(false);
      // Its own session, no terminal: no foreground group to read. (Never ask
      // about this worker - run from a terminal, it has one.)
      expect(await reaper.foregroundGroup(pgid)).toBeNull();
      reaper.signalGroup(pgid, 'SIGTERM');
      await gone;
      expect(await reaper.stillOurs(pgid, pgid)).toBe(false);
    },
  );
});
