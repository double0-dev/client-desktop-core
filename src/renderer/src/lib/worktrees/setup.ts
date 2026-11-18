/**
 * Pure helpers for a project's worktree setup (Settings → Worktrees → project):
 * the git-ignored paths copied into every new worktree and the setup tab's
 * command, both stored on the project row. Nothing here touches React or the
 * collections, so the wording and the list arithmetic are unit-testable.
 */

/** The setup as stored on the project row. */
export type WorktreeSetup = {
  worktreeCopyPaths: string[];
  worktreeSetupCommand: string | null;
};

/** One thing git ignores in the checkout, as the git bridge lists it. */
export type IgnoredEntry = {
  path: string;
  kind: 'file' | 'dir';
  locked?: string;
  bytes?: number;
};

export const EMPTY_SETUP: WorktreeSetup = { worktreeCopyPaths: [], worktreeSetupCommand: null };

export function setupCommandOf(setup: WorktreeSetup): string {
  return (setup.worktreeSetupCommand ?? '').trim();
}

/** Whether the project copies anything or runs anything - "Not set up" otherwise. */
export function isWorktreeSetUp(setup: WorktreeSetup): boolean {
  return setup.worktreeCopyPaths.length > 0 || setupCommandOf(setup).length > 0;
}

/**
 * The one-line summary under a project on Settings → Worktrees (design:
 * `4 of 11 ignored entries · pnpm install`). `ignoredCount` is what the last
 * scan found, null before the checkout was scanned.
 */
export function describeWorktreeSetup(
  setup: WorktreeSetup,
  ignoredCount: number | null,
): { text: string; muted: boolean } {
  const command = setupCommandOf(setup);
  const ticked = setup.worktreeCopyPaths.length;
  if (ticked === 0 && !command) {
    return { text: 'Not set up - nothing is copied, no setup command', muted: true };
  }
  const copies =
    ticked === 0
      ? 'nothing copied'
      : ignoredCount == null
        ? `${ticked} ignored ${ticked === 1 ? 'entry' : 'entries'}`
        : `${ticked} of ${ignoredCount} ignored entries`;
  return { text: `${copies} · ${command || 'no setup command'}`, muted: false };
}

/**
 * The note under the New Session dialog's worktree toggle: what this project's
 * setup will do to the worktree before the agent starts, or null when the
 * project isn't set up (the toggle then reads as before).
 */
export function describeWorktreePrefill(projectName: string, setup: WorktreeSetup): string | null {
  const command = setupCommandOf(setup);
  const paths = setup.worktreeCopyPaths;
  if (paths.length === 0 && !command) return null;
  const sample = paths.slice(0, 2).join(', ') + (paths.length > 2 ? ', …' : '');
  const copies =
    paths.length > 0
      ? `copies ${paths.length} ignored ${paths.length === 1 ? 'entry' : 'entries'} (${sample})`
      : '';
  const runs = command ? `runs ${command}` : '';
  const does = [copies, runs].filter(Boolean).join(' and ');
  return `${projectName} ${does} first - change this in Settings → Worktrees.`;
}

/** Tick or untick one path, keeping the list in the checkout's listing order. */
export function togglePath(
  paths: string[],
  path: string,
  on: boolean,
  order: readonly string[],
): string[] {
  const set = new Set(paths);
  if (on) set.add(path);
  else set.delete(path);
  const rank = new Map(order.map((p, i) => [p, i]));
  return [...set].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
}

/** "Files only": every ignored file that isn't locked - folders stay unticked. */
export function filesOnly(entries: readonly IgnoredEntry[]): string[] {
  return entries.filter((e) => e.kind === 'file' && !e.locked).map((e) => e.path);
}

/**
 * Ticked paths the last scan didn't list - deleted since, or ignored no more.
 * Kept in the setup (the file may come back) and shown as "not in checkout";
 * the seed simply skips them.
 */
export function missingPaths(setup: WorktreeSetup, entries: readonly IgnoredEntry[]): string[] {
  const listed = new Set(entries.map((e) => e.path));
  return setup.worktreeCopyPaths.filter((p) => !listed.has(p));
}

/** `1.3 GB` / `48 MB` / `12 KB` - one decimal only where it matters. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}
