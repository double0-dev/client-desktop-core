import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join, posix } from 'node:path';
import { homedir, userInfo } from 'node:os';

/**
 * PATH resolution for spawning developer tools (language servers). A macOS GUI
 * app inherits launchd's minimal PATH (`/usr/bin:/bin:…`) - none of the
 * Homebrew/toolchain dirs where servers actually live - so the user's login
 * shell is asked once for its PATH and the result cached. Well-known tool dirs
 * are appended as a belt for shells that print nothing (missing rc files,
 * non-interactive guards).
 */

/** Well-known tool folders, per platform: Linux adds snap's, Linuxbrew's and
 * npm's user prefix (a .desktop launch inherits none of them). */
export function extraToolDirs(platform: NodeJS.Platform, home: string): string[] {
  const common = [
    '/usr/local/bin',
    posix.join(home, 'go', 'bin'),
    posix.join(home, '.cargo', 'bin'),
    posix.join(home, '.local', 'bin'),
  ];
  if (platform === 'darwin') return ['/opt/homebrew/bin', ...common];
  return [
    ...common,
    '/snap/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    posix.join(home, '.linuxbrew', 'bin'),
    posix.join(home, '.npm-global', 'bin'),
  ];
}

/**
 * The shell asked for the login PATH: `$SHELL`, else the account's own shell,
 * else the platform's usual one. The zsh fallback was right on macOS only - a
 * stock Ubuntu has no zsh, so the lookup failed and the login PATH was lost.
 */
export function loginShellFor(
  platform: NodeJS.Platform,
  envShell: string | undefined,
  accountShell: string | null | undefined,
): string {
  if (envShell) return envShell;
  if (accountShell) return accountShell;
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

function accountShell(): string | null {
  try {
    return userInfo().shell;
  } catch {
    return null;
  }
}

let cached: Promise<string> | null = null;

function loginShellPath(): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = loginShellFor(process.platform, process.env.SHELL, accountShell());
    let out = '';
    let settled = false;
    const done = (value: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      // -i so ~/.zshrc (where PATH tweaks usually live) is sourced; -l for
      // login profiles. Output is just $PATH - no user-visible side effects.
      const child = spawn(shell, ['-ilc', 'echo -n "$PATH"'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.on('error', () => done(null));
      child.on('close', (code) => done(code === 0 && out.includes('/') ? out.trim() : null));
    } catch {
      done(null);
    }
  });
}

/** The merged PATH for tool spawns: login-shell PATH (if it answered) +
 * process PATH + well-known dirs, deduped, order-preserving. */
export function resolveUserPath(): Promise<string> {
  cached ??= (async () => {
    const fromShell = process.platform === 'win32' ? null : await loginShellPath();
    const parts = [
      ...(fromShell ? fromShell.split(delimiter) : []),
      ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
      ...(process.platform === 'win32' ? [] : extraToolDirs(process.platform, homedir())),
    ];
    return [...new Set(parts.filter(Boolean))].join(delimiter);
  })();
  return cached;
}

/** Absolute path of `bin` on the resolved PATH, or null. */
export async function findOnPath(bin: string): Promise<string | null> {
  return findOnPathIn(bin, await resolveUserPath());
}

/** Absolute path of `bin` on the given PATH (Windows tries .exe/.cmd/.bat), or null. */
export async function findOnPathIn(bin: string, path: string): Promise<string | null> {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of path.split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}
