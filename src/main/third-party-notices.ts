import { app, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isTrustedSender } from './ipc-util';

/**
 * Settings › General › Open-source licences (a private plan ›
 * E): the notices the build wrote beside `main/` (`out/third-party-notices.json`,
 * scripts/third-party-notices.mjs) - every bundled or shipped package with its
 * licence texts - and Electron's and Chromium's own licence files, which
 * electron-builder places next to the binary (macOS: `Contents/Resources`).
 */

/** The notices document (scripts/third-party-notices.d.mts › NoticesDocument). */
export type NoticesDocument = {
  version: 1;
  packages: {
    name: string;
    version: string;
    license: string | null;
    files: { name: string; text: number }[];
  }[];
  texts: string[];
};

export type NoticesAnswer =
  { ok: true; notices: NoticesDocument } | { ok: false; code: 'ENOENT' | 'EINVAL' };

/** Electron's own licence files: which one, and its name on disk. */
export const PLATFORM_LICENSES = {
  electron: 'LICENSE.electron.txt',
  chromium: 'LICENSES.chromium.html',
} as const;
export type PlatformLicense = keyof typeof PLATFORM_LICENSES;

export type NoticesDeps = {
  /** `app.getAppPath()`: the archive root packaged, the project root in dev. */
  appPath: string;
  /** `process.resourcesPath`, where a macOS package keeps Electron's licence files. */
  resourcesPath: string;
  /** `process.execPath`; Windows and Linux keep them next to it. */
  execPath: string;
  packaged: boolean;
  exists?: (path: string) => boolean;
  read?: (path: string) => Promise<string>;
  openPath?: (path: string) => Promise<string>;
};

const CHANNELS = ['notices:list', 'notices:openPlatform'] as const;

/** Where the build put the notices: `out/` beside `main/`. */
export function noticesPath(appPath: string): string {
  return join(appPath, 'out', 'third-party-notices.json');
}

/**
 * Where an Electron licence file lives: in a package `Contents/Resources`
 * (macOS) or next to the executable; in development, Electron's own dist
 * folder in node_modules (`LICENSE` there - electron-builder renames it).
 */
export function platformLicenseCandidates(
  which: PlatformLicense,
  deps: Pick<NoticesDeps, 'appPath' | 'resourcesPath' | 'execPath' | 'packaged'>,
): string[] {
  const file = PLATFORM_LICENSES[which];
  if (!deps.packaged) {
    const dist = join(deps.appPath, 'node_modules', 'electron', 'dist');
    return [join(dist, which === 'electron' ? 'LICENSE' : file)];
  }
  return [join(deps.resourcesPath, file), join(dirname(deps.execPath), file)];
}

/** A well-formed notices document, or null. */
export function parseNotices(raw: string): NoticesDocument | null {
  try {
    const doc = JSON.parse(raw) as Partial<NoticesDocument>;
    if (doc.version !== 1 || !Array.isArray(doc.packages) || !Array.isArray(doc.texts)) return null;
    return doc as NoticesDocument;
  } catch {
    return null;
  }
}

export function registerThirdPartyNoticesIpc(deps: NoticesDeps = defaultDeps()): () => void {
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? ((p: string) => readFile(p, 'utf8'));
  const openPath = deps.openPath ?? ((p: string) => shell.openPath(p));
  // Read once: the file is part of the app and never changes while it runs.
  let cached: Promise<NoticesAnswer> | null = null;
  const load = async (): Promise<NoticesAnswer> => {
    const path = noticesPath(deps.appPath);
    // A development build (`pnpm dev`) writes no notices - only `electron-vite build` does.
    if (!exists(path)) return { ok: false, code: 'ENOENT' };
    const notices = parseNotices(await read(path));
    return notices ? { ok: true, notices } : { ok: false, code: 'EINVAL' };
  };

  ipcMain.handle('notices:list', async (event): Promise<NoticesAnswer | null> => {
    if (!isTrustedSender(event)) return null;
    cached ??= load().catch((): NoticesAnswer => ({ ok: false, code: 'ENOENT' }));
    const answer = await cached;
    // A missing file may appear (a build while the app runs); only a hit is kept.
    if (!answer.ok) cached = null;
    return answer;
  });

  ipcMain.handle('notices:openPlatform', async (event, which: unknown): Promise<boolean> => {
    if (!isTrustedSender(event)) return false;
    if (which !== 'electron' && which !== 'chromium') return false;
    const path = platformLicenseCandidates(which, deps).find((p) => exists(p));
    if (!path) return false;
    // openPath answers '' on success, an error message otherwise.
    return (await openPath(path)) === '';
  });

  return () => {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

function defaultDeps(): NoticesDeps {
  return {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    packaged: app.isPackaged,
  };
}
