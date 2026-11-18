import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDaemonBackend,
  ensureSocketDir,
  ensureToken,
  sweepDaemonLogs,
} from './daemon-launcher';
import { daemonLayout } from './daemon-paths';

/**
 * The daemon's on-disk setup (a private plan): the token and
 * the socket folder, and the one rule above them - whatever goes wrong here
 * comes back as a backend that falls back in-process, never as a throw.
 */

const scratch: string[] = [];
const dir = (prefix = 'd0l-'): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};
const mode = (p: string): number => lstatSync(p).mode & 0o777;
const root = typeof process.getuid === 'function' && process.getuid() === 0;

afterEach(() => {
  for (const d of scratch.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // Gone already.
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('ensureToken', () => {
  it('creates the folder 0700 and a 64-hex token at 0600, then hands the same token back', () => {
    const d = join(dir(), 'daemon');
    const tokenPath = join(d, 'token');
    const token = ensureToken(d, tokenPath);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(d)).toBe(0o700);
    expect(mode(tokenPath)).toBe(0o600);
    expect(readFileSync(tokenPath, 'utf8')).toBe(`${token}\n`);
    expect(ensureToken(d, tokenPath)).toBe(token);
  });

  it('replaces a token that is not one and tightens the mode of one left readable', () => {
    const d = dir();
    const tokenPath = join(d, 'token');
    writeFileSync(tokenPath, 'not-a-token\n', { mode: 0o644 });
    const token = ensureToken(d, tokenPath);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(tokenPath)).toBe(0o600);
    // A valid token from an earlier version that wrote it 0644 is kept, at 0600.
    chmodSync(tokenPath, 0o644);
    expect(ensureToken(d, tokenPath)).toBe(token);
    expect(mode(tokenPath)).toBe(0o600);
  });
});

describe.skipIf(process.platform === 'win32')('ensureSocketDir', () => {
  it('creates the folder 0700 and accepts it again', () => {
    const d = join(dir(), 'sockets');
    ensureSocketDir(d);
    expect(mode(d)).toBe(0o700);
    expect(() => ensureSocketDir(d)).not.toThrow();
  });

  it('closes a folder of ours that was left open to others', () => {
    const d = join(dir(), 'sockets');
    mkdirSync(d, { mode: 0o777 });
    chmodSync(d, 0o777);
    ensureSocketDir(d);
    expect(mode(d)).toBe(0o700);
  });

  it('refuses a symlink in place of the folder - another user may have planted it', () => {
    // `/tmp` is world-writable and the folder's name is predictable; a link
    // there would route our socket (and the token the app presents on it)
    // wherever its owner likes.
    const d = dir();
    const target = join(d, 'elsewhere');
    mkdirSync(target, { mode: 0o700 });
    const link = join(d, 'sockets');
    symlinkSync(target, link);
    expect(() => ensureSocketDir(link)).toThrow(/not a plain directory/);
  });
});

describe('sweepDaemonLogs', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('deletes the day-old logs of builds with no socket file, keeps the rest, and reports the count', () => {
    // Long enough that the socket falls back to the short folder whatever the
    // temp root: a CI runner's short /tmp kept it in `layout.dir`.
    const userData = join(dir(), 'u'.repeat(120));
    const layout = daemonLayout({ userData, platform: 'linux', shortTmpDir: dir(), join });
    expect(layout.socketDir).not.toBe(layout.dir);
    mkdirSync(layout.dir, { recursive: true });
    const now = Date.now();
    const aged = (name: string, ageMs: number): void => {
      const path = join(layout.dir, name);
      writeFileSync(path, 'log\n');
      const t = (now - ageMs) / 1000;
      utimesSync(path, t, t);
    };
    aged('daemon-gone.log', 2 * DAY);
    aged('daemon-gone.log.1', 2 * DAY);
    aged('daemon-fresh.log', DAY / 2);
    aged('daemon-live.log', 3 * DAY);
    aged('daemon-own.log', 3 * DAY);
    writeFileSync(layout.tokenPath, 'x\n');
    // A socket file (nobody need listen) marks its build as present.
    mkdirSync(layout.socketDir!, { recursive: true });
    writeFileSync(layout.socketPath(1, 'live'), '');
    const log: string[] = [];
    expect(sweepDaemonLogs(layout, 'own', (m) => log.push(m), now).sort()).toEqual([
      'daemon-gone.log',
      'daemon-gone.log.1',
    ]);
    // The socket itself lives in the socket folder, not here.
    expect(readdirSync(layout.dir).sort()).toEqual([
      'daemon-fresh.log',
      'daemon-live.log',
      'daemon-own.log',
      'token',
    ]);
    expect(log).toEqual(['swept 2 old daemon log file(s)']);
    // Nothing left to sweep, nothing logged.
    expect(sweepDaemonLogs(layout, 'own', (m) => log.push(m), now)).toEqual([]);
    expect(log).toHaveLength(1);
  });

  it('is a no-op on a folder that does not exist', () => {
    const layout = daemonLayout({
      userData: join(dir(), 'never'),
      platform: 'linux',
      shortTmpDir: dir(),
      join,
    });
    expect(sweepDaemonLogs(layout, 'own', () => undefined)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('createDaemonBackend', () => {
  const log: string[] = [];
  const options = (userData: string, shortTmpDir: string) => ({
    userData,
    appVersion: '0.4.2',
    packaged: true,
    execPath: '/nonexistent/double0',
    daemonEntry: '/nonexistent/daemon.js',
    log: (m: string) => log.push(m),
    shortTmpDir,
    startTimeoutMs: 20,
  });

  it.skipIf(root)(
    'comes back as a backend whose ready() rejects when userData cannot be written, instead of throwing',
    async () => {
      // Throwing out of here took the whole terminal registration down with it:
      // no fallback, no terminals at all (2026-10-04).
      const parent = dir();
      chmodSync(parent, 0o500);
      const backend = createDaemonBackend(options(join(parent, 'userData'), dir()));
      await expect(backend.ready()).rejects.toThrow(/EACCES|EPERM/);
      expect(log.some((m) => m.startsWith('daemon not set up'))).toBe(true);
    },
  );

  it('refuses a socket folder that is not ours and falls back, without starting a daemon', async () => {
    // A userData path too long for a socket sends the sockets to the short
    // temp root (daemon-paths.ts), where the folder's name is predictable.
    const userData = join(dir(), 'x'.repeat(90));
    mkdirSync(userData, { recursive: true });
    const short = dir();
    const { daemonLayout } = await import('./daemon-paths');
    const layout = daemonLayout({ userData, platform: 'darwin', shortTmpDir: short, join });
    expect(layout.socketDir).not.toBe(layout.dir);
    const planted = join(short, 'planted');
    mkdirSync(planted);
    symlinkSync(planted, layout.socketDir!);
    const backend = createDaemonBackend(options(userData, short));
    await expect(backend.ready()).rejects.toThrow(/not a plain directory/);
    // The token was still set up (that step comes first), nothing else was.
    expect(existsSync(layout.tokenPath)).toBe(true);
  });

  it('sets the folders up and tries the daemon when everything is in order', async () => {
    const userData = join(dir(), 'x'.repeat(90));
    mkdirSync(userData, { recursive: true });
    const short = dir();
    const backend = createDaemonBackend(options(userData, short));
    // The binary does not exist, so the daemon never answers: ready() rejects
    // after the start timeout - the ordinary fallback trigger, not a throw.
    await expect(backend.ready()).rejects.toThrow(/did not answer/);
    const { daemonLayout } = await import('./daemon-paths');
    const layout = daemonLayout({ userData, platform: 'darwin', shortTmpDir: short, join });
    expect(mode(layout.dir)).toBe(0o700);
    expect(mode(layout.socketDir!)).toBe(0o700);
    expect(mode(layout.tokenPath)).toBe(0o600);
  });
});
