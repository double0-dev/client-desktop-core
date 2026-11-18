import { alertDialog } from '@renderer/components/ui/confirm-dialog';

/**
 * "Reveal in Finder" and its per-OS twins: opens the system file manager on the
 * folder holding a file or folder, the item selected. The in-app explorer's own
 * "Show in file explorer" is a different action - hence the platform's product
 * name in the label, never the generic "file explorer".
 */
export function revealInOsLabel(userAgent: string): string {
  if (userAgent.includes('Mac')) return 'Reveal in Finder';
  if (userAgent.includes('Windows')) return 'Reveal in File Explorer';
  return 'Open containing folder';
}

export const REVEAL_IN_OS_LABEL = revealInOsLabel(
  typeof navigator !== 'undefined' ? navigator.userAgent : '',
);

/** Open the OS file manager on `path`; a failure (the file is gone) says so. */
export async function revealInOs(path: string): Promise<void> {
  const res = await window.api?.fs.showInFolder(path);
  if (res?.error) void alertDialog({ title: 'Could not open the folder', description: res.error });
}
