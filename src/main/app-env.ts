import type { Edition } from './extension';
/**
 * Which environment this instance belongs to - the one fact behind the red
 * launcher icon (app-icon.ts), the " - DEV" suffix on every window title
 * (index.ts, createWindow) and the DEV badge in the header, which is the
 * window's title bar (window-chrome.ts). The logo itself stays untouched.
 *
 * `production` means exactly one thing: a packaged build that talks to a real
 * backend host. Everything else is `local` - `pnpm dev` whatever API it points
 * at, and a packaged build whose baked VITE_API_URL is unset (the localhost
 * fallback of auth-client.ts, see scripts/main-env.mjs) or names the machine
 * itself: such a build is an experiment, never a release, and should look
 * like one next to the installed app.
 *
 * Pure (no Electron) so the rule is testable; app-icon.ts binds it.
 */
export type AppEnv = 'local' | 'production';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/**
 * True when `url` names the developer's own machine - or cannot name any host
 * at all: an unparseable API URL is no production backend either.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      LOOPBACK_HOSTS.has(hostname) || hostname.startsWith('127.') || hostname.endsWith('.localhost')
    );
  } catch {
    return true;
  }
}

export function resolveAppEnv(input: {
  packaged: boolean;
  /** `process.env.VITE_API_URL` as baked into the main bundle; unset means the localhost fallback. */
  apiBaseUrl: string | undefined;
  /**
   * The core build has no backend at all (a private plan):
   * packaged, it is a release - a self-built double0 Core must not look like
   * a dev build (red icon, " - DEV", a `-dev` data folder and scheme).
   */
  edition?: Edition;
}): AppEnv {
  if (!input.packaged) return 'local';
  if (input.edition === 'core') return 'production';
  if (input.apiBaseUrl === undefined || isLoopbackUrl(input.apiBaseUrl)) return 'local';
  return 'production';
}

/**
 * The environment this instance SHOWS - the DEV badge, the " - DEV" title
 * suffix and the red icon - as opposed to the one it IS (`resolveAppEnv`),
 * which keeps deciding the data folder, the deep-link scheme and crash
 * reporting. `DOUBLE0_DEMO=1` makes an unpackaged (`pnpm dev`) instance look
 * like the release, for the seeded instance marketing films
 * (../marketing/docs/plan/01-demo-environment.md): footage must not show the
 * dev tells. A packaged build ignores it - a local packaged build must never
 * pass for the release next to the installed app.
 */
export function resolveShownEnv(input: {
  env: AppEnv;
  packaged: boolean;
  /** `process.env.DOUBLE0_DEMO`. */
  demo: string | undefined;
}): AppEnv {
  return isDemoInstance(input) ? 'production' : input.env;
}

/**
 * A `DOUBLE0_DEMO=1` dev instance - the seeded one marketing films and
 * screenshots. Besides hiding the dev tells (`resolveShownEnv`) it hides the
 * macOS traffic lights and the room the header keeps for them: a screencast
 * or screenshot of the page never captures the native buttons, so the footage
 * would show an empty gap before the logo. A packaged build is never one.
 */
export function isDemoInstance(input: { packaged: boolean; demo: string | undefined }): boolean {
  return !input.packaged && input.demo === '1';
}

/** The release's deep-link scheme; a local instance registers `<this>-dev`. */
export const RELEASE_DESKTOP_PROTOCOL = 'com.double0.desktop';

/**
 * The URL scheme this instance registers with the OS. Both the installed app
 * and `pnpm dev` used to claim `com.double0.desktop`, and the OS hands a
 * scheme to whichever app claimed it last - so the production dashboard's
 * "Open double0" (and its sign-in handoff) launched the dev client. A local
 * instance answers `com.double0.desktop-dev` instead.
 *
 * Chosen by the API host, the dashboard's own rule (its `electron-handoff.ts`):
 * a loopback (or unset - the localhost fallback) API means `-dev`. Keyed on
 * "packaged?" before, `pnpm dev` against a remote API listened on `-dev`
 * while that API's dashboard sent sign-in to the release scheme
 * (review, 2026-10-06). A packaged build against a loopback API answers
 * `-dev` too, which its installer does not declare: such a build sets
 * `VITE_DESKTOP_PROTOCOL` (index.ts warns). An explicit override wins.
 */
export function resolveDesktopProtocol(
  apiBaseUrl: string | undefined,
  override: string | undefined,
  edition: Edition = 'pro',
  packaged = false,
): string {
  if (override) return override;
  // The core build (a private plan) is a different app:
  // it must never answer the official app's links (the dashboard's handoff).
  // It has no API either, so its scheme follows the package alone - the one
  // its installer declares (electron-builder.core.yml) when packaged.
  if (edition === 'core') {
    const base = `${RELEASE_DESKTOP_PROTOCOL}-core`;
    return packaged ? base : `${base}-dev`;
  }
  const base = RELEASE_DESKTOP_PROTOCOL;
  return apiBaseUrl === undefined || isLoopbackUrl(apiBaseUrl) ? `${base}-dev` : base;
}

/**
 * The app's id - the bundle id, and the Windows app user model id notifications
 * and the taskbar group by. The core build is a different app
 * (a private plan), packaged as `com.double0.desktop.core`
 * (electron-builder.core.yml), so it never shares the official app's identity.
 */
export function appIdFor(edition: Edition): string {
  return edition === 'core' ? 'com.double0.desktop.core' : 'com.double0.desktop';
}

/**
 * The window title as the title bar and the app switcher show it: a local
 * instance reads "double0 - DEV" (a torn-off window "project › session - DEV")
 * next to the release's plain title. The renderer owns the title itself
 * (index.html's <title>, a detached window's document.title) and never knows
 * about environments; main decorates whatever it sets.
 */
export function decorateWindowTitle(title: string, env: AppEnv): string {
  return env === 'local' ? `${title} - DEV` : title;
}

/**
 * Where this instance keeps its data. A local instance gets its own folder,
 * `<appData>/<appName>-dev`, next to the release's `<appData>/<appName>`:
 * Electron's single-instance lock, the PGlite database, localStorage and the
 * auth session all live under userData, so sharing the folder meant the
 * installed app quit silently whenever `pnpm dev` was running (and the other
 * way round), and a dev experiment could corrupt the release's database. An
 * explicit `--user-data-dir` (the isolated-instance recipe in CLAUDE.md) wins:
 * `null` means "leave Electron's path alone".
 */
export function resolveUserDataDir(input: {
  env: AppEnv;
  /** True when the command line carries `--user-data-dir`. */
  explicit: boolean;
  /** `app.getPath('appData')`. */
  appData: string;
  /** `app.getName()` - the package name, `double0-desktop`. */
  appName: string;
  /**
   * The core build keeps its own folder (`<appName>-core`, `-core-dev` locally)
   * so it never shares the official app's database, single-instance lock or
   * settings (a private plan › decision 6).
   */
  edition?: Edition;
  join: (...parts: string[]) => string;
}): string | null {
  if (input.explicit) return null;
  const name = input.edition === 'core' ? `${input.appName}-core` : input.appName;
  if (input.env === 'local') return input.join(input.appData, `${name}-dev`);
  return name === input.appName ? null : input.join(input.appData, name);
}
