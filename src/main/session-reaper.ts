/**
 * What a closed tab may leave behind, and how it is ended (PtyHost.kill).
 *
 * A tab close sends SIGHUP to the shell, and the terminal hanging up sends
 * it on to the program in the foreground. Almost everything leaves at once - a
 * real `claude` clears its state and exits within milliseconds. A program that
 * ignores or mishandles the hangup used to live on with no terminal for good:
 * the demo's fake agent hung in its SessionEnd hook and 14 of them sat there
 * for days (2026-11-05). So the host reads the terminal's FOREGROUND process
 * group just before the hangup, and once the grace period has passed it sends
 * that group SIGTERM, then SIGKILL to whatever ignored that too.
 *
 * Read before the hangup, never after: once the terminal is gone macOS clears
 * the processes' tty and foreground flag (`S+` becomes `S`, tty `??`), while
 * the group id stays (probed on a real pty, 2026-11-05). A group id cannot be
 * reused while any member lives, but once they are all gone it can be - and
 * before each signal the group must still be the closed shell's: on Linux a
 * member of it must still carry the shell's session id (a host with a 32768
 * pid limit under a parallel build wraps within seconds; review 2026-11-05).
 * macOS wraps at 99999 and keeps no readable session id (`ps -o sess` prints
 * 0), so there an existing group is taken as ours. Background jobs (`nohup … &`, a disowned
 * server) are groups of their own and are left alone, as any terminal leaves
 * them. Pure node - the session daemon runs it, on a host too.
 */
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

/** How long a closed tab's shell and its foreground program get on SIGHUP. */
export const CLOSE_GRACE_MS = 3000;
/** Then: how long what is left gets on SIGTERM before SIGKILL. */
export const CLOSE_TERM_GRACE_MS = 2000;
/** The longest a tab close waits for the foreground group before hanging up anyway. */
export const FOREGROUND_LOOKUP_MS = 250;

export type SessionReaper = {
  /** The terminal's foreground process group, read through its shell; null when unknown. */
  foregroundGroup(shellPid: number): Promise<number | null>;
  /** Whether the group still has a member, in session `sid` where the OS can tell. */
  stillOurs(pgid: number, sid: number): Promise<boolean>;
  signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
};

/** `ps -o tpgid=` output → the group id; null for none (`0`, `-1`, a detached shell). */
export function parseTpgid(out: string): number | null {
  const n = Number(out.trim());
  return Number.isInteger(n) && n > 1 ? n : null;
}

/**
 * `/proc/<pid>/stat` → its tpgid (field 8). The command name in field 2 may
 * hold spaces and parentheses, so fields are counted from its LAST `)`.
 */
export function tpgidFromProcStat(stat: string): number | null {
  const rest = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  // state ppid pgrp session tty_nr tpgid …
  return rest.length > 5 ? parseTpgid(rest[5]) : null;
}

/** `/proc/<pid>/stat` → its process group and session; null when unreadable. */
export function groupAndSession(stat: string): { pgrp: number; session: number } | null {
  const rest = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  // state ppid pgrp session …
  const pgrp = Number(rest[2]);
  const session = Number(rest[3]);
  return Number.isInteger(pgrp) && Number.isInteger(session) ? { pgrp, session } : null;
}

const groupExists = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: another user's - never ours to end.
    return false;
  }
};

/** Linux: does any process of group `pgid` still belong to session `sid`? */
async function linuxGroupInSession(pgid: number, sid: number): Promise<boolean> {
  let pids: string[];
  try {
    pids = (await readdir('/proc')).filter((n) => /^\d+$/.test(n));
  } catch {
    return false;
  }
  for (const pid of pids) {
    try {
      const ids = groupAndSession(await readFile(`/proc/${pid}/stat`, 'utf8'));
      if (ids?.pgrp === pgid && ids.session === sid) return true;
    } catch {
      // Gone while we looked.
    }
  }
  return false;
}

/** The reaper over the real OS. None on Windows (no process groups, no signals). */
export function systemReaper(platform: NodeJS.Platform = process.platform): SessionReaper | null {
  if (platform === 'win32') return null;
  return {
    async foregroundGroup(shellPid) {
      if (platform === 'linux') {
        try {
          return tpgidFromProcStat(await readFile(`/proc/${shellPid}/stat`, 'utf8'));
        } catch {
          return null;
        }
      }
      return new Promise((resolve) => {
        execFile('ps', ['-o', 'tpgid=', '-p', String(shellPid)], { timeout: 2000 }, (err, out) =>
          resolve(err ? null : parseTpgid(String(out))),
        );
      });
    },
    async stillOurs(pgid, sid) {
      if (!groupExists(pgid)) return false;
      return platform === 'linux' ? linuxGroupInSession(pgid, sid) : true;
    },
    signalGroup(pgid, signal) {
      try {
        process.kill(-pgid, signal);
      } catch {
        // Gone in between, or not ours.
      }
    },
  };
}
