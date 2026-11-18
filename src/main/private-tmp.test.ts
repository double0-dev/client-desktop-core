import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentFilesRoot, ensurePrivateDir, isSharedTmp } from './private-tmp';

const posix = process.platform !== 'win32';
const uid = posix ? process.getuid!() : 0;

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'double0-private-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe.runIf(posix)('ensurePrivateDir', () => {
  it('creates a 0700 folder of this user', () => {
    const dir = join(base, 'd');
    expect(ensurePrivateDir(dir, uid)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Again: it is already there, and still fine.
    expect(ensurePrivateDir(dir, uid)).toBe(true);
  });

  it('refuses one others can enter, a symlink, or one of another user', () => {
    const open = join(base, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    expect(ensurePrivateDir(open, uid)).toBe(false);
    const real = join(base, 'real');
    mkdirSync(real, { mode: 0o700 });
    const link = join(base, 'link');
    symlinkSync(real, link);
    expect(ensurePrivateDir(link, uid)).toBe(false);
    expect(ensurePrivateDir(real, uid + 1)).toBe(false);
  });
});

describe('agentFilesRoot', () => {
  it('keeps the per-user temp folder off Linux', () => {
    expect(agentFilesRoot('darwin', base)).toBe(base);
    expect(agentFilesRoot('win32', base)).toBe(base);
  });

  it.runIf(posix)('uses a private per-user folder on Linux', () => {
    expect(agentFilesRoot('linux', base)).toBe(join(base, `double0-${uid}`));
  });
});

describe('a Mac host with no TMPDIR (M3)', () => {
  // A remote daemon on a Mac is started over ssh; with no TMPDIR node's
  // tmpdir() is the shared /tmp, which must get the Linux treatment.
  it('recognises the shared temp folders, however spelled', () => {
    for (const d of ['/tmp', '/tmp/', '/private/tmp', '/var/tmp', '/private/var/tmp/']) {
      expect(isSharedTmp(d)).toBe(true);
    }
    for (const d of ['/var/folders/x1/abc/T/', '/tmp/x', '/home/emmaw/tmp']) {
      expect(isSharedTmp(d)).toBe(false);
    }
  });

  it("keeps a Mac's own TMPDIR as it is", () => {
    expect(agentFilesRoot('darwin', base)).toBe(base);
  });
});
