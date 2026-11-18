import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localRuntime, type HostFs } from './host-runtime';
import {
  UPLOAD_IN_FLIGHT,
  UPLOAD_MAX_BATCH_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_TEMP_TAG,
  keepBothName,
  runUpload,
  type UploadRequest,
} from './upload';

/**
 * The upload engine (plan 29 spec › 9.1) over real scratch folders: this
 * computer's files as source and destination (a drop on a local root). The
 * same engine onto a host is Pro's (the official build).
 */
const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'd0up-'));
  scratch.push(d);
  return d;
};

/** Every path under `root`, relative, `/`-separated, sorted (folders end in `/`). */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) {
        out.push(`${r}/`);
        walk(p, r);
      } else out.push(r);
    }
  };
  walk(root, '');
  return out;
}

const local = { fs: localRuntime.fs, path: nodePath };

function request(
  over: Partial<UploadRequest> & Pick<UploadRequest, 'items' | 'destDir'>,
): UploadRequest {
  return { id: 'u1', source: local, dest: local, onClash: 'ask', ...over };
}

describe('keepBothName', () => {
  it('numbers before the extension, and treats a leading dot as part of the name', () => {
    expect(keepBothName('a.txt', 2, false)).toBe('a (2).txt');
    expect(keepBothName('archive.tar.gz', 3, false)).toBe('archive.tar (3).gz');
    expect(keepBothName('.env', 2, false)).toBe('.env (2)');
    expect(keepBothName('Makefile', 2, false)).toBe('Makefile (2)');
    expect(keepBothName('src.old', 2, true)).toBe('src.old (2)');
  });
});

describe('the caps', () => {
  it('are the transfer cap per file, 512 MiB and 5 000 files per batch', () => {
    // A host's transfer cap (host-ops' MAX_TRANSFER_BYTES; parity asserted in
    // the official build).
    expect(UPLOAD_MAX_FILE_BYTES).toBe(64 * 1024 * 1024);
    expect(UPLOAD_MAX_BATCH_BYTES).toBe(512 * 1024 * 1024);
    expect(UPLOAD_MAX_FILES).toBe(5000);
    expect(UPLOAD_IN_FLIGHT).toBe(2);
  });

  it('refuses a batch past the file count before writing anything', async () => {
    const src = dir();
    const dest = dir();
    mkdirSync(join(src, 'many'));
    for (let i = 0; i < 6; i++) writeFileSync(join(src, 'many', `f${i}`), 'x');
    const r = await runUpload(
      request({
        items: [{ localPath: join(src, 'many'), rel: 'many' }],
        destDir: dest,
        limits: { maxFiles: 5 },
      }),
    );
    expect(r).toEqual({ refused: 'More than 5 files - copy fewer at once.' });
    expect(tree(dest)).toEqual([]);
  });

  it('refuses a batch past the byte cap before writing anything', async () => {
    const src = dir();
    const dest = dir();
    writeFileSync(join(src, 'a'), Buffer.alloc(600));
    writeFileSync(join(src, 'b'), Buffer.alloc(600));
    const r = await runUpload(
      request({
        items: [
          { localPath: join(src, 'a'), rel: 'a' },
          { localPath: join(src, 'b'), rel: 'b' },
        ],
        destDir: dest,
        limits: { maxBatchBytes: 1000 },
      }),
    );
    expect(r).toMatchObject({ refused: expect.stringContaining('copy less at once') });
    expect(tree(dest)).toEqual([]);
  });

  it('skips and lists a file past the per-file cap, and copies the rest', async () => {
    const src = dir();
    const dest = dir();
    writeFileSync(join(src, 'big.bin'), Buffer.alloc(2048));
    writeFileSync(join(src, 'small.txt'), 'ok');
    const r = await runUpload(
      request({
        items: [
          { localPath: join(src, 'big.bin'), rel: 'big.bin' },
          { localPath: join(src, 'small.txt'), rel: 'small.txt' },
        ],
        destDir: dest,
        limits: { maxFileBytes: 1024 },
      }),
    );
    expect(r).toMatchObject({ ok: true, copied: ['small.txt'] });
    expect(r).toMatchObject({
      skipped: [{ path: 'big.bin', reason: expect.stringMatching(/too large/) }],
    });
    expect(tree(dest)).toEqual(['small.txt']);
  });
});

describe('the walk', () => {
  it('copies a folder whole - nested files, an empty folder - and skips links', async () => {
    const src = dir();
    const dest = dir();
    mkdirSync(join(src, 'pkg', 'src', 'deep'), { recursive: true });
    mkdirSync(join(src, 'pkg', 'empty'));
    writeFileSync(join(src, 'pkg', 'README.md'), '# acme');
    writeFileSync(join(src, 'pkg', 'src', 'app.ts'), 'export {}');
    writeFileSync(join(src, 'pkg', 'src', 'deep', 'x.json'), '{}');
    symlinkSync(join(src, 'pkg', 'README.md'), join(src, 'pkg', 'link.md'));
    const r = await runUpload(
      request({ items: [{ localPath: join(src, 'pkg'), rel: 'pkg' }], destDir: dest }),
    );
    expect(r).toMatchObject({ ok: true });
    expect(r).toMatchObject({ skipped: [{ path: 'pkg/link.md', reason: 'a link - not copied' }] });
    expect(tree(dest)).toEqual([
      'pkg/',
      'pkg/README.md',
      'pkg/empty/',
      'pkg/src/',
      'pkg/src/app.ts',
      'pkg/src/deep/',
      'pkg/src/deep/x.json',
    ]);
    expect(readFileSync(join(dest, 'pkg', 'src', 'app.ts'), 'utf8')).toBe('export {}');
  });

  it('skips a dropped link itself, and what the refuse rule names inside a folder', async () => {
    const src = dir();
    const dest = dir();
    mkdirSync(join(src, 'cfg', 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(src, 'cfg', 'node_modules', 'x', 'i.js'), '');
    writeFileSync(join(src, 'cfg', 'a.yml'), 'a: 1');
    symlinkSync(join(src, 'cfg'), join(src, 'cfg-link'));
    const r = await runUpload(
      request({
        items: [
          { localPath: join(src, 'cfg'), rel: 'cfg' },
          { localPath: join(src, 'cfg-link'), rel: 'cfg-link' },
        ],
        destDir: dest,
        refuse: (rel) => (rel.split('/').includes('node_modules') ? 'build output' : null),
      }),
    );
    expect(r).toMatchObject({
      skipped: [
        { path: 'cfg/node_modules/', reason: 'build output' },
        { path: 'cfg-link', reason: 'a link - not copied' },
      ],
    });
    expect(tree(dest)).toEqual(['cfg/', 'cfg/a.yml']);
  });
});

describe('clashes', () => {
  function setup() {
    const src = dir();
    const dest = dir();
    writeFileSync(join(src, 'a.txt'), 'new');
    mkdirSync(join(src, 'src'));
    writeFileSync(join(src, 'src', 'one.ts'), 'new one');
    writeFileSync(join(dest, 'a.txt'), 'old');
    mkdirSync(join(dest, 'src'));
    writeFileSync(join(dest, 'src', 'one.ts'), 'old one');
    writeFileSync(join(dest, 'src', 'two.ts'), 'old two');
    const items = [
      { localPath: join(src, 'a.txt'), rel: 'a.txt' },
      { localPath: join(src, 'src'), rel: 'src' },
    ];
    return { src, dest, items };
  }

  it('asks once for the batch and writes nothing', async () => {
    const { dest, items } = setup();
    const before = tree(dest);
    expect(await runUpload(request({ items, destDir: dest }))).toEqual({
      clash: { name: 'a.txt', count: 2 },
    });
    expect(tree(dest)).toEqual(before);
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('old');
  });

  it('replace overwrites files and merges a folder - never deleting what was there', async () => {
    const { dest, items } = setup();
    const r = await runUpload(request({ items, destDir: dest, onClash: 'replace' }));
    expect(r).toMatchObject({ ok: true, copied: ['a.txt', 'src/one.ts'] });
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(dest, 'src', 'one.ts'), 'utf8')).toBe('new one');
    expect(readFileSync(join(dest, 'src', 'two.ts'), 'utf8')).toBe('old two');
  });

  it('skip leaves every clashing item out', async () => {
    const { dest, items } = setup();
    const r = await runUpload(request({ items, destDir: dest, onClash: 'skip' }));
    expect(r).toMatchObject({
      ok: true,
      copied: [],
      skipped: [
        { path: 'a.txt', reason: 'already there' },
        { path: 'src', reason: 'already there' },
      ],
    });
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('old');
  });

  it('keep both lands each under the first free name, never over an existing copy', async () => {
    const { dest, items } = setup();
    // `a (2).txt` is taken already - it must stay as it is.
    writeFileSync(join(dest, 'a (2).txt'), 'earlier copy');
    const r = await runUpload(request({ items, destDir: dest, onClash: 'keep-both' }));
    expect(r).toMatchObject({ ok: true, copied: ['a (3).txt', 'src (2)/one.ts'] });
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(dest, 'a (2).txt'), 'utf8')).toBe('earlier copy');
    expect(readFileSync(join(dest, 'a (3).txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(dest, 'src (2)', 'one.ts'), 'utf8')).toBe('new one');
  });

  it('a second call after the answer takes the files in walk order, nothing twice', async () => {
    const { src, dest, items } = setup();
    const read: string[] = [];
    const looked: string[] = [];
    const written: string[] = [];
    const sourceFs: HostFs = {
      ...localRuntime.fs,
      // A file is taken when its re-check is called (synchronously, as a
      // worker takes it); the reads themselves may finish in either order.
      lstat: ((p: string) => {
        looked.push(nodePath.relative(src, p));
        return localRuntime.fs.lstat(p);
      }) as HostFs['lstat'],
      readFile: (async (p: string, ...rest: unknown[]) => {
        read.push(nodePath.relative(src, p));
        return (localRuntime.fs.readFile as (...a: unknown[]) => Promise<Buffer>)(p, ...rest);
      }) as HostFs['readFile'],
    };
    const destFs: HostFs = {
      ...localRuntime.fs,
      writeFile: (async (p: string, ...rest: unknown[]) => {
        written.push(nodePath.relative(dest, p).split(UPLOAD_TEMP_TAG)[0]);
        return (localRuntime.fs.writeFile as (...a: unknown[]) => Promise<void>)(p, ...rest);
      }) as HostFs['writeFile'],
    };
    const sides = {
      source: { fs: sourceFs, path: nodePath },
      dest: { fs: destFs, path: nodePath },
    };
    expect(await runUpload(request({ items, destDir: dest, ...sides }))).toMatchObject({
      clash: { name: 'a.txt' },
    });
    expect(read).toEqual([]);
    expect(written).toEqual([]);
    looked.length = 0;
    const r = await runUpload(request({ items, destDir: dest, ...sides, onClash: 'replace' }));
    // The walk's lstats, then the files taken in walk order.
    expect(looked.slice(-2)).toEqual(['a.txt', join('src', 'one.ts')]);
    expect([...read].sort()).toEqual(['a.txt', join('src', 'one.ts')]);
    expect([...written].sort()).toEqual(['a.txt', join('src', 'one.ts')]);
    expect(r).toMatchObject({ copied: ['a.txt', 'src/one.ts'] });
  });

  it('keep both releases the name it claimed when the move onto it fails', async () => {
    const { dest, items } = setup();
    const failing: HostFs = {
      ...localRuntime.fs,
      rename: (async () => {
        throw Object.assign(new Error('rename refused'), { code: 'EACCES' });
      }) as HostFs['rename'],
    };
    const r = await runUpload(
      request({
        items: [items[0]],
        destDir: dest,
        dest: { fs: failing, path: nodePath },
        onClash: 'keep-both',
      }),
    );
    expect(r).toMatchObject({ ok: false, errors: [{ path: 'a.txt', message: 'rename refused' }] });
    expect(tree(dest)).toEqual(['a.txt', 'src/', 'src/one.ts', 'src/two.ts']);
  });

  it('a top-level folder over a file of the same name is an error, not a merge', async () => {
    const src = dir();
    const dest = dir();
    mkdirSync(join(src, 'x'));
    writeFileSync(join(src, 'x', 'f'), '1');
    writeFileSync(join(dest, 'x'), 'a file');
    const r = await runUpload(
      request({
        items: [{ localPath: join(src, 'x'), rel: 'x' }],
        destDir: dest,
        onClash: 'replace',
      }),
    );
    expect(r).toMatchObject({ ok: false, errors: [{ path: 'x' }] });
    expect(readFileSync(join(dest, 'x'), 'utf8')).toBe('a file');
  });
});

describe('writing', () => {
  it('writes to a temp name and renames it into place - the real name is never written to', async () => {
    const src = dir();
    const dest = dir();
    writeFileSync(join(src, '.env'), 'TOKEN=1');
    const writes: string[] = [];
    const renames: [string, string][] = [];
    const recording: HostFs = {
      ...localRuntime.fs,
      writeFile: (async (p: string, ...rest: unknown[]) => {
        writes.push(nodePath.basename(p));
        return (localRuntime.fs.writeFile as (...a: unknown[]) => Promise<void>)(p, ...rest);
      }) as HostFs['writeFile'],
      rename: (async (from: string, to: string) => {
        renames.push([nodePath.basename(from), nodePath.basename(to)]);
        return localRuntime.fs.rename(from, to);
      }) as HostFs['rename'],
    };
    const r = await runUpload(
      request({
        id: 'abc',
        items: [{ localPath: join(src, '.env'), rel: '.env' }],
        destDir: dest,
        dest: { fs: recording, path: nodePath },
        mode: 0o600,
      }),
    );
    expect(r).toMatchObject({ ok: true });
    expect(writes).toEqual([`.env${UPLOAD_TEMP_TAG}abc`]);
    expect(renames).toEqual([[`.env${UPLOAD_TEMP_TAG}abc`, '.env']]);
    expect(tree(dest)).toEqual(['.env']);
    if (process.platform !== 'win32') expect(statSync(join(dest, '.env')).mode & 0o777).toBe(0o600);
  });

  it('keeps at most two files in flight, taken in walk order', async () => {
    const src = dir();
    const dest = dir();
    for (const n of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(src, n), n);
    let inFlight = 0;
    let most = 0;
    const looked: string[] = [];
    // A file is taken when its re-check (an lstat on this computer) is
    // called - synchronously as a worker takes it. The walk's own lstats
    // come first; the writes themselves may start in either order.
    const reading: HostFs = {
      ...localRuntime.fs,
      lstat: ((p: string) => {
        looked.push(nodePath.basename(p));
        return localRuntime.fs.lstat(p);
      }) as HostFs['lstat'],
    };
    const slow: HostFs = {
      ...localRuntime.fs,
      writeFile: (async (p: string, ...rest: unknown[]) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return (localRuntime.fs.writeFile as (...a: unknown[]) => Promise<void>)(p, ...rest);
      }) as HostFs['writeFile'],
    };
    await runUpload(
      request({
        items: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ localPath: join(src, n), rel: n })),
        destDir: dest,
        source: { fs: reading, path: nodePath },
        dest: { fs: slow, path: nodePath },
      }),
    );
    expect(most).toBe(2);
    expect(looked).toEqual(['a', 'b', 'c', 'd', 'e', 'a', 'b', 'c', 'd', 'e']);
  });

  it('reports progress throttled, ending on every byte', async () => {
    const src = dir();
    const dest = dir();
    for (const n of ['a', 'b', 'c']) writeFileSync(join(src, n), Buffer.alloc(100));
    let t = 0;
    const seen: { done: number; bytes: number }[] = [];
    await runUpload(
      request({
        items: ['a', 'b', 'c'].map((n) => ({ localPath: join(src, n), rel: n })),
        destDir: dest,
        now: () => t,
        onProgress: (p) => {
          seen.push({ done: p.done, bytes: p.bytes });
          expect(p.total).toBe(3);
          expect(p.totalBytes).toBe(300);
        },
      }),
    );
    // The clock never moves: only the first and the forced last ones.
    t += 1;
    expect(seen[0]).toEqual({ done: 0, bytes: 0 });
    expect(seen.at(-1)).toEqual({ done: 3, bytes: 300 });
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it('a cancel stops after the file in flight and leaves no temp or partial file', async () => {
    const src = dir();
    const dest = dir();
    for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(src, n), n.repeat(10));
    const controller = new AbortController();
    let writes = 0;
    const cut: HostFs = {
      ...localRuntime.fs,
      writeFile: (async (p: string, data: unknown, opts: { signal?: AbortSignal }) => {
        writes++;
        if (writes === 3) {
          // The third file is mid-write when the user cancels: half of it on
          // disk under its temp name, then the abort.
          writeFileSync(p, 'half');
          controller.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return localRuntime.fs.writeFile(p, data as string, opts);
      }) as unknown as HostFs['writeFile'],
    };
    const r = await runUpload(
      request({
        items: ['a', 'b', 'c', 'd'].map((n) => ({ localPath: join(src, n), rel: n })),
        destDir: dest,
        dest: { fs: cut, path: nodePath },
        signal: controller.signal,
      }),
    );
    expect(r).toMatchObject({ ok: false, cancelled: true });
    const left = tree(dest);
    expect(left.some((p) => p.includes(UPLOAD_TEMP_TAG))).toBe(false);
    // What was renamed before the cancel stays; nothing past it appears.
    expect(left).not.toContain('d');
    for (const name of left) expect(readFileSync(join(dest, name), 'utf8')).toBe(name.repeat(10));
  });
});
