import { execFile } from 'node:child_process';

/**
 * Whether Linux has a file manager to reveal an item in. `shell.showItemInFolder`
 * returns nothing and fails silently there (the FileManager1 D-Bus call, then
 * `xdg-open` on the folder), so "Reveal in folder" reported success on a
 * system with none - WSL, a bare window manager (2026-10-29). A file manager
 * registers as the handler for folders: an empty `xdg-mime` answer means none.
 * Anything that is not a clear "none" (no xdg-mime, an error) counts as
 * present, so the reveal is never blocked on a guess.
 */
export function folderHandlerFound(stdout: string | null): boolean {
  return stdout === null || stdout.trim().length > 0;
}

export function linuxHasFileManager(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('xdg-mime', ['query', 'default', 'inode/directory'], { timeout: 3000 }, (err, out) =>
      resolve(folderHandlerFound(err ? null : String(out))),
    );
  });
}
