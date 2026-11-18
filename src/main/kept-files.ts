/**
 * Files the app writes for its terminals (hook scripts, the agent settings,
 * the PATH shims, the zsh integration) and expects to stay on disk.
 *
 * They live in the temp folder, which is not ours to keep: the OS sweeps files
 * it has not seen used for a few days, and anything may empty the folder. They
 * used to be written once per run and the path remembered - an app left open
 * for days then launched every new session against a file that was gone
 * (`Error: Settings file not found: …/double0-claude-status-hooks.json`,
 * 2026-10-12). So the remembered path is only trusted while every file behind
 * it still exists; otherwise they are written again.
 */
import { existsSync } from 'node:fs';

/** What a writer produced: the path callers get, and every file it stands on. */
export type Written = { path: string; files: readonly string[] };

/**
 * `write` behind a check: the returned getter answers the written path, writing
 * (again) whenever a file is missing. Null when the write throws - retried on
 * the next call.
 */
export function keptFiles(
  write: () => Written,
  exists: (path: string) => boolean = existsSync,
): () => string | null {
  let kept: Written | null = null;
  return () => {
    if (kept && kept.files.every((file) => exists(file))) return kept.path;
    try {
      kept = write();
    } catch {
      kept = null;
    }
    return kept?.path ?? null;
  };
}
