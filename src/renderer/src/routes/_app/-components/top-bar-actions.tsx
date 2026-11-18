import { useState } from 'react';
import { Moon, Settings, Sun } from 'lucide-react';

import { SettingsDialog } from '@renderer/routes/_app/-components/settings/settings-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useTheme } from '@renderer/lib/settings/theme';
import { rendererExtension } from '@renderer/lib/extension/registry';

/** No update UI: never an update pending. */
const noUpdates = (): boolean => false;

/**
 * Top-bar actions cluster from the design (`TopBar/Actions`): a light/dark theme
 * toggle and a settings button that opens the Settings dialog.
 */
export function TopBarActions() {
  const { theme, toggleTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ThemeIcon = theme === 'dark' ? Moon : Sun;
  // A newer build is available / downloading / downloaded: the quiet reminder
  // that outlives a dismissed banner (design `TopBar/Actions` → `dot`).
  // The extension's, if any. The registry is fixed after boot, so the same
  // hook runs on every render.
  const usePending = rendererExtension().updates?.usePending ?? noUpdates;
  const updatePending = usePending();

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        title="Toggle theme"
        className="flex size-[30px] items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
      >
        <ThemeIcon className="size-[15px]" />
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
            className="relative flex size-[30px] items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
          >
            <Settings className="size-[15px]" />
            {updatePending && (
              <span
                data-testid="update-dot"
                aria-hidden
                className="absolute right-[4px] top-[5px] size-[7px] rounded-full bg-primary ring-[1.5px] ring-surface"
              />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {updatePending ? 'Settings · update available' : 'Settings'}
        </TooltipContent>
      </Tooltip>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
