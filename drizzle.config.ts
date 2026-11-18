import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// The local database is a PGlite data *directory* under Electron's userData path.
// A local instance (`pnpm dev`) keeps its data in `<app name>-dev` next to the
// release's `<app name>` folder (src/main/app-env.ts › resolveUserDataDir);
// the app name is package.json "name" (app.getName()), not electron-builder's
// productName. Studio is a dev tool, so it opens the dev folder. Point
// DOUBLE0_DB_DIR at another path to inspect a different profile.
function defaultDataDir(): string {
  const appName = 'double0-desktop-dev';
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(base, appName, 'double0-db');
}

export default defineConfig({
  dialect: 'postgresql',
  driver: 'pglite',
  // One migration history for both editions: the official tree generates it
  // from core's tables and pro/'s (the official build), and the public
  // export drops the statements of every table core does not define
  // (scripts/export-core.mjs › filterMigration).
  schema: [
    './src/main/db/schema.ts',
    ...(existsSync('./pro/main/db/schema.ts') ? ['./pro/main/db/schema.ts'] : []),
  ],
  out: './src/main/db/migrations',
  dbCredentials: {
    url: process.env.DOUBLE0_DB_DIR ?? defaultDataDir(),
  },
});
