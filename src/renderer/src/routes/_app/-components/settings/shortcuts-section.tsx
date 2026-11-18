import { useEffect, useState } from 'react';
import { isAppLocked } from '@renderer/lib/app-lock';
import { RotateCcw, Search } from 'lucide-react';
import { Kbd } from '@renderer/components/ui/kbd';
import {
  commands as allCommands,
  isCommandListed,
  comboEquals,
  comboTokens,
  eventToCombo,
  findConflict,
  getDefaultCombo,
  getKeymap,
  isMac,
  isValidCombo,
  resetBinding,
  setBinding,
  setCapturing,
  unbind,
  useKeymap,
  type CommandDef,
  type CommandId,
  type ShortcutCombo,
} from '@renderer/lib/settings/keyboard-shortcuts';
import { cn } from '@renderer/lib/utils';

/**
 * Settings → Keyboard shortcuts (design: `Screen/Settings - Keyboard Shortcuts`,
 * node `U9uZnI`): a searchable list of workspace commands, each row showing its
 * key combo as Kbd chips. Click a row to rebind - the next chord is captured;
 * Esc cancels, Backspace/Delete unbinds, and a combo already in use is reassigned
 * off its previous owner. The wiring that runs these lives in `workspace-shortcuts.tsx`.
 */
export function ShortcutsSettingsSection() {
  const keymap = useKeymap();
  const [query, setQuery] = useState('');
  const [capturingId, setCapturingId] = useState<CommandId | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Capture the next chord while a row is in edit mode. Listens on `window`
  // (capture phase) so it sees the combo first - and so Escape cancels the
  // capture instead of closing the Settings dialog. The module `capturing` flag
  // keeps the global workspace handler from firing as the user presses keys.
  useEffect(() => {
    if (!capturingId) return;
    setCapturing(true);
    setNote(null);
    const onKey = (e: KeyboardEvent): void => {
      // A cover over the window (lib/app-lock.ts) owns the keyboard: keys meant
      // for it must neither be swallowed here nor rebind a command unseen.
      if (isAppLocked()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setCapturingId(null);
        return;
      }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        unbind(capturingId);
        setCapturingId(null);
        return;
      }
      const combo = eventToCombo(e);
      if (!combo) return; // a modifier on its own - keep waiting for the full chord
      if (!isValidCombo(combo)) {
        setNote(`Add ${isMac ? '⌘' : 'Ctrl'} or another modifier`);
        return;
      }
      const conflict = findConflict(getKeymap(), combo, capturingId);
      if (conflict) unbind(conflict); // reassign: a combo belongs to one command
      setBinding(capturingId, combo);
      setCapturingId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      setCapturing(false);
    };
  }, [capturingId]);

  const q = query.trim().toLowerCase();
  const rows = allCommands().filter((c) => isCommandListed(c) && c.label.toLowerCase().includes(q));
  // App-wide keys (Settings, the palette) read as workspace commands to a user.
  const workspaceRows = rows.filter((c) => c.group === undefined || c.group === 'app');
  const editorRows = rows.filter((c) => c.group === 'editor');
  const terminalRows = rows.filter((c) => c.group === 'terminal');
  const shortcutRow = (def: CommandDef, i: number): React.ReactNode => (
    <ShortcutRow
      key={def.id}
      label={def.label}
      combo={keymap[def.id]}
      overridden={!comboEquals(keymap[def.id], getDefaultCombo(def.id))}
      zebra={i % 2 === 0}
      capturing={capturingId === def.id}
      note={capturingId === def.id ? note : null}
      onStart={() => setCapturingId(def.id)}
      onReset={() => resetBinding(def.id)}
    />
  );

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
          COMMAND
        </span>
        <div className="flex w-60 items-center gap-2 rounded-md border border-border bg-input px-2.5 py-[7px]">
          <Search className="size-3.5 shrink-0 text-foreground-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[length:calc(13px*var(--ui-font-scale,1))] text-foreground outline-none placeholder:text-foreground-muted"
          />
        </div>
      </div>

      <div className="flex flex-col">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-foreground-subtle">
            No commands match “{query}”.
          </p>
        ) : (
          <>
            {workspaceRows.map(shortcutRow)}
            {editorRows.length > 0 && (
              <span className="px-3 pb-1.5 pt-4 text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
                EDITOR
              </span>
            )}
            {editorRows.map(shortcutRow)}
            {terminalRows.length > 0 && (
              <span className="px-3 pb-1.5 pt-4 text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
                TERMINAL
              </span>
            )}
            {terminalRows.map(shortcutRow)}
          </>
        )}
      </div>
    </div>
  );
}

function ShortcutRow({
  label,
  combo,
  overridden,
  zebra,
  capturing,
  note,
  onStart,
  onReset,
}: {
  label: string;
  combo: ShortcutCombo | null;
  overridden: boolean;
  zebra: boolean;
  capturing: boolean;
  note: string | null;
  onStart: () => void;
  onReset: () => void;
}) {
  const tokens = comboTokens(combo);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onStart}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onStart();
        }
      }}
      className={cn(
        'group flex h-10 cursor-pointer items-center gap-3 rounded-md px-3 outline-none transition-colors',
        capturing
          ? 'bg-primary/[0.06] ring-1 ring-primary'
          : zebra
            ? 'bg-muted/40 hover:bg-muted'
            : 'hover:bg-muted/60',
      )}
    >
      <span className="min-w-0 flex-1 truncate text-[length:calc(13px*var(--ui-font-scale,1))] text-foreground">
        {label}
      </span>
      {overridden && !capturing && (
        <button
          type="button"
          aria-label="Reset to default"
          title="Reset to default"
          onClick={(e) => {
            e.stopPropagation();
            onReset();
          }}
          className="hidden size-5 shrink-0 items-center justify-center rounded text-foreground-muted transition-colors hover:bg-muted hover:text-foreground group-hover:flex"
        >
          <RotateCcw className="size-3" />
        </button>
      )}
      {capturing ? (
        <span className="shrink-0 text-[length:calc(11px*var(--ui-font-scale,1))] font-medium text-primary">
          {note ?? 'Press keys… (Esc to cancel)'}
        </span>
      ) : tokens.length > 0 ? (
        <div className="flex shrink-0 items-center gap-1">
          {tokens.map((t, i) => (
            <Kbd key={i}>{t}</Kbd>
          ))}
        </div>
      ) : (
        <span className="shrink-0 text-[length:calc(13px*var(--ui-font-scale,1))] text-foreground-subtle">
          -
        </span>
      )}
    </div>
  );
}
