import type { Edition } from '../main/extension';

/**
 * The preload's Pro slot (a private plan › Extension
 * points). `preload/index.ts` is the only core file that imports
 * `@pro/preload`; the bridges are spread into `window.api`, so
 * `DesktopApi = typeof api` carries Pro's channels in the official build and
 * none in the core build.
 */
export type PreloadExtension<
  B extends object = object,
  G extends object = object,
  T extends object = object,
  S extends object = object,
> = {
  edition: Edition;
  bridges: B;
  /** The git client's methods, spread into core's `git` bridge (M4). */
  gitClient: G;
  /** The browser tabs' methods, spread into core's `browser` bridge (M5). */
  browserTabs: T;
  /** The dev servers' methods, spread into core's `terminal` bridge (M5). */
  terminalServers: S;
  /** Runs once, before `window.api` is exposed (the sign-in bridges). */
  setup?(): void;
};
