import type { PreloadExtension } from '../preload/extension';

/** The core build's `@pro/preload`: no Pro bridges. */
export const proPreload: PreloadExtension<
  Record<never, never>,
  Record<never, never>,
  Record<never, never>,
  Record<never, never>
> = {
  edition: 'core',
  bridges: {},
  gitClient: {},
  browserTabs: {},
  terminalServers: {},
};
