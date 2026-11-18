import { describe, expect, it } from 'vitest';
// The environment rule behind the red dev launcher icon and the " - DEV"
// window-title suffix. Two things must never happen: a release reading DEV,
// and a dev instance looking like the release next to it in the dock.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appIdFor,
  decorateWindowTitle,
  isDemoInstance,
  isLoopbackUrl,
  resolveAppEnv,
  resolveDesktopProtocol,
  resolveShownEnv,
  resolveUserDataDir,
} from './app-env';

describe('resolveAppEnv', () => {
  it('is local for anything not packaged, whatever API it points at', () => {
    expect(resolveAppEnv({ packaged: false, apiBaseUrl: 'https://api.example.test' })).toBe(
      'local',
    );
    expect(resolveAppEnv({ packaged: false, apiBaseUrl: undefined })).toBe('local');
  });

  it('is production only for a packaged build talking to a real host', () => {
    expect(resolveAppEnv({ packaged: true, apiBaseUrl: 'https://api.example.test' })).toBe(
      'production',
    );
  });

  it('is local for a packaged build with no baked API URL - that build talks to localhost', () => {
    // scripts/main-env.mjs inlines `undefined` for an unset VITE_API_URL and
    // auth-client.ts falls back to http://localhost:3000: not a release.
    expect(resolveAppEnv({ packaged: true, apiBaseUrl: undefined })).toBe('local');
    expect(resolveAppEnv({ packaged: true, apiBaseUrl: 'http://localhost:3000' })).toBe('local');
  });

  // The core build has no API: a self-built double0 Core showed the red icon,
  // " - DEV" titles and kept its data in a `-dev` folder.
  it('is production for a packaged core build, which has no backend to compare against', () => {
    expect(resolveAppEnv({ packaged: true, apiBaseUrl: undefined, edition: 'core' })).toBe(
      'production',
    );
    expect(resolveAppEnv({ packaged: false, apiBaseUrl: undefined, edition: 'core' })).toBe(
      'local',
    );
  });
});

describe('isLoopbackUrl', () => {
  it('recognises every spelling of this machine', () => {
    for (const url of [
      'http://localhost:3000',
      'http://localhost',
      'http://127.0.0.1:3000',
      'http://127.1.2.3',
      'http://[::1]:3000',
      'http://0.0.0.0:3000',
      'http://api.localhost:3000',
    ]) {
      expect(isLoopbackUrl(url), url).toBe(true);
    }
  });

  it('is false for a real host, including one that merely contains "localhost"', () => {
    expect(isLoopbackUrl('https://api.example.test')).toBe(false);
    expect(isLoopbackUrl('https://localhost.example.com')).toBe(false);
    expect(isLoopbackUrl('http://10.0.0.5:3000')).toBe(false);
  });

  it('treats an unparseable URL as loopback - it is no production backend', () => {
    expect(isLoopbackUrl('not a url')).toBe(true);
    expect(isLoopbackUrl('')).toBe(true);
  });
});

describe('decorateWindowTitle', () => {
  it('suffixes a local instance so it reads apart from the release in the title bar', () => {
    expect(decorateWindowTitle('double0', 'local')).toBe('double0 - DEV');
    // Torn-off windows set their own title; the suffix follows whatever it is.
    expect(decorateWindowTitle('acme › login-flow', 'local')).toBe('acme › login-flow - DEV');
  });

  it('leaves a production title exactly as the renderer set it', () => {
    expect(decorateWindowTitle('double0', 'production')).toBe('double0');
  });
});

describe('resolveShownEnv', () => {
  it('is a demo instance only unpackaged with DOUBLE0_DEMO=1', () => {
    expect(isDemoInstance({ packaged: false, demo: '1' })).toBe(true);
    expect(isDemoInstance({ packaged: false, demo: undefined })).toBe(false);
    expect(isDemoInstance({ packaged: false, demo: 'true' })).toBe(false);
    expect(isDemoInstance({ packaged: true, demo: '1' })).toBe(false);
  });

  it('shows a dev instance as the release only with DOUBLE0_DEMO=1', () => {
    expect(resolveShownEnv({ env: 'local', packaged: false, demo: '1' })).toBe('production');
    expect(resolveShownEnv({ env: 'local', packaged: false, demo: undefined })).toBe('local');
    // Only the exact switch: a stray value is not a request to hide the tells.
    expect(resolveShownEnv({ env: 'local', packaged: false, demo: 'true' })).toBe('local');
  });

  it('never lets a local packaged build pass for the release', () => {
    expect(resolveShownEnv({ env: 'local', packaged: true, demo: '1' })).toBe('local');
  });

  it('leaves the release as it is', () => {
    expect(resolveShownEnv({ env: 'production', packaged: true, demo: undefined })).toBe(
      'production',
    );
  });
});

describe('resolveUserDataDir', () => {
  const join = (...parts: string[]): string => parts.join('/');
  const base = {
    appData: '/Users/emmaw/Library/Application Support',
    appName: 'double0-desktop',
    join,
  };

  it('gives a local instance its own folder next to the release one', () => {
    // Both builds used to share `double0-desktop`: the installed app quit
    // silently while `pnpm dev` held the single-instance lock (2026-09-16).
    expect(resolveUserDataDir({ ...base, env: 'local', explicit: false })).toBe(
      '/Users/emmaw/Library/Application Support/double0-desktop-dev',
    );
  });

  it("leaves the release's folder alone", () => {
    expect(resolveUserDataDir({ ...base, env: 'production', explicit: false })).toBeNull();
  });

  it('never overrides an explicit --user-data-dir, whatever the environment', () => {
    // The isolated second instance (CLAUDE.md › Driving the real app) passes
    // its own scratch folder on the command line.
    expect(resolveUserDataDir({ ...base, env: 'local', explicit: true })).toBeNull();
    expect(resolveUserDataDir({ ...base, env: 'production', explicit: true })).toBeNull();
  });

  // The core build is a different app (a private plan):
  // sharing the official app's folder would share its single-instance lock -
  // one quits silently while the other runs - and its database and settings.
  it('keeps the core build in a folder of its own, beside the official ones', () => {
    expect(
      resolveUserDataDir({ ...base, edition: 'core', env: 'production', explicit: false }),
    ).toBe('/Users/emmaw/Library/Application Support/double0-desktop-core');
    expect(resolveUserDataDir({ ...base, edition: 'core', env: 'local', explicit: false })).toBe(
      '/Users/emmaw/Library/Application Support/double0-desktop-core-dev',
    );
    expect(
      resolveUserDataDir({ ...base, edition: 'core', env: 'local', explicit: true }),
    ).toBeNull();
  });

  it('leaves the official edition exactly where it was', () => {
    expect(
      resolveUserDataDir({ ...base, edition: 'pro', env: 'production', explicit: false }),
    ).toBeNull();
    expect(resolveUserDataDir({ ...base, edition: 'pro', env: 'local', explicit: false })).toBe(
      '/Users/emmaw/Library/Application Support/double0-desktop-dev',
    );
  });
});

describe('appIdFor', () => {
  // The core build is another app: sharing the id would group its windows and
  // notifications with the official app's on Windows.
  it('gives the core build its own id', () => {
    expect(appIdFor('pro')).toBe('com.double0.desktop');
    expect(appIdFor('core')).toBe('com.double0.desktop.core');
  });

  // A self-built package that disagrees with the running app: a scheme it
  // never answers, or no migrations folder - the database never opens.
  it('agrees with the open-source packaging config', () => {
    const config = readFileSync(join(__dirname, '../../electron-builder.core.yml'), 'utf8');
    expect(config).toMatch(new RegExp(`^appId: ${appIdFor('core').replace(/\./g, '\\.')}$`, 'm'));
    expect(config).toContain(
      `      - ${resolveDesktopProtocol(undefined, undefined, 'core', true)}\n`,
    );
    expect(config).toMatch(/- from: src\/main\/db\/migrations\n\s+to: migrations\n/);
  });
});

describe('resolveDesktopProtocol', () => {
  // Both instances claiming one scheme let the OS hand the production
  // dashboard's "Open double0" to the dev client.
  it('picks the scheme by the API host, as the dashboard does', () => {
    expect(resolveDesktopProtocol(undefined, undefined)).toBe('com.double0.desktop-dev');
    expect(resolveDesktopProtocol('http://localhost:3001', undefined)).toBe(
      'com.double0.desktop-dev',
    );
    // A dev client against a remote API gets that dashboard's sign-in link.
    expect(resolveDesktopProtocol('https://api.example.test', undefined)).toBe(
      'com.double0.desktop',
    );
  });

  it("gives the core build its own scheme, so it never answers the official app's links", () => {
    // No API to key on: a packaged core build answers the scheme its
    // installer declares, `pnpm dev:core` the `-dev` one.
    expect(resolveDesktopProtocol(undefined, undefined, 'core', true)).toBe(
      'com.double0.desktop-core',
    );
    expect(resolveDesktopProtocol('https://api.example.test', undefined, 'core', false)).toBe(
      'com.double0.desktop-core-dev',
    );
    expect(resolveDesktopProtocol(undefined, undefined, 'core')).toBe(
      'com.double0.desktop-core-dev',
    );
    expect(resolveDesktopProtocol('https://api.example.test', undefined, 'pro')).toBe(
      'com.double0.desktop',
    );
  });

  it('lets an explicit VITE_DESKTOP_PROTOCOL win', () => {
    expect(resolveDesktopProtocol(undefined, 'com.example.app')).toBe('com.example.app');
    expect(resolveDesktopProtocol('https://api.example.test', 'com.example.app')).toBe(
      'com.example.app',
    );
  });
});
