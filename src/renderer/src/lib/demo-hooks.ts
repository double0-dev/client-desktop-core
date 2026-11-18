import { collectAppSettings, importDocument } from './settings/settings-transfer';
import { pooledTerminalTexts } from './terminal/pool';

/**
 * What a script driving a dev instance over CDP may call: the marketing demo
 * seeder (../marketing/docs/plan/01-demo-environment.md) loads its world
 * through the app's own export import, which otherwise sits behind a native
 * file dialog. `collectAppSettings` gives it this install's full settings to
 * lay its overrides on - the import validates a complete settings document.
 * `terminalTexts` reads every terminal's buffer for the seeder's check that no
 * real identity is on screen (terminals are canvases, not DOM text).
 */
export type DemoHooks = {
  importDocument: typeof importDocument;
  collectAppSettings: typeof collectAppSettings;
  terminalTexts: typeof pooledTerminalTexts;
};

declare global {
  interface Window {
    __double0?: DemoHooks;
  }
}

/**
 * Expose the hooks on `target` - in a dev build only. main.tsx passes
 * `import.meta.env.DEV`, so a release never carries `window.__double0`.
 */
export function installDemoHooks(target: Window, dev: boolean): void {
  if (!dev) return;
  target.__double0 = { importDocument, collectAppSettings, terminalTexts: pooledTerminalTexts };
}
