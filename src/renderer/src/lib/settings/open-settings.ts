import type { SectionId } from '@renderer/routes/_app/-components/settings/settings-sections';

/**
 * Imperative "open Settings → section" from places that don't own a
 * SettingsDialog: the workspace update banner, and main's "you clicked the
 * update notification" push. The app-level Search Everywhere host (mounted on
 * every route) registers as the opener; a request made
 * before it mounts is kept and replayed once it does.
 */

type Opener = (section: SectionId) => void;

let opener: Opener | null = null;
let pending: SectionId | null = null;

export function requestOpenSettings(section: SectionId = 'general'): void {
  if (opener) opener(section);
  else pending = section;
}

/** Register the single opener; returns the unregister. Flushes a queued request. */
export function registerSettingsOpener(fn: Opener): () => void {
  opener = fn;
  if (pending) {
    const section = pending;
    pending = null;
    fn(section);
  }
  return () => {
    if (opener === fn) opener = null;
  };
}
