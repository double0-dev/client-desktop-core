import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings › General › Open-source licences, main's side
 * (src/main/third-party-notices.ts): the notices the build wrote beside
 * `out/main`, and Electron's and Chromium's own licence files where
 * electron-builder put them.
 */

const { handlers, removed, trusted } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  removed: [] as string[],
  trusted: { value: true },
}));
vi.mock('electron', () => ({
  app: { getAppPath: () => '/app', isPackaged: false },
  shell: { openPath: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      removed.push(channel);
      handlers.delete(channel);
    },
  },
}));
vi.mock('./ipc-util', () => ({ isTrustedSender: () => trusted.value }));

const { noticesPath, parseNotices, platformLicenseCandidates, registerThirdPartyNoticesIpc } =
  await import('./third-party-notices');

const DOC = {
  version: 1,
  packages: [
    { name: 'react', version: '19.1.0', license: 'MIT', files: [{ name: 'LICENSE', text: 0 }] },
  ],
  texts: ['MIT License …'],
};

type Files = Record<string, string>;

function register(
  files: Files,
  extra: { packaged?: boolean; openPath?: (p: string) => Promise<string> } = {},
) {
  const read = vi.fn(async (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p];
  });
  const openPath = vi.fn(extra.openPath ?? (async () => ''));
  const dispose = registerThirdPartyNoticesIpc({
    appPath: '/Applications/double0.app/Contents/Resources/app.asar',
    resourcesPath: '/Applications/double0.app/Contents/Resources',
    execPath: '/Applications/double0.app/Contents/MacOS/double0',
    packaged: extra.packaged ?? true,
    exists: (p) => p in files,
    read,
    openPath,
  });
  return { dispose, read, openPath };
}

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
const NOTICES =
  '/Applications/double0.app/Contents/Resources/app.asar/out/third-party-notices.json';

beforeEach(() => {
  trusted.value = true;
  handlers.clear();
  removed.length = 0;
});

describe('notices:list', () => {
  it('answers the notices the build wrote beside out/main, reading them once', async () => {
    const { read, dispose } = register({ [NOTICES]: JSON.stringify(DOC) });
    await expect(call('notices:list')).resolves.toEqual({ ok: true, notices: DOC });
    await call('notices:list');
    // Part of the app: never re-read while it runs.
    expect(read).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('says ENOENT for a build that wrote none (a development build), and looks again next time', async () => {
    const files: Files = {};
    const { dispose } = register(files);
    await expect(call('notices:list')).resolves.toEqual({ ok: false, code: 'ENOENT' });
    files[NOTICES] = JSON.stringify(DOC);
    await expect(call('notices:list')).resolves.toEqual({ ok: true, notices: DOC });
    dispose();
  });

  it('says EINVAL for a file that is not a notices document', async () => {
    const { dispose } = register({ [NOTICES]: '{"version":2}' });
    await expect(call('notices:list')).resolves.toEqual({ ok: false, code: 'EINVAL' });
    dispose();
  });

  it('answers nothing to an untrusted sender', async () => {
    const { read, dispose } = register({ [NOTICES]: JSON.stringify(DOC) });
    trusted.value = false;
    await expect(call('notices:list')).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
    dispose();
  });
});

describe('notices:openPlatform', () => {
  it('opens Chromium’s licences from Contents/Resources in a macOS package', async () => {
    const chromium = '/Applications/double0.app/Contents/Resources/LICENSES.chromium.html';
    const { openPath, dispose } = register({ [chromium]: '<html>' });
    await expect(call('notices:openPlatform', 'chromium')).resolves.toBe(true);
    expect(openPath).toHaveBeenCalledWith(chromium);
    dispose();
  });

  it('answers false when the file is not there or the system viewer refused it', async () => {
    const electron = '/Applications/double0.app/Contents/Resources/LICENSE.electron.txt';
    let { dispose } = register({});
    await expect(call('notices:openPlatform', 'electron')).resolves.toBe(false);
    dispose();
    ({ dispose } = register({ [electron]: 'MIT' }, { openPath: async () => 'No application' }));
    await expect(call('notices:openPlatform', 'electron')).resolves.toBe(false);
    dispose();
  });

  it('opens nothing for a name it does not know, a path, or an untrusted sender', async () => {
    const { openPath, dispose } = register({ '/etc/passwd': 'x' });
    await expect(call('notices:openPlatform', '/etc/passwd')).resolves.toBe(false);
    await expect(call('notices:openPlatform', { which: 'chromium' })).resolves.toBe(false);
    trusted.value = false;
    await expect(call('notices:openPlatform', 'chromium')).resolves.toBe(false);
    expect(openPath).not.toHaveBeenCalled();
    dispose();
  });

  it('removes every handler it registered', () => {
    register({}).dispose();
    expect(removed.sort()).toEqual(['notices:list', 'notices:openPlatform']);
  });
});

describe('platformLicenseCandidates', () => {
  it('looks in Contents/Resources (macOS) and next to the executable (Windows, Linux)', () => {
    const deps = {
      appPath: 'C:/double0/resources/app.asar',
      resourcesPath: 'C:/double0/resources',
      execPath: 'C:/double0/double0.exe',
      packaged: true,
    };
    expect(platformLicenseCandidates('electron', deps)).toEqual([
      'C:/double0/resources/LICENSE.electron.txt',
      'C:/double0/LICENSE.electron.txt',
    ]);
  });

  it('reads Electron’s own dist folder in development, where the file is still called LICENSE', () => {
    const deps = { appPath: '/repo', resourcesPath: '/x', execPath: '/x/y', packaged: false };
    expect(platformLicenseCandidates('electron', deps)).toEqual([
      '/repo/node_modules/electron/dist/LICENSE',
    ]);
    expect(platformLicenseCandidates('chromium', deps)).toEqual([
      '/repo/node_modules/electron/dist/LICENSES.chromium.html',
    ]);
  });
});

describe('noticesPath / parseNotices', () => {
  it('reads out/third-party-notices.json under the app path', () => {
    expect(noticesPath('/repo')).toBe('/repo/out/third-party-notices.json');
  });

  it('accepts only a version 1 document', () => {
    expect(parseNotices(JSON.stringify(DOC))).toEqual(DOC);
    expect(parseNotices('not json')).toBeNull();
    expect(parseNotices(JSON.stringify({ ...DOC, version: 2 }))).toBeNull();
    expect(parseNotices(JSON.stringify({ version: 1, packages: {} }))).toBeNull();
  });
});
