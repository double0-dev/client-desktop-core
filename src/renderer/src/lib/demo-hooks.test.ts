import { afterEach, describe, expect, it } from 'vitest';
import { installDemoHooks } from './demo-hooks';
import { collectAppSettings, importDocument } from './settings/settings-transfer';
import { pooledTerminalTexts } from './terminal/pool';

// The marketing demo seeder drives a dev instance through these. A release
// must never expose them: anything in the page could import a whole database.
describe('installDemoHooks', () => {
  afterEach(() => {
    delete window.__double0;
  });

  it('exposes the export import, the settings collector and terminal text in a dev build', () => {
    installDemoHooks(window, true);
    expect(window.__double0?.importDocument).toBe(importDocument);
    expect(window.__double0?.collectAppSettings).toBe(collectAppSettings);
    expect(window.__double0?.terminalTexts).toBe(pooledTerminalTexts);
  });

  it('exposes nothing in a release build', () => {
    installDemoHooks(window, false);
    expect(window.__double0).toBeUndefined();
  });
});
