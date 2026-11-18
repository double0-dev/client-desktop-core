import { SIGN_IN_AGENTS } from './agent-table';
import { envPath, setEnvPath } from './env-path';

/**
 * The folders the agent CLIs' own installers put their binaries in
 * (a private plan › M1.2), on the PATH of every shell
 * double0 starts - here and on a host. Pure and import-free beyond two pure
 * modules: the host daemon bundles it.
 *
 * Why: the installers assume a profile that puts `~/.local/bin` on PATH. On
 * Ubuntu root's `~/.profile` never does (only `/etc/skel/.profile` has those
 * lines), OpenCode adds `~/.opencode/bin` in `.bashrc` only, and Debian's
 * `/etc/profile` resets PATH for login shells - so "installed" CLIs read
 * `command not found` in a session (found on a user's server, 2026-11-01).
 *
 * Always APPENDED, only when the folder exists, never doubled: a CLI the
 * user installed elsewhere on PATH (npm, Homebrew) keeps winning.
 */

/** From the home folder, in the table's order, each once. */
export const AGENT_BIN_DIRS: readonly string[] = [
  ...new Set(SIGN_IN_AGENTS.flatMap((a) => a.homeBins.map((b) => b.slice(0, b.lastIndexOf('/'))))),
];

/**
 * `env` with every existing agent folder under `home` appended to its PATH
 * (a new object). A no-op on Windows (the installers here are POSIX).
 */
export function withAgentBinsOnPath(
  env: Record<string, string>,
  home: string,
  isDir: (path: string) => boolean,
  platform: NodeJS.Platform,
): Record<string, string> {
  if (platform === 'win32' || !home) return env;
  const current = envPath(env, platform) ?? '';
  const parts = current.split(':').filter(Boolean);
  const base = home.replace(/\/+$/, '');
  let changed = false;
  for (const dir of AGENT_BIN_DIRS) {
    const path = `${base}/${dir}`;
    if (parts.includes(path) || !isDir(path)) continue;
    parts.push(path);
    changed = true;
  }
  return changed ? setEnvPath({ ...env }, parts.join(':'), platform) : env;
}

/**
 * The same in POSIX sh, silent, idempotent - run by double0's own zsh / bash
 * rc AFTER the user's files (a profile that resets PATH has had its say) and
 * by the launch script before the start command. Prints nothing: the launch
 * script's mark must stay its first output.
 */
export const AGENT_BINS_SNIPPET = [
  `for __double0_d in ${AGENT_BIN_DIRS.map((d) => `"$HOME/${d}"`).join(' ')}; do`,
  '  [ -d "$__double0_d" ] || continue',
  '  case ":$PATH:" in *":$__double0_d:"*) ;; *) PATH="${PATH:+$PATH:}$__double0_d" ;; esac',
  'done',
  'unset __double0_d',
].join('\n');
