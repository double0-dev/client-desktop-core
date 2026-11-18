import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findChildRepos } from './child-repos';
import {
  createLocalRuntime,
  localRuntime,
  runtimeFor,
  runtimeOfHost,
  setHostRuntimeLookup,
  setRuntimeResolver,
  type HostRuntime,
} from './host-runtime';

/**
 * The seam every project-file handler takes its I/O from (host-runtime.ts):
 * the local runtime against real processes and a scratch folder, and the
 * resolver that will hand a remote path to its host's runtime. The handlers
 * themselves keep their own suites (git.test.ts, fs.test.ts, ...), which run
 * over the local runtime unchanged.
 */

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'd0-runtime-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('the local runtime - exec', () => {
  const rt = localRuntime;

  it('resolves with the exit code and both streams, never rejecting on a failure exit', async () => {
    const r = await rt.exec('sh', ['-c', 'printf out; printf err >&2; exit 3']);
    expect(r).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('runs in the given cwd with the given env, and pipes input to stdin', async () => {
    const r = await rt.exec('sh', ['-c', 'pwd; printf "%s" "$ACME"; cat'], {
      cwd: dir,
      env: { PATH: process.env.PATH, ACME: 'production-pipeline' },
      input: '|from stdin',
    });
    expect(r.stdout).toBe(`${dir}\nproduction-pipeline|from stdin`);
  });

  it('rejects when the program cannot run at all', async () => {
    await expect(rt.exec('double0-no-such-binary', [])).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(rt.exec('sh', ['-c', 'true'], { cwd: join(dir, 'missing') })).rejects.toThrow();
  });

  it("kills a run past its timeout and rejects with the caller's message", async () => {
    const started = Date.now();
    await expect(
      rt.exec('sh', ['-c', 'sleep 5'], { timeoutMs: 100, timeoutMessage: 'git timed out' }),
    ).rejects.toThrow('git timed out');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('keeps stdout up to its cap, and does not die on a program that ignores stdin', async () => {
    const r = await rt.exec('sh', ['-c', 'yes 0123456789 | head -c 200000'], { maxStdout: 1000 });
    // Whole chunks are kept until the cap is crossed - bounded, not exact.
    expect(r.stdout.length).toBeGreaterThanOrEqual(1000);
    expect(r.stdout.length).toBeLessThan(200000);
    // `true` exits without reading: the EPIPE on its stdin must stay quiet.
    expect((await rt.exec('true', [], { input: 'x'.repeat(1 << 20) })).code).toBe(0);
  });

  it('hands each stderr piece over as it lands, and stops a run when aborted', async () => {
    const pieces: string[] = [];
    const r = await rt.exec('sh', ['-c', 'echo a >&2; echo b >&2'], {
      onStderr: (d) => pieces.push(d),
    });
    expect(pieces.join('')).toBe('a\nb\n');
    expect(r.stderr).toBe('a\nb\n');
    const abort = new AbortController();
    const started = Date.now();
    const run = rt.exec('sleep', ['5'], { signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    expect((await run).code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('hands binary output back byte for byte', async () => {
    const r = await rt.execBinary('sh', ['-c', "printf '\\377\\000\\201png'"]);
    expect([...r.stdout]).toEqual([0xff, 0x00, 0x81, 0x70, 0x6e, 0x67]);
  });
});

describe('the local runtime - files and watches', () => {
  it('reads, writes, lists, renames and copies through node', async () => {
    const fs = localRuntime.fs;
    await fs.mkdir(join(dir, 'acme'), { recursive: true });
    await fs.writeFile(join(dir, 'acme', 'a.txt'), 'emma', 'utf8');
    expect(await fs.readFile(join(dir, 'acme', 'a.txt'), 'utf8')).toBe('emma');
    expect((await fs.stat(join(dir, 'acme'))).isDirectory()).toBe(true);
    await fs.rename(join(dir, 'acme', 'a.txt'), join(dir, 'acme', 'b.txt'));
    await fs.cp(join(dir, 'acme'), join(dir, 'copy'), { recursive: true });
    const names = (await fs.readdir(join(dir, 'copy'), { withFileTypes: true })).map((d) => d.name);
    expect(names).toEqual(['b.txt']);
    await fs.rm(join(dir, 'copy'), { recursive: true, force: true });
    await expect(fs.lstat(join(dir, 'copy'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('resolves symlinks', async () => {
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(await localRuntime.realpath(join(dir, 'link'))).toBe(join(dir, 'real'));
  });

  it('reports a change under a watched folder', async () => {
    const watcher = localRuntime.watch(dir, { recursive: true });
    // The OS stream starts a moment after `watch` returns (FSEvents on a busy
    // Mac missed a single early write - the full suite timed out on it), so
    // the file is written again until its event arrives.
    let n = 0;
    const writer = setInterval(() => writeFileSync(join(dir, 'new.txt'), String(n++)), 100);
    try {
      // macOS may report the folder itself first: wait for the file's own event.
      await new Promise<void>((r) =>
        watcher.on('change', (_t, name) => {
          if (String(name).includes('new.txt')) r();
        }),
      );
    } finally {
      clearInterval(writer);
      watcher.close();
    }
  }, 15_000);

  it('finds a binary through the lookup it was given', async () => {
    const rt = createLocalRuntime({
      which: async (bin) => (bin === 'git' ? '/usr/bin/git' : null),
    });
    expect(await rt.which('git')).toBe('/usr/bin/git');
    expect(await rt.which('double0-no-such-binary')).toBeNull();
  });
});

describe('runtimeFor', () => {
  it('answers the local runtime for every path until hosts exist', () => {
    expect(runtimeFor('/home/emmaw/acme')).toBe(localRuntime);
    expect(runtimeFor(null)).toBe(localRuntime);
    expect(runtimeFor()).toBe(localRuntime);
  });

  it("routes a handler's I/O to the runtime a path resolves to, and restores", async () => {
    // A recording runtime standing in for a remote host: findChildRepos must
    // ask IT for the folder listing and the `.git` probes, never node.
    const asked: string[] = [];
    const entry = (name: string) => ({
      name,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    });
    const remote = {
      ...localRuntime,
      fs: {
        ...localRuntime.fs,
        readdir: (async (path: string) => {
          asked.push(`readdir ${path}`);
          return [entry('api'), entry('web')];
        }) as unknown as HostRuntime['fs']['readdir'],
        stat: (async (path: string) => {
          asked.push(`stat ${path}`);
          if (path.includes('/web/')) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
          return {};
        }) as unknown as HostRuntime['fs']['stat'],
      },
    } satisfies HostRuntime;
    const restore = setRuntimeResolver((path) =>
      path?.startsWith('/srv/') ? remote : localRuntime,
    );
    try {
      expect(await findChildRepos('/srv/acme')).toEqual([{ name: 'api', path: '/srv/acme/api' }]);
      expect(asked).toEqual([
        'readdir /srv/acme',
        'stat /srv/acme/api/.git',
        'stat /srv/acme/web/.git',
      ]);
      // A local path still reads this machine.
      expect(await findChildRepos(dir)).toEqual([]);
    } finally {
      restore();
    }
    expect(runtimeFor('/srv/acme')).toBe(localRuntime);
  });
});

describe('runtimeOfHost (plan 29 › M7)', () => {
  it('knows no host until the app sets the lookup, and restores', () => {
    expect(runtimeOfHost('build-box')).toBeNull();
    const host = { ...localRuntime, remote: { hostId: 'build-box' } } satisfies HostRuntime;
    const restore = setHostRuntimeLookup((id) => (id === 'build-box' ? host : null));
    expect(runtimeOfHost('build-box')).toBe(host);
    expect(runtimeOfHost('other-box')).toBeNull();
    restore();
    expect(runtimeOfHost('build-box')).toBeNull();
  });
});
