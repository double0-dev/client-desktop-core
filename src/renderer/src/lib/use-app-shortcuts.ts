import { useEffect, useRef } from 'react';
import { isAppLocked } from './app-lock';
import {
  commands as allCommands,
  getKeymap,
  isCapturing,
  matchCombo,
  type CommandId,
} from '@renderer/lib/settings/keyboard-shortcuts';

export type AppCommandId = Extract<CommandId, 'open-settings' | 'search-everywhere' | 'go-to-file'>;

/** The app-group command a keydown names, or null. Exported for tests. */
export function appCommandFor(e: KeyboardEvent): AppCommandId | null {
  const keymap = getKeymap();
  const cmd = allCommands().find((c) => c.group === 'app' && matchCombo(e, keymap[c.id]));
  return (cmd?.id as AppCommandId | undefined) ?? null;
}

/**
 * The app-group keys (⌘, / ⇧⌘P / ⌘P): one capture-phase listener for the
 * window, mounted by the app-level palette host so they work on every route -
 * the no-project workspace has no session and so no workspace handler. They
 * fire from text fields, the editor and terminals alike (none of their keys is
 * typing), and stand down while a Settings row captures a binding or a modal
 * dialog is open. The key never reaches the page: Monaco and xterm would
 * otherwise act on it too.
 */
export function useAppShortcuts(run: (id: AppCommandId) => void): void {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isCapturing()) return;
      // A cover over the whole window (lib/app-lock.ts) owns the keyboard.
      if (isAppLocked()) return;
      const id = appCommandFor(e);
      if (!id) return;
      if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) return;
      e.preventDefault();
      e.stopPropagation();
      runRef.current(id);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
