import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILD_ID_MAX,
  SOCKET_PATH_MAX,
  buildIdFor,
  compatibleSockets,
  daemonLayout,
  parseLogFileName,
  parseSocketFileName,
  sanitizeBuildId,
  socketFileName,
  staleLogFiles,
} from './daemon-paths';

// The layout takes the platform's `join`; the POSIX cases need the POSIX one on any host.
const { join } = posix;

describe('build ids', () => {
  it('is the version for a packaged app and carries the entry mtime in dev', () => {
    expect(buildIdFor({ appVersion: '0.4.2', packaged: true, entryMtimeMs: 123 })).toBe('0.4.2');
    // A rebuild in dev keeps the version: the mtime is what tells the daemons apart.
    const a = buildIdFor({ appVersion: '0.4.2', packaged: false, entryMtimeMs: 1_700_000_000_000 });
    const b = buildIdFor({ appVersion: '0.4.2', packaged: false, entryMtimeMs: 1_700_000_001_000 });
    expect(a).toMatch(/^0\.4\.2-dev-/);
    expect(a).not.toBe(b);
    expect(buildIdFor({ appVersion: '0.4.2', packaged: false, entryMtimeMs: null })).toBe(
      '0.4.2-dev-x',
    );
  });

  it('keeps only name-safe characters', () => {
    expect(sanitizeBuildId('1.0.0-beta+build/7')).toBe('1.0.0-beta-build-7');
    expect(sanitizeBuildId('')).toBe('unknown');
    expect(sanitizeBuildId('...')).toBe('unknown');
  });
});

describe('socket names', () => {
  it('round-trips protocol version and build id', () => {
    const name = socketFileName(1, '0.4.2-dev-abc');
    expect(name).toBe('daemon-v1-0.4.2-dev-abc.sock');
    expect(parseSocketFileName(name)).toEqual({ protocolVersion: 1, buildId: '0.4.2-dev-abc' });
    expect(parseSocketFileName('token')).toBeNull();
    expect(parseSocketFileName('daemon-0.4.2.log')).toBeNull();
  });

  it('lists the sockets a client can speak to, newest protocol first', () => {
    const names = ['token', 'daemon-v1-a.sock', 'daemon-v2-b.sock', 'daemon-v7-c.sock', 'x.log'];
    expect(compatibleSockets(names, [1, 2])).toEqual([
      { fileName: 'daemon-v2-b.sock', protocolVersion: 2, buildId: 'b' },
      { fileName: 'daemon-v1-a.sock', protocolVersion: 1, buildId: 'a' },
    ]);
  });

  it('orders one protocol by build id, whatever order the folder listed them in', () => {
    // "The first daemon" decides which copy of a twice-held terminal id
    // survives (daemon-backend.ts), so it must not follow readdir's whim.
    const shuffled = ['daemon-v1-0.4.3.sock', 'daemon-v1-0.4.1.sock', 'daemon-v1-0.4.2.sock'];
    expect(compatibleSockets(shuffled, [1]).map((s) => s.buildId)).toEqual([
      '0.4.1',
      '0.4.2',
      '0.4.3',
    ]);
    expect(compatibleSockets([...shuffled].reverse(), [1]).map((s) => s.buildId)).toEqual([
      '0.4.1',
      '0.4.2',
      '0.4.3',
    ]);
  });
});

describe('daemon logs', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 10 * DAY;

  it('names a log file by its build, the rotated copy included', () => {
    expect(parseLogFileName('daemon-0.4.2-dev-abc.log')).toBe('0.4.2-dev-abc');
    expect(parseLogFileName('daemon-0.4.2-dev-abc.log.1')).toBe('0.4.2-dev-abc');
    expect(parseLogFileName('daemon-v1-0.4.2.sock')).toBeNull();
    expect(parseLogFileName('token')).toBeNull();
    expect(parseLogFileName('daemon-0.4.2.log.2')).toBeNull();
  });

  it('sweeps only the logs of builds with no socket left, untouched for a day, never the current build', () => {
    const logs = [
      // An old build whose daemon is long gone: swept, its rotation too.
      { name: 'daemon-old.log', mtimeMs: now - 2 * DAY },
      { name: 'daemon-old.log.1', mtimeMs: now - 3 * DAY },
      // Gone too, but written within the day - a daemon that just exited.
      { name: 'daemon-recent.log', mtimeMs: now - DAY + 1 },
      // Exactly a day old is old enough.
      { name: 'daemon-edge.log', mtimeMs: now - DAY },
      // An old build still with a socket file (answering or not): kept.
      { name: 'daemon-live.log', mtimeMs: now - 5 * DAY },
      // The current build's own log, before its daemon exists: kept.
      { name: 'daemon-own.log', mtimeMs: now - 5 * DAY },
      // Not a daemon log at all.
      { name: 'token', mtimeMs: 0 },
      { name: 'daemon-v1-live.sock', mtimeMs: 0 },
    ];
    expect(staleLogFiles(logs, ['live'], 'own', now)).toEqual([
      'daemon-old.log',
      'daemon-old.log.1',
      'daemon-edge.log',
    ]);
    // The own build id is matched as the socket names spell it.
    expect(
      staleLogFiles([{ name: 'daemon-0.4.2-dev-x.log', mtimeMs: 0 }], [], '0.4.2 dev x', now),
    ).toEqual([]);
  });
});

describe('daemonLayout', () => {
  it('keeps sockets under the daemon folder when the path fits', () => {
    const l = daemonLayout({
      userData: '/home/emma/.config/double0-desktop',
      platform: 'linux',
      shortTmpDir: '/tmp',
      join,
    });
    expect(l.dir).toBe('/home/emma/.config/double0-desktop/daemon');
    expect(l.socketDir).toBe(l.dir);
    expect(l.socketPath(1, '0.4.2')).toBe(join(l.dir, 'daemon-v1-0.4.2.sock'));
    expect(l.tokenPath).toBe(join(l.dir, 'token'));
    expect(l.logPath('0.4.2')).toBe(join(l.dir, 'daemon-0.4.2.log'));
  });

  it('falls back to a short /tmp folder when userData is too long for a socket path', () => {
    // The kernel caps a Unix socket path (104 bytes on macOS): the usual
    // Application Support path already runs past it with a dev build id, and
    // every connect would fail with no clear error.
    const deep = '/Users/emma/Library/Application Support/double0-desktop-dev';
    const l = daemonLayout({ userData: deep, platform: 'darwin', shortTmpDir: '/tmp', join });
    expect(l.socketDir).toMatch(/^\/tmp\/double0-daemon-[0-9a-f]{12}$/);
    expect(Buffer.byteLength(l.socketPath(1, 'x'.repeat(BUILD_ID_MAX)))).toBeLessThanOrEqual(
      SOCKET_PATH_MAX,
    );
    // The token and the logs stay with the install.
    expect(l.tokenPath).toBe(join(deep, 'daemon', 'token'));
    // Two installs never share the fallback folder.
    const other = daemonLayout({
      userData: `${deep}2`,
      platform: 'darwin',
      shortTmpDir: '/tmp',
      join,
    });
    expect(other.socketDir).not.toBe(l.socketDir);
  });

  it('names a pipe on Windows, keyed by the install, and lists no folder', () => {
    const l = daemonLayout({
      userData: 'C:\\Users\\emma\\AppData\\Roaming\\double0-desktop',
      platform: 'win32',
      shortTmpDir: 'C:\\Temp',
      join,
    });
    expect(l.socketDir).toBeNull();
    expect(l.socketPath(1, '0.4.2')).toMatch(
      /^\\\\\.\\pipe\\double0-daemon-v1-[0-9a-f]{12}-0\.4\.2$/,
    );
  });

  it("keys the Windows pipe by the install's secret, so another user cannot predict it", () => {
    // Pipe names are machine-global: a squatter on a predictable name would
    // receive the token our hello sends (review, 2026-10-06).
    const input = {
      userData: 'C:\\Users\\emma\\AppData\\Roaming\\double0-desktop',
      platform: 'win32' as const,
      shortTmpDir: 'C:\\Temp',
      join,
    };
    const open = daemonLayout(input).socketPath(1, '0.4.2');
    const a = daemonLayout({ ...input, secret: 'aaa' }).socketPath(1, '0.4.2');
    const b = daemonLayout({ ...input, secret: 'bbb' }).socketPath(1, '0.4.2');
    expect(a).not.toBe(open);
    expect(a).not.toBe(b);
    expect(daemonLayout({ ...input, secret: 'aaa' }).socketPath(1, '0.4.2')).toBe(a);
  });
});
