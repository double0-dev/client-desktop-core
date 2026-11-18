import { Plus, SquareTerminal } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Kbd } from '@renderer/components/ui/kbd';
import { comboTokens, useKeymap } from '@renderer/lib/settings/keyboard-shortcuts';

/**
 * What an empty pane shows once every tab is closed (design: `Screen/Workspace
 * - No Tabs`, node `llFcC`, and `Window/Terminal (Detached) - No Tabs`, node
 * `SuwUy`): the ways to get a terminal back - the live "New tab" binding
 * (rebindable, so read from the keymap, not hardcoded), the tab strip's
 * long-press-"+" template menu, and a "New terminal" button that does what a
 * plain click on that "+" does.
 *
 * It renders inside the geometry layer, which is `pointer-events-none`, so the
 * button re-enables pointer events for itself.
 */
export function PaneEmptyState({ onNewTerminal }: { onNewTerminal: () => void }) {
  const keymap = useKeymap();
  const newTabTokens = comboTokens(keymap['new-tab']);
  return (
    <div className="flex size-full flex-col items-center justify-center gap-6 bg-background">
      <div className="flex flex-col items-center gap-2.5">
        <SquareTerminal className="size-7 text-foreground-subtle" />
        <h2 className="text-sm font-semibold text-foreground">No tabs open</h2>
      </div>
      <div className="flex flex-col items-center gap-2.5 text-xs text-foreground-muted">
        {newTabTokens.length > 0 && (
          <div className="flex items-center gap-2.5">
            <span>New terminal</span>
            <span className="flex items-center gap-1">
              {newTabTokens.map((t, i) => (
                <Kbd key={i}>{t}</Kbd>
              ))}
            </span>
          </div>
        )}
        <div className="flex items-center gap-2.5">
          <span>Long-press</span>
          <Kbd>+</Kbd>
          <span>to choose terminal type</span>
        </div>
      </div>
      <Button size="xs" className="pointer-events-auto has-[>svg]:px-3" onClick={onNewTerminal}>
        <Plus className="size-3.5" />
        New terminal
      </Button>
    </div>
  );
}
