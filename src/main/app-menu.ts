import type { MenuItemConstructorOptions } from 'electron';

/**
 * The View menu. Every key a menu accelerator claims never reaches the page,
 * and the page is mostly terminals: Ctrl+R is the shell's reverse search and
 * Claude Code's history search, Ctrl+_ readline's undo. The toolkit's
 * `watchWindowShortcuts` used to swallow Ctrl/Cmd+R, Ctrl+Shift+I and the
 * zoom keys in `before-input-event` - which kept the menu's reload off them in
 * a packaged build, but took them from the terminal too (found on Linux,
 * 2026-10-29). Instead the menu claims nothing a shell needs:
 *  - packaged: no reload / force reload / dev tools items at all (they were
 *    unreachable anyway), so ⌘R reaches a browser tab's own reload;
 *  - dev: reload stays on ⌘R on macOS, but moves to Ctrl+Shift+R elsewhere
 *    (Ctrl+R is the terminal's); dev tools keep their default keys;
 *  - zoom: off macOS the items register no accelerator - their Ctrl keys
 *    belong to the shell. On macOS ⌘0 and ⌘= keep working as they always did
 *    (the toolkit swallowed only ⌘- and ⇧⌘=), and zoom out stays keyless.
 */
export function viewMenu(opts: { mac: boolean; dev: boolean }): MenuItemConstructorOptions[] {
  const reload: MenuItemConstructorOptions[] = opts.dev
    ? [
        opts.mac ? { role: 'reload' } : { role: 'reload', accelerator: 'Ctrl+Shift+R' },
        { role: 'forceReload', registerAccelerator: false },
        { role: 'toggleDevTools' },
        { type: 'separator' },
      ]
    : [];
  return [
    ...reload,
    { role: 'resetZoom', registerAccelerator: opts.mac },
    { role: 'zoomIn', registerAccelerator: opts.mac },
    { role: 'zoomOut', registerAccelerator: false },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
}
