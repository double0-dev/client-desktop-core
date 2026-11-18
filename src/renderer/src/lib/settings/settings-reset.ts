import { rendererExtension } from '@renderer/lib/extension/registry';
import { dockToolStorageKey } from '@renderer/lib/workspace/dock-state';
import { emitSettingsApplied } from '@renderer/lib/settings/settings-events';

/**
 * Reset every setting to its default (Settings → General → Reset).
 *
 * Every setting is a `double0-*` localStorage key owned by one store: a module
 * store (theme, accent, fonts, terminal, editor, shortcuts, templates,
 * language prompts, vertical tabs, rail order - and the extension's own) or a
 * `usePersistedState` in a workspace component (the dock and sidebar chrome).
 * A reset makes the app look like a wiped install: every key is removed and
 * nothing is written back - an unset theme stays unset, like a first launch.
 *
 * The stores learn about it the way a torn-off window does when another
 * window clears a key: a `storage` event per key makes each module store
 * re-read its key (and find the default), and `SETTINGS_APPLIED_EVENT` reaches
 * the readers that decode on that instead (usePersistedState, ThemeProvider,
 * the keymap). Replaying the cross-window signal in-window is what keeps this
 * function free of per-store knowledge - a store that follows the pattern is
 * reset without being named here.
 *
 * Out of scope on purpose: everything that is not a setting - the database
 * (projects, sessions, layouts and the extension's rows), the
 * account tokens, SSH keys and each provider's per-project choices (they live
 * in main with the connection; disconnecting is their reset) and per-machine
 * memory (last project and session, explorer tree state, the tag-push tick,
 * the dismissed update banner - the MACHINE_LOCAL list in
 * settings-transfer.test.ts).
 *
 * `SETTINGS_STORAGE_KEYS` is the same set the export/import document carries.
 * A new setting joins it here (settings-transfer.test.ts fails until every
 * `double0-*` literal is classified) and is reset from then on;
 * settings-reset.test.ts proves the result equals a wiped install.
 */
export const SETTINGS_STORAGE_KEYS = [
  // Appearance
  'double0-theme',
  'double0-accent-color',
  'double0-project-accent',
  'double0-app-font',
  'double0-explorer-font-v2',
  // Terminal + editor
  'double0-terminal-settings',
  'double0-editor-settings',
  // Workspace chrome (usePersistedState in the workspace components)
  'double0-workspace-dock-panels',
  'double0-workspace-dock-width',
  'double0-workspace-explorer-width',
  'double0-workspace-commands-open',
  'double0-workspace-vertical-tabs',
  'double0-sidebar-archived-open',
  'double0-session-changes-width',
  'double0-detached-dock-width',
  'double0-detached-explorer-width',
  'double0-detached-session-changes-width',
  'double0-rail-order',
  // Sessions, shortcuts, editor prompts
  'double0-session-templates',
  'double0-hidden-builtin-templates',
  'double0-keyboard-shortcuts',
  'double0-session-cleanup',
  'double0-session-daemon',
  'double0-live-motion',
  'double0-hover-scroll',
  'double0-language-server-prompts',
] as const;

/** Put every setting back to its default, live, in this and every other window. */
export function resetAppSettings(): void {
  // Core's keys, then the extension's (its own settings, Pro's switches).
  // An extension's rail tools' open flags ride in the document too (`<tool>Open`).
  const extension = rendererExtension();
  const keys = [
    ...SETTINGS_STORAGE_KEYS,
    ...extension.railTools.map((t) => dockToolStorageKey(t.id)),
    ...(extension.settingsStorageKeys ?? []),
  ];
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Unwritable storage - nothing to clear; the re-read below finds what it finds.
    }
    // What another window would receive for this removal - each module store's
    // `storage` listener re-reads the key and lands on its default.
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: null }));
  }
  emitSettingsApplied();
}
