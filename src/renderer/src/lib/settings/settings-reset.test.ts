import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';
import { SETTINGS_APPLIED_EVENT } from '@renderer/lib/settings/settings-events';
import type { AppSettingsDoc } from '@renderer/lib/settings/settings-transfer';

/**
 * Settings → General → Reset all settings. The contract: afterwards the app
 * looks like a wiped install - every store answers with its default, every
 * carried key is gone, and per-machine memory survives.
 *
 * "Equals a wiped install" is the coverage guard. Every field is first driven
 * to a non-default value through the same path the JSON editor uses, and the
 * test refuses to continue if any field did not move (a seed that a store
 * sanitized back to its default proves nothing). A store the reset does not
 * reach - a key missing from SETTINGS_STORAGE_KEYS, or a new store without the
 * `storage` fan-out every store has - then fails the comparison by name.
 */

/** `[path, value]` for every defined leaf; arrays count as one leaf. */
function leaves(value: unknown, path = ''): [string, unknown][] {
  if (value === undefined) return [];
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
      leaves(v, path ? `${path}.${key}` : key),
    );
  }
  return [[path, value]];
}

function at(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((cur, key) => (cur as Record<string, unknown> | undefined)?.[key], value);
}

/** Every field, deliberately away from its default (values every store accepts). */
function nonDefault(fresh: AppSettingsDoc): AppSettingsDoc {
  const rail = fresh.workspace.railOrder ?? { top: [], bottom: [] };
  return {
    appearance: {
      theme: 'light',
      accentColor: '#3b82f6',
      projectAccent: false,
      fontFamily: 'inter',
      fontSize: 15,
    },
    explorer: { fontFamily: 'menlo', fontSize: 11 },
    terminal: {
      themeId: 'dracula',
      autoDark: 'dracula',
      autoLight: 'solarized-light',
      custom: {
        background: '#000000',
        foreground: '#ffffff',
        cursor: '#ff0000',
        selection: '#00ff00',
        ansi: [
          '#000001',
          '#000002',
          '#000003',
          '#000004',
          '#000005',
          '#000006',
          '#000007',
          '#000008',
        ],
      },
      fontFamily: 'menlo',
      fontSize: 15,
      lineHeight: 1.5,
      scrollback: 10000,
      scrollSpeed: 1,
      shellIntegration: false,
      engine: 'ghostty',
    },
    editor: {
      themeId: 'one-dark',
      custom: {
        background: '#000000',
        foreground: '#ffffff',
        cursor: '#ff0000',
        selection: '#00ff00',
        syntax: [
          '#000001',
          '#000002',
          '#000003',
          '#000004',
          '#000005',
          '#000006',
          '#000007',
          '#000008',
        ],
      },
      fontFamily: 'monaco',
      fontSize: 14,
      lineHeight: 1.4,
    },
    workspace: {
      dockPanels: ['tabs'],
      changesOpen: true,
      pipelinesOpen: true,
      tasksOpen: true,
      overviewOpen: true,
      dockWidth: 320,
      explorerWidth: 300,
      commandsOpen: true,
      archivedOpen: false,
      detachedDockWidth: 330,
      detachedExplorerWidth: 310,
      detachedChangesDrawerWidth: 400,
      changesDrawerWidth: 420,
      verticalTabs: true,
      // Move the last tool to the bottom cluster - both lists change.
      railOrder: { top: rail.top.slice(0, -1), bottom: rail.top.slice(-1) },
    },
    sessionTemplates: {
      user: [{ id: 't-rig', name: 'My Rig', startCommand: 'claude --resume' }],
      hiddenBuiltins: ['codex'],
    },
    shortcuts: { 'new-session': null },
    updates: { autoCheck: false },
    crashReports: { enabled: false },
    sessionCleanup: {
      autoArchive: false,
      archiveAfter: { amount: 3, unit: 'hours' },
      autoDelete: true,
      deleteAfter: { amount: 2, unit: 'weeks' },
      removeWorktree: false,
    },
    sessionDaemon: { keepRunning: false },
    liveMotion: { motion: 'off' },
    hoverScroll: { enabled: false },
    languages: { dismissedPrompts: ['python'] },
  };
}

/** A fresh module graph over the current storage - the stores read it at import. */
async function load() {
  vi.resetModules();
  const [transfer, reset] = await Promise.all([
    import('@renderer/lib/settings/settings-transfer'),
    import('@renderer/lib/settings/settings-reset'),
  ]);
  return { ...transfer, ...reset };
}

beforeEach(() => {
  window.localStorage.clear();
  stubApi();
});

describe('resetAppSettings', () => {
  it('leaves every store at the value a wiped install has', async () => {
    const wiped = await load();
    const fresh = wiped.collectAppSettings();

    // Same graph, same window: drive every field off its default first.
    wiped.applyAppSettings(nonDefault(fresh));
    const seeded = wiped.collectAppSettings();
    const unmoved = leaves(fresh)
      .filter(([path, value]) => JSON.stringify(at(seeded, path)) === JSON.stringify(value))
      .map(([path]) => path);
    expect(
      unmoved,
      'fields the seed failed to move - fix the seed before trusting this test',
    ).toEqual([]);

    wiped.resetAppSettings();
    expect(wiped.collectAppSettings()).toEqual(fresh);
    for (const key of wiped.SETTINGS_STORAGE_KEYS) {
      expect(window.localStorage.getItem(key), key).toBeNull();
    }
  });

  it('is what a restart would show too - a fresh graph reads the same defaults', async () => {
    const wiped = await load();
    const fresh = wiped.collectAppSettings();
    wiped.applyAppSettings(nonDefault(fresh));
    wiped.resetAppSettings();
    const restarted = await load();
    expect(restarted.collectAppSettings()).toEqual(fresh);
  });

  it('keeps per-machine memory - it is not a setting', async () => {
    const wiped = await load();
    window.localStorage.setItem('double0-last-project', 'p-acme');
    window.localStorage.setItem('double0-explorer-tree-state', '{"/repo":["src"]}');
    window.localStorage.setItem('double0-repo-choice', '{"gadget:/repo":"/repo/api"}');
    wiped.resetAppSettings();
    expect(window.localStorage.getItem('double0-last-project')).toBe('p-acme');
    expect(window.localStorage.getItem('double0-explorer-tree-state')).toBe('{"/repo":["src"]}');
    expect(window.localStorage.getItem('double0-repo-choice')).toBe('{"gadget:/repo":"/repo/api"}');
  });

  it('tells the live readers: every module store notifies, and the applied event fires once', async () => {
    const wiped = await load();
    const fresh = wiped.collectAppSettings();
    wiped.applyAppSettings(nonDefault(fresh));
    const terminal = await import('@renderer/lib/settings/terminal-settings');
    const seen = vi.fn();
    terminal.subscribeTerminalSettings(seen);
    const applied = vi.fn();
    window.addEventListener(SETTINGS_APPLIED_EVENT, applied);
    try {
      wiped.resetAppSettings();
    } finally {
      window.removeEventListener(SETTINGS_APPLIED_EVENT, applied);
    }
    // The terminal store re-read its cleared key and published the default.
    expect(seen).toHaveBeenLastCalledWith(fresh.terminal);
    expect(terminal.getTerminalSettings()).toEqual(fresh.terminal);
    // usePersistedState / ThemeProvider / the keymap decode on this one signal.
    expect(applied).toHaveBeenCalledTimes(1);
  });
});
