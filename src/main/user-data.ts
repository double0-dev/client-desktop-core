import { app } from 'electron';
import { join } from 'node:path';
import { resolveUserDataDir } from './app-env';
import { APP_ENV } from './app-icon';
import { EDITION } from './edition';

/**
 * Binds app-env.ts › resolveUserDataDir once, at load: a local instance moves
 * its userData (and sessionData - the Chromium profile, set explicitly so the
 * two never drift apart) to `<appData>/double0-desktop-dev` before anything
 * reads the path. index.ts imports this module FIRST: every reader of
 * `app.getPath('userData')` in main is lazy today, but the single-instance
 * lock, the PGlite database and the Chromium profile are all created from
 * this path at `ready`, and an import that ran earlier would pin the old one.
 */
const dir = resolveUserDataDir({
  env: APP_ENV,
  explicit: app.commandLine.hasSwitch('user-data-dir'),
  appData: app.getPath('appData'),
  appName: app.getName(),
  edition: EDITION,
  join,
});
if (dir !== null) {
  app.setPath('userData', dir);
  app.setPath('sessionData', dir);
}

/** The folder this instance actually uses, for log lines and diagnostics. */
export const USER_DATA_DIR: string = app.getPath('userData');
