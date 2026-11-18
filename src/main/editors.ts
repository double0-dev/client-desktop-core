import { isRemotePath } from './host-runtime';
import { ipcMain } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isTrustedSender } from './ipc-util';
import { findOnPath } from './user-path';

/**
 * Detects installed external IDEs and launches one on a folder - powering the
 * "Open in…" launchers and the Search Everywhere "Open in <IDE>" actions. A session's working directory (its worktree, or the project
 * folder when it has no worktree) is handed to the chosen editor so it opens in
 * a new window.
 *
 * macOS: detection walks the standard app folders (with a Spotlight fallback
 * for non-standard installs like JetBrains Toolbox) and launch shells out to
 * `open -a <app> <folder>`. Linux: each editor's command-line launchers are
 * looked up on the user's PATH (`code`, `idea`, the snap names) and the found
 * one is started detached on the folder - `idea` stays in the foreground for
 * the IDE's whole life (2026-10-29). Windows: detection returns an empty list,
 * so the UI simply hides the launcher.
 */

export type EditorId = 'vscode' | 'xcode' | 'android-studio' | 'intellij';

type EditorDef = {
  id: EditorId;
  name: string;
  /** Launch Services bundle ids (for the Spotlight fallback). */
  bundleIds: string[];
  /** Candidate `.app` bundle names under the standard app folders. */
  appNames: string[];
  /** Linux launcher commands, first found wins (package, snap and tarball names). */
  linuxCommands: string[];
};

/** The IDEs we know how to detect + launch, in menu order. */
const EDITORS: EditorDef[] = [
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    bundleIds: ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders'],
    appNames: ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'],
    linuxCommands: ['code', 'code-insiders'],
  },
  {
    id: 'xcode',
    name: 'Xcode',
    bundleIds: ['com.apple.dt.Xcode'],
    appNames: ['Xcode.app'],
    linuxCommands: [],
  },
  {
    id: 'android-studio',
    name: 'Android Studio',
    bundleIds: ['com.google.android.studio'],
    appNames: ['Android Studio.app'],
    linuxCommands: ['android-studio', 'studio.sh'],
  },
  {
    id: 'intellij',
    name: 'IntelliJ IDEA',
    bundleIds: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'],
    appNames: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app', 'IntelliJ IDEA Community Edition.app'],
    linuxCommands: ['idea', 'intellij-idea-ultimate', 'intellij-idea-community', 'idea.sh'],
  },
];

/** The renderer-facing shape: just enough to render + dispatch a launch. */
export type InstalledEditor = { id: EditorId; name: string };

const UNTRUSTED = { error: 'Untrusted sender' } as const;

// Standard app install locations checked before falling back to Spotlight.
const APP_DIRS = ['/Applications', join(homedir(), 'Applications')];

// Installed apps rarely change mid-session, so the (subprocess-heavy) detection
// is cached briefly; a stale cache at worst hides a just-installed editor for a
// few seconds.
const TTL_MS = 30000;
let cache: { at: number; found: { def: EditorDef; appPath: string }[] } | null = null;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** First app path Spotlight knows for a bundle id, or null. Covers installs
 * outside the standard folders (e.g. JetBrains Toolbox). */
function mdfindByBundleId(bundleId: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'mdfind',
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      { timeout: 4000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const first = stdout
          .split('\n')
          .map((s) => s.trim())
          .find((s) => s.endsWith('.app'));
        resolve(first ?? null);
      },
    );
  });
}

async function resolveAppPath(def: EditorDef): Promise<string | null> {
  for (const dir of APP_DIRS) {
    for (const appName of def.appNames) {
      const p = join(dir, appName);
      if (await pathExists(p)) return p;
    }
  }
  for (const bundleId of def.bundleIds) {
    const p = await mdfindByBundleId(bundleId);
    if (p) return p;
  }
  return null;
}

/** The first of an editor's Linux launchers found on PATH, or null. */
export async function resolveLinuxCommand(
  commands: readonly string[],
  find: (bin: string) => Promise<string | null>,
): Promise<string | null> {
  for (const command of commands) {
    const path = await find(command);
    if (path) return path;
  }
  return null;
}

async function detect(): Promise<{ def: EditorDef; appPath: string }[]> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return [];
  if (cache && Date.now() - cache.at <= TTL_MS) return cache.found;
  const found: { def: EditorDef; appPath: string }[] = [];
  for (const def of EDITORS) {
    const appPath =
      process.platform === 'darwin'
        ? await resolveAppPath(def)
        : await resolveLinuxCommand(def.linuxCommands, findOnPath);
    if (appPath) found.push({ def, appPath });
  }
  cache = { at: Date.now(), found };
  return found;
}

/** Start a Linux launcher on the folder without waiting for it to exit. */
function launchDetached(command: string, folder: string): Promise<{ ok?: true; error?: string }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [folder], { detached: true, stdio: 'ignore' });
      child.once('error', (err) => resolve({ error: err.message }));
      child.once('spawn', () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (err) {
      resolve({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function registerEditorsIpc(): () => void {
  // The installed subset of EDITORS (empty on Windows / when none found).
  ipcMain.handle('editors:list', async (event) => {
    if (!isTrustedSender(event)) return { editors: [] as InstalledEditor[] };
    try {
      const found = await detect();
      return { editors: found.map(({ def }) => ({ id: def.id, name: def.name })) };
    } catch {
      return { editors: [] as InstalledEditor[] };
    }
  });

  // Launch `path` (a session's worktree/project folder) in the chosen editor.
  ipcMain.handle(
    'editors:open',
    async (
      event,
      args: { editorId?: string; path?: string },
    ): Promise<{ ok?: true; error?: string }> => {
      if (!isTrustedSender(event)) return UNTRUSTED;
      const editorId = args?.editorId;
      const path = args?.path;
      if (!editorId || typeof path !== 'string' || path.length === 0) {
        return { error: 'Missing editor or path' };
      }
      // A remote host's folder is not on this machine (Open in IDE through a
      // remote editor mode is Phase 3, a private plan).
      if (isRemotePath(path)) return { error: 'That folder is on a remote host' };
      const found = await detect();
      const match = found.find(({ def }) => def.id === editorId);
      if (!match) return { error: 'Editor not installed' };
      if (process.platform === 'linux') return launchDetached(match.appPath, path);
      return await new Promise((resolve) => {
        // `open -a <app> <folder>` opens the folder in a new window of that app.
        execFile('open', ['-a', match.appPath, path], { timeout: 8000 }, (err) => {
          resolve(err ? { error: err.message } : { ok: true });
        });
      });
    },
  );

  return () => {
    ipcMain.removeHandler('editors:list');
    ipcMain.removeHandler('editors:open');
  };
}
