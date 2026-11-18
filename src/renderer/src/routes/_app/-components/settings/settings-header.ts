import { createContext, useContext, useEffect } from 'react';

/**
 * What the settings dialog shows in its title block. A section normally gets
 * its own label + description from `settings-sections`; a section that opens a
 * sub-screen (Settings → Worktrees → project) swaps in the thing it opened and
 * a way back, the way the design's `Screen/Settings - Worktrees ·
 * production-pipeline` does.
 */
export type SettingsHeader = {
  title: string;
  description: string;
  back?: { label: string; onClick: () => void };
};

/** Set by the dialog; a section calls it with its override, null to clear. */
export const SettingsHeaderContext = createContext<(header: SettingsHeader | null) => void>(
  () => {},
);

/**
 * Show `header` in the dialog's title block while the calling component is
 * mounted. Memoise `header` - every new object re-applies it.
 */
export function useSettingsHeader(header: SettingsHeader | null): void {
  const set = useContext(SettingsHeaderContext);
  useEffect(() => {
    set(header);
    return () => set(null);
  }, [set, header]);
}
