import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './ipc-util';

/**
 * The fs bridge, driven through its real ipcMain handlers against a temp
 * directory - same approach as git.test.ts. It backs the file explorer and the
 * editor, so its failure modes (a directory read as a file, a save racing an
 * external edit, a delete going to the trash) are what the UI has to survive.
 */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const trashed: string[] = [];
const shown: string[] = [];
const fileManager = vi.hoisted(() => ({ present: true }));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
// The test machine's own desktop must not decide the result (a headless Linux
// runner has no file manager).
vi.mock('./file-manager', () => ({ linuxHasFileManager: async () => fileManager.present }));
vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'double0-fs-test-userdata') },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {
    trashItem: async (path: string) => {
      trashed.push(path);
      rmSync(path, { recursive: true, force: true });
    },
    showItemInFolder: (path: string) => {
      shown.push(path);
    },
  },
}));

const { registerFsIpc, disposeFsWatchersForWindow, MAX_UPLOAD_ENTRIES } = await import('./fs');

const mainFrame = { url: `${APP_ORIGIN}/index.html` };
const pushed: { channel: string; payload: unknown }[] = [];
/** Runs on every push, while the handler that pushed is still mid-call. */
const onPush = { fn: null as ((channel: string, payload: unknown) => void) | null };
const trustedEvent = {
  senderFrame: mainFrame,
  sender: {
    mainFrame,
    id: 1,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      pushed.push({ channel, payload });
      onPush.fn?.(channel, payload);
    },
  },
};

const invoke = async <T = Record<string, unknown>>(
  channel: string,
  payload: unknown,
  event: unknown = trustedEvent,
): Promise<T> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return (await handler(event, payload)) as T;
};

let root: string;
let dir: string;
let disposeIpc: () => void;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'double0-fs-'));
  disposeIpc = registerFsIpc();
});

afterAll(() => {
  disposeIpc();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(root, 'case-'));
  trashed.length = 0;
  shown.length = 0;
});

type Entries = {
  entries?: { name: string; path: string; isDirectory: boolean; isRepo?: boolean }[];
  error?: string;
};

describe('guards', () => {
  it('refuses a call from outside the app', async () => {
    const untrusted = { senderFrame: { url: 'https://evil.example' }, sender: { mainFrame: {} } };
    expect(await invoke('fs:readDir', { path: dir }, untrusted)).toMatchObject({ code: 'EACCES' });
  });

  it('refuses a missing path', async () => {
    expect(await invoke('fs:readDir', {})).toMatchObject({ code: 'EINVAL' });
    expect(await invoke('fs:readFile', { path: 42 })).toMatchObject({ code: 'EINVAL' });
  });

  it('refuses a write with a non-string body', async () => {
    expect(await invoke('fs:writeFile', { path: join(dir, 'a.txt') })).toMatchObject({
      code: 'EINVAL',
    });
  });

  it('refuses a rename missing either end', async () => {
    expect(await invoke('fs:rename', { from: join(dir, 'a.txt') })).toMatchObject({
      code: 'EINVAL',
    });
  });
});

describe('fs:readDir', () => {
  it('lists directories before files, case-insensitively', async () => {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'Assets'));
    writeFileSync(join(dir, 'b.ts'), '');
    writeFileSync(join(dir, 'A.ts'), '');

    const { entries } = await invoke<Entries>('fs:readDir', { path: dir });
    expect(entries!.map((e) => e.name)).toEqual(['Assets', 'src', 'A.ts', 'b.ts']);
  });

  it('carries the absolute path of each entry', async () => {
    writeFileSync(join(dir, 'a.ts'), '');
    const { entries } = await invoke<Entries>('fs:readDir', { path: dir });
    expect(entries![0].path).toBe(join(dir, 'a.ts'));
  });

  it('hides the noise directories the explorer never shows', async () => {
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'src'));
    const { entries } = await invoke<Entries>('fs:readDir', { path: dir });
    expect(entries!.map((e) => e.name)).toEqual(['src']);
  });

  it('follows a symlink to a directory', async () => {
    mkdirSync(join(dir, 'real'));
    // A junction: Windows makes one without the symlink privilege.
    symlinkSync(join(dir, 'real'), join(dir, 'link'), 'junction');
    const { entries } = await invoke<Entries>('fs:readDir', { path: dir });
    expect(entries!.find((e) => e.name === 'link')?.isDirectory).toBe(true);
  });

  it('skips a dangling symlink rather than failing the whole read', async () => {
    writeFileSync(join(dir, 'keep.ts'), '');
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling'), 'junction');
    const { entries } = await invoke<Entries>('fs:readDir', { path: dir });
    expect(entries!.map((e) => e.name)).toEqual(['keep.ts']);
  });

  it('drops files when the caller only wants folders', async () => {
    // The folder picker offers directories only - a file row there would be a
    // choice that can't be a session root.
    mkdirSync(join(dir, 'api'));
    writeFileSync(join(dir, 'README.md'), '');
    const { entries } = await invoke<Entries>('fs:readDir', { path: dir, dirsOnly: true });
    expect(entries!.map((e) => e.name)).toEqual(['api']);
  });

  it('marks which folders are git checkouts of their own', async () => {
    // The whole point of the picker: in a folder-of-repos project the parent is
    // no repo and the children are, and only the marked ones get a worktree.
    mkdirSync(join(dir, 'api', '.git'), { recursive: true });
    mkdirSync(join(dir, 'docs'));
    const { entries } = await invoke<Entries>('fs:readDir', {
      path: dir,
      dirsOnly: true,
      markRepos: true,
    });
    expect(entries!.find((e) => e.name === 'api')?.isRepo).toBe(true);
    expect(entries!.find((e) => e.name === 'docs')?.isRepo).toBeUndefined();
  });

  it('marks a linked worktree, whose .git is a file rather than a directory', async () => {
    mkdirSync(join(dir, 'fix-auth'));
    writeFileSync(join(dir, 'fix-auth', '.git'), 'gitdir: /elsewhere/.git/worktrees/fix-auth');
    const { entries } = await invoke<Entries>('fs:readDir', {
      path: dir,
      dirsOnly: true,
      markRepos: true,
    });
    expect(entries!.find((e) => e.name === 'fix-auth')?.isRepo).toBe(true);
  });

  it('leaves entries unmarked unless the caller asks', async () => {
    // Marking costs a stat per directory, so a plain explorer read must not pay
    // for it.
    mkdirSync(join(dir, 'api', '.git'), { recursive: true });
    const { entries } = await invoke<Entries>('fs:readDir', { path: dir });
    expect(entries!.find((e) => e.name === 'api')?.isRepo).toBeUndefined();
  });

  it('reports a directory that is not there', async () => {
    const res = await invoke<Entries>('fs:readDir', { path: join(dir, 'nope') });
    expect(res.error).toBeTruthy();
    expect(res.entries).toBeUndefined();
  });
});

describe('fs:readFile', () => {
  it('reads a UTF-8 file', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    const res = await invoke<{ content?: string }>('fs:readFile', { path: join(dir, 'a.ts') });
    expect(res.content).toBe('export const a = 1;\n');
  });

  it('refuses a directory', async () => {
    expect(await invoke('fs:readFile', { path: dir })).toMatchObject({ code: 'EISDIR' });
  });

  it('refuses binary content the editor cannot show', async () => {
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const res = await invoke<{ content?: string; error?: string }>('fs:readFile', {
      path: join(dir, 'logo.png'),
    });
    expect(res.content).toBeUndefined();
    expect(res.error).toBeTruthy();
  });

  it('reports a missing file', async () => {
    const res = await invoke<{ error?: string }>('fs:readFile', { path: join(dir, 'nope.ts') });
    expect(res.error).toBeTruthy();
  });
});

describe('fs:writeFile', () => {
  it('saves content and reports the new mtime', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'old\n');
    const res = await invoke<{ ok?: boolean; mtimeMs?: number }>('fs:writeFile', {
      path,
      content: 'new\n',
    });
    expect(res.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('new\n');
    expect(res.mtimeMs).toBeCloseTo(statSync(path).mtimeMs, 0);
  });

  it('creates a file that does not exist yet', async () => {
    const path = join(dir, 'fresh.ts');
    expect(await invoke<{ ok?: boolean }>('fs:writeFile', { path, content: 'hi\n' })).toMatchObject(
      {
        ok: true,
      },
    );
    expect(readFileSync(path, 'utf8')).toBe('hi\n');
  });

  it('saves when the file is untouched since it was read', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'old\n');
    const mtime = statSync(path).mtimeMs;
    const res = await invoke<{ ok?: boolean }>('fs:writeFile', {
      path,
      content: 'new\n',
      expectedMtimeMs: mtime,
    });
    expect(res.ok).toBe(true);
  });

  it('refuses to clobber a file that changed on disk', async () => {
    // Someone (an agent, another editor) wrote the file after the editor read
    // it; saving would silently drop their work.
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'old\n');
    const res = await invoke<{ code?: string }>('fs:writeFile', {
      path,
      content: 'mine\n',
      expectedMtimeMs: statSync(path).mtimeMs - 5_000,
    });
    expect(res).toMatchObject({ code: 'CONFLICT' });
    expect(readFileSync(path, 'utf8')).toBe('old\n');
  });

  it('treats a vanished file as a conflict', async () => {
    const res = await invoke<{ code?: string }>('fs:writeFile', {
      path: join(dir, 'gone.ts'),
      content: 'mine\n',
      expectedMtimeMs: 123,
    });
    expect(res).toMatchObject({ code: 'CONFLICT' });
  });

  it('leaves no temp file behind on success', async () => {
    const path = join(dir, 'a.ts');
    await invoke('fs:writeFile', { path, content: 'hi\n' });
    const { entries } = await invoke<Entries>('fs:readDir', { path: dir });
    expect(entries!.map((e) => e.name)).toEqual(['a.ts']);
  });

  it('leaves no temp file behind on failure', async () => {
    // An unwritable target: the temp file must still be cleaned up.
    const res = await invoke<{ error?: string }>('fs:writeFile', {
      path: join(dir, 'no-such-dir', 'a.ts'),
      content: 'hi\n',
    });
    expect(res.error).toBeTruthy();
    const { entries } = await invoke<Entries>('fs:readDir', { path: dir });
    expect(entries).toEqual([]);
  });
});

describe('fs:createFile and fs:createDir', () => {
  it('creates an empty file', async () => {
    expect(await invoke('fs:createFile', { path: join(dir, 'a.ts') })).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('');
  });

  it('refuses to overwrite something that already exists', async () => {
    writeFileSync(join(dir, 'a.ts'), 'keep me\n');
    const res = await invoke<{ error?: string }>('fs:createFile', { path: join(dir, 'a.ts') });
    expect(res.error).toBeTruthy();
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('keep me\n');
  });

  it('creates a directory', async () => {
    expect(await invoke('fs:createDir', { path: join(dir, 'nested') })).toMatchObject({ ok: true });
    expect(statSync(join(dir, 'nested')).isDirectory()).toBe(true);
  });
});

describe('fs:rename', () => {
  it('moves a file', async () => {
    writeFileSync(join(dir, 'a.ts'), 'body\n');
    expect(
      await invoke('fs:rename', { from: join(dir, 'a.ts'), to: join(dir, 'b.ts') }),
    ).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'b.ts'), 'utf8')).toBe('body\n');
  });

  it('moves a directory with its contents', async () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'body\n');
    await invoke('fs:rename', { from: join(dir, 'src'), to: join(dir, 'lib') });
    expect(readFileSync(join(dir, 'lib', 'a.ts'), 'utf8')).toBe('body\n');
  });

  it('reports a source that is not there', async () => {
    const res = await invoke<{ error?: string }>('fs:rename', {
      from: join(dir, 'nope.ts'),
      to: join(dir, 'b.ts'),
    });
    expect(res.error).toBeTruthy();
  });
});

describe('fs:delete', () => {
  it('sends a file to the trash rather than unlinking it', async () => {
    // Recoverable by design - the same choice the discard path makes.
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'body\n');
    expect(await invoke('fs:delete', { path })).toMatchObject({ ok: true });
    expect(trashed).toEqual([path]);
  });

  it('sends a directory to the trash', async () => {
    const path = join(dir, 'src');
    mkdirSync(path);
    writeFileSync(join(path, 'a.ts'), '');
    await invoke('fs:delete', { path });
    expect(trashed).toEqual([path]);
  });
});

describe('fs:showInFolder', () => {
  it('opens the OS file manager on an existing file', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, '');
    expect(await invoke('fs:showInFolder', { path })).toMatchObject({ ok: true });
    expect(shown).toEqual([path]);
  });

  it('reports a path that is gone instead of opening a file manager on nothing', async () => {
    const path = join(dir, 'gone.ts');
    expect(await invoke('fs:showInFolder', { path })).toMatchObject({ code: 'ENOENT' });
    expect(shown).toEqual([]);
  });

  it('says so when Linux has no file manager, instead of reporting success', async () => {
    // showItemInFolder fails silently there; the menu item seemed to do nothing.
    const path = join(dir, 'a.ts');
    writeFileSync(path, '');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    fileManager.present = false;
    try {
      expect(await invoke('fs:showInFolder', { path })).toMatchObject({ code: 'ENOTSUP' });
      expect(shown).toEqual([]);
    } finally {
      fileManager.present = true;
      Object.defineProperty(process, 'platform', platform);
    }
  });
  it('refuses a relative path - it would resolve against the app, not the project', async () => {
    expect(await invoke('fs:showInFolder', { path: 'src/a.ts' })).toMatchObject({
      code: 'EINVAL',
    });
    expect(await invoke('fs:showInFolder', { path: ['/etc'] })).toMatchObject({ code: 'EINVAL' });
    expect(shown).toEqual([]);
  });

  it('refuses a call from outside the app', async () => {
    const untrusted = { senderFrame: { url: 'https://evil.example' }, sender: { mainFrame: {} } };
    const path = join(dir, 'a.ts');
    writeFileSync(path, '');
    expect(await invoke('fs:showInFolder', { path }, untrusted)).toMatchObject({
      code: 'EACCES',
    });
    expect(shown).toEqual([]);
  });
});

// Plan 29 › M8: files dropped from this computer onto a folder of the tree.
// A local root copies through the same engine as an upload to a host.
describe('fs:upload (a drop onto a local root)', () => {
  let src: string;
  let dest: string;
  beforeEach(() => {
    src = mkdtempSync(join(root, 'drop-src-'));
    dest = mkdtempSync(join(root, 'drop-dest-'));
    pushed.length = 0;
  });

  it('copies dropped files and folders, pushing progress to the asking window', async () => {
    mkdirSync(join(src, 'assets', 'img'), { recursive: true });
    writeFileSync(join(src, 'assets', 'img', 'logo.svg'), '<svg/>');
    writeFileSync(join(src, 'notes.md'), '# acme');
    const res = await invoke('fs:upload', {
      uploadId: 'drop1',
      paths: [join(src, 'assets'), join(src, 'notes.md')],
      destDir: dest,
      onClash: 'ask',
    });
    expect(res).toEqual({
      ok: true,
      copied: ['assets/img/logo.svg', 'notes.md'],
      skipped: [],
      errors: [],
    });
    expect(readFileSync(join(dest, 'assets', 'img', 'logo.svg'), 'utf8')).toBe('<svg/>');
    const progress = pushed.filter((p) => p.channel === 'fs:uploadProgress');
    expect(progress.at(-1)?.payload).toMatchObject({ uploadId: 'drop1', done: 2, total: 2 });
  });

  it('answers a clash without writing, then applies the choice', async () => {
    writeFileSync(join(src, 'a.txt'), 'new');
    writeFileSync(join(dest, 'a.txt'), 'old');
    const args = { uploadId: 'drop2', paths: [join(src, 'a.txt')], destDir: dest };
    expect(await invoke('fs:upload', { ...args, onClash: 'ask' })).toEqual({
      clash: { name: 'a.txt', count: 1 },
    });
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('old');
    expect(await invoke('fs:upload', { ...args, onClash: 'keep-both' })).toMatchObject({
      copied: ['a (2).txt'],
    });
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(dest, 'a (2).txt'), 'utf8')).toBe('new');
  });

  it('refuses a foreign sender, bad payloads and option-shaped or relative paths', async () => {
    writeFileSync(join(src, 'a.txt'), 'x');
    const ok = { uploadId: 'drop3', paths: [join(src, 'a.txt')], destDir: dest, onClash: 'ask' };
    const untrusted = { senderFrame: { url: 'https://evil.example' }, sender: { mainFrame: {} } };
    expect(await invoke('fs:upload', ok, untrusted)).toMatchObject({ code: 'EACCES' });
    expect(await invoke('fs:uploadCancel', { uploadId: 'drop3' }, untrusted)).toMatchObject({
      code: 'EACCES',
    });
    for (const bad of [
      null,
      { ...ok, uploadId: '-x' },
      { ...ok, uploadId: 'a/b' },
      { ...ok, onClash: 'overwrite' },
      { ...ok, destDir: 'relative/dir' },
      { ...ok, destDir: '--target=/etc' },
      { ...ok, paths: [] },
      { ...ok, paths: 'a.txt' },
      { ...ok, paths: ['-rf'] },
      { ...ok, paths: ['notes.md'] },
      { ...ok, paths: [42] },
      { ...ok, paths: Array.from({ length: MAX_UPLOAD_ENTRIES + 1 }, () => join(src, 'a.txt')) },
    ]) {
      expect(await invoke('fs:upload', bad)).toMatchObject({ code: 'EINVAL' });
    }
    expect(await invoke('fs:uploadCancel', { uploadId: '--all' })).toMatchObject({
      code: 'EINVAL',
    });
    expect(readdirSync(dest)).toEqual([]);
  });

  it('refuses a destination that is not a folder, and a folder dropped into itself', async () => {
    mkdirSync(join(src, 'inner'));
    writeFileSync(join(src, 'file.txt'), 'x');
    expect(
      await invoke('fs:upload', {
        uploadId: 'drop4',
        paths: [join(src, 'inner')],
        destDir: join(src, 'file.txt'),
        onClash: 'ask',
      }),
    ).toMatchObject({ code: 'ENOTDIR' });
    expect(
      await invoke('fs:upload', {
        uploadId: 'drop5',
        paths: [src],
        destDir: join(src, 'inner'),
        onClash: 'ask',
      }),
    ).toMatchObject({ code: 'EINVAL' });
  });

  it("lets only the window that started an upload cancel it, and a closing window's go", async () => {
    // A big enough batch that the cancel lands mid-way.
    mkdirSync(join(src, 'many'));
    for (let i = 0; i < 40; i++) writeFileSync(join(src, 'many', `f${i}.txt`), 'x'.repeat(5000));
    const other = { ...trustedEvent, sender: { ...trustedEvent.sender, id: 99 } };
    const args = { uploadId: 'drop6', paths: [join(src, 'many')], destDir: dest, onClash: 'ask' };
    // The first progress push comes before any file is written: the upload is
    // running then, and every check below lands mid-batch.
    let otherCancel: unknown;
    let second: Promise<unknown> | null = null;
    onPush.fn = (channel) => {
      if (channel !== 'fs:uploadProgress' || second) return;
      otherCancel = handlers.get('fs:uploadCancel')!(other, { uploadId: 'drop6' });
      second = invoke('fs:upload', args);
      disposeFsWatchersForWindow(1);
    };
    const res = await invoke('fs:upload', args);
    onPush.fn = null;
    expect(otherCancel).toEqual({ ok: false });
    // The same id cannot run twice at once.
    expect(await second).toMatchObject({ code: 'EBUSY' });
    expect(res).toMatchObject({ ok: false, cancelled: true });
    // Cancelled before anything was written - or mid-way: never every file,
    // never a temp file.
    const left = readdirSync(dest).length > 0 ? readdirSync(join(dest, 'many')) : [];
    expect(left.length).toBeLessThan(40);
    expect(left.some((n) => n.includes('.double0-upload-'))).toBe(false);
  });
});
