import { rendererExtension } from '@renderer/lib/extension/registry';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight,
  CornerDownLeft,
  DollarSign,
  History,
  Search,
  Sparkles,
  SquareTerminal,
} from 'lucide-react';
import { Input } from '@renderer/components/ui/input';
import { Kbd } from '@renderer/components/ui/kbd';
import {
  inputReach,
  jumpToInput,
  useTerminalInputs,
  type InputEntry,
  type InputReach,
} from '@renderer/lib/terminal/inputs';
import {
  exitLabel,
  extraLinesLabel,
  filterInputs,
  formatInputTime,
  groupInputSections,
  inputFirstLine,
  inputsCountLabel,
  type InputSectionKind,
} from '@renderer/lib/terminal/inputs-view';
import { useNow } from '@renderer/lib/use-now';
import { cn } from '@renderer/lib/utils';

// Jumps through a tab shown in an extension's view - the view's own; none in
// the core build, where every input is reached in the terminal.
const hasViewJump = (ptyId: string): boolean =>
  rendererExtension().sessionView?.hasJump(ptyId) ?? false;
const viewShowsInput = (ptyId: string, entry: InputEntry, list: InputEntry[]): boolean =>
  rendererExtension().sessionView?.showsInput(ptyId, entry, list) ?? false;
const jumpViewToInput = (ptyId: string, entry: InputEntry, list: InputEntry[]): boolean =>
  rendererExtension().sessionView?.jumpToInput(ptyId, entry, list) ?? false;

/**
 * The status bar's Inputs item and its popover (design `StatusBar/Inputs`,
 * `Popover/Inputs`, `InputRow`; plan a private plan). The item
 * follows the focused tab: every command,
 * agent prompt and line entered there. Picking one scrolls the terminal to
 * it and flashes it - or, for a full-screen Claude Code, walks Claude's own
 * transcript to it. The popover stays open so the next pick is one key
 * away; Esc or a click outside closes it.
 */

// Literal class names (Tailwind only generates what it can read in the source).
const T10 = 'text-[length:calc(10px*var(--ui-font-scale,1))]';
const T11 = 'text-[length:calc(11px*var(--ui-font-scale,1))]';
const T12 = 'text-[length:calc(12px*var(--ui-font-scale,1))]';

const SECTION_ICON: Record<InputSectionKind, typeof Sparkles> = {
  agent: Sparkles,
  shell: SquareTerminal,
  program: SquareTerminal,
};

function SectionHead({
  kind,
  label,
  count,
}: {
  kind: InputSectionKind;
  label: string;
  count: string;
}) {
  const Icon = SECTION_ICON[kind];
  return (
    <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-foreground-subtle">
      <Icon aria-hidden className="size-[11px] shrink-0" />
      <span
        className={cn('min-w-0 truncate font-mono font-medium tracking-[0.06em] uppercase', T10)}
      >
        {label}
      </span>
      <div className="flex-1" />
      <span className={cn('shrink-0 font-mono', T10)}>{count}</span>
    </div>
  );
}

/**
 * Memoized, with handlers that take the entry: a long session lists hundreds
 * of rows, and re-rendering every one on each hover or pick made the list lag.
 */
const InputRow = memo(function InputRow({
  entry,
  reach,
  selected,
  now,
  onPick,
  onHover,
}: {
  entry: InputEntry;
  reach: InputReach;
  selected: boolean;
  now: number;
  onPick: (entry: InputEntry) => void;
  onHover: (seq: number) => void;
}) {
  const out = reach === 'out';
  const extra = extraLinesLabel(entry);
  const exit = exitLabel(entry);
  const Lead = entry.kind === 'command' ? DollarSign : ChevronRight;
  const text = inputFirstLine(entry.text);
  return (
    <button
      type="button"
      role="option"
      data-seq={entry.seq}
      aria-selected={selected}
      aria-disabled={out}
      title={out ? `${entry.text}\n\nNo longer in this terminal` : entry.text}
      onClick={out ? undefined : () => onPick(entry)}
      onMouseMove={out || selected ? undefined : () => onHover(entry.seq)}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-[5px] text-left',
        selected && 'bg-accent',
        out && 'cursor-default',
      )}
    >
      <Lead aria-hidden className="size-3 shrink-0 text-foreground-subtle" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          className={cn(
            'min-w-0 truncate',
            T12,
            entry.kind === 'command' && 'font-mono',
            out ? 'text-foreground-subtle' : 'text-foreground',
          )}
        >
          {text}
        </span>
        {extra && (
          <span className={cn('shrink-0 font-mono text-foreground-subtle', T10)}>{extra}</span>
        )}
      </span>
      {exit && (
        <span className={cn('shrink-0 font-mono font-medium text-destructive', T10)}>{exit}</span>
      )}
      <span
        className={cn(
          'shrink-0 font-mono',
          T10,
          reach === 'screen' ? 'font-medium text-primary' : 'text-foreground-subtle',
        )}
      >
        {reach === 'screen' ? 'on screen' : out ? 'scrolled out' : formatInputTime(entry.at, now)}
      </span>
      {selected && !out && (
        <CornerDownLeft aria-hidden className="size-[11px] shrink-0 text-foreground-muted" />
      )}
    </button>
  );
});

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-[5px]">
      <Kbd>{keys}</Kbd>
      <span>{label}</span>
    </span>
  );
}

function InputsPopover({
  ptyId,
  entries,
  panelRef,
  anchor,
}: {
  ptyId: string;
  entries: InputEntry[];
  panelRef: RefObject<HTMLDivElement | null>;
  anchor: { right: number; bottom: number };
}) {
  const now = useNow();
  const [query, setQuery] = useState('');
  // A tab shown in an extension's view: every prompt the view has is reachable there.
  const reachFor = useCallback(
    (list: InputEntry[]): Map<number, InputReach> => {
      if (!hasViewJump(ptyId)) return inputReach(ptyId, list);
      return new Map(
        list.map((e) => [e.seq, viewShowsInput(ptyId, e, list) ? 'jump' : 'out'] as const),
      );
    },
    [ptyId],
  );
  const [reach, setReach] = useState<Map<number, InputReach>>(() => reachFor(entries));
  // A view that starts (or stops) showing the tab while the list is
  // open changes what is reachable: re-read then.
  useEffect(() => {
    let had = hasViewJump(ptyId);
    const timer = setInterval(() => {
      const has = hasViewJump(ptyId);
      if (has === had) return;
      had = has;
      setReach(reachFor(entries));
    }, 1000);
    return () => clearInterval(timer);
  }, [ptyId, entries, reachFor]);
  const visible = useMemo(() => filterInputs(entries, query), [entries, query]);
  const sections = useMemo(() => groupInputSections(visible), [visible]);
  const reachOf = (seq: number): InputReach => reach.get(seq) ?? 'out';
  const pickable = useMemo(
    () => visible.filter((e) => (reach.get(e.seq) ?? 'out') !== 'out'),
    [visible, reach],
  );
  const [selected, setSelected] = useState<number | null>(() => pickable.at(-1)?.seq ?? null);
  const listRef = useRef<HTMLDivElement>(null);

  // New entries (a command finishing, a prompt sent) move what is reachable.
  useEffect(() => {
    setReach(reachFor(entries));
  }, [reachFor, entries]);

  // Keep a selection that the filter or a new entry left behind.
  useEffect(() => {
    if (selected !== null && pickable.some((e) => e.seq === selected)) return;
    setSelected(pickable.at(-1)?.seq ?? null);
  }, [pickable, selected]);

  // The list reads like the terminal: newest at the bottom, opened at the end.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, []);

  useEffect(() => {
    if (selected === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-seq="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const pick = useCallback(
    (entry: InputEntry) => {
      setSelected(entry.seq);
      if (jumpViewToInput(ptyId, entry, entries)) return;
      void jumpToInput(ptyId, entry).then(() => setReach(reachFor(entries)));
    },
    [ptyId, entries, reachFor],
  );
  const hover = useCallback((seq: number) => setSelected(seq), []);

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    e.preventDefault();
    if (pickable.length === 0) return;
    const at = pickable.findIndex((x) => x.seq === selected);
    if (e.key === 'Enter') {
      if (at !== -1) pick(pickable[at]);
      return;
    }
    const next =
      at === -1
        ? pickable.length - 1
        : Math.max(0, Math.min(pickable.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    setSelected(pickable[next].seq);
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Inputs"
      onKeyDown={onKeyDown}
      style={{
        right: anchor.right,
        bottom: anchor.bottom,
        width: 'calc(360px * var(--ui-font-scale, 1))',
      }}
      className="fixed z-50 flex max-h-[70vh] flex-col overflow-hidden rounded-lg border border-border-strong bg-popover font-sans text-popover-foreground shadow-[0_12px_32px_rgba(0,0,0,0.18)] outline-none"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2.5">
        <History aria-hidden className="size-[13px] text-foreground-muted" />
        <span className={cn('font-semibold text-foreground', T12)}>Inputs</span>
        <div className="flex-1" />
        <span className={cn('font-mono text-foreground-subtle', T10)}>
          {entries.length} in this tab
        </span>
      </div>
      <div className="shrink-0 px-3 pt-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter inputs…"
          aria-label="Filter inputs"
          startIcon={<Search aria-hidden className="size-[13px] shrink-0 text-foreground-muted" />}
          shellClassName="h-7 gap-1.5 px-2.5"
          className={T12}
        />
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Inputs in this tab"
        className="flex min-h-0 flex-col gap-px overflow-y-auto px-1 pt-1.5 pb-2"
      >
        {sections.map((s) => (
          <div key={s.key} className="flex flex-col gap-px">
            <SectionHead kind={s.kind} label={s.label} count={s.count} />
            {s.entries.map((entry) => (
              <InputRow
                key={entry.seq}
                entry={entry}
                reach={reachOf(entry.seq)}
                selected={selected === entry.seq}
                now={now}
                onPick={pick}
                onHover={hover}
              />
            ))}
          </div>
        ))}
        {sections.length === 0 && (
          <p className={cn('px-2 py-3 leading-snug text-foreground-subtle', T11)}>
            {entries.length === 0
              ? // The log is memory-only (shell commands carry secrets) and
                // lives with the shell: one the session daemon kept running
                // across a restart keeps its list, a new shell starts empty
                // even when it resumes a conversation.
                'Commands and prompts you enter in this tab show up here. The list lasts as long as the shell: a new shell starts with an empty one, even when it resumes a conversation.'
              : 'No inputs match.'}
          </p>
        )}
      </div>
      <div
        className={cn(
          'flex shrink-0 items-center gap-3.5 border-t border-border bg-muted px-3 py-[7px] text-foreground-subtle',
          T11,
        )}
      >
        <Hint keys="↑↓" label="select" />
        <Hint keys="enter" label="jump" />
        <Hint keys="esc" label="close" />
      </div>
    </div>
  );
}

export function InputsStatusItem({ focusedPtyId }: { focusedPtyId: string | null }) {
  const entries = useTerminalInputs(focusedPtyId);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    setAnchor({
      right: Math.max(8, window.innerWidth - r.right),
      bottom: window.innerHeight - r.top + 6,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, place]);

  // A different tab took focus (or it closed): the list spoke for the old one.
  useEffect(() => {
    setOpen(false);
  }, [focusedPtyId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  if (!focusedPtyId) return null;

  const label = inputsCountLabel(entries.length);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Inputs: ${label}`}
        title="Inputs in this tab"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-[18px] shrink-0 items-center gap-[5px] rounded-sm px-1.5 hover:bg-muted hover:text-foreground',
          open && 'bg-muted text-foreground',
          entries.length === 0 && !open && 'text-foreground-subtle',
        )}
      >
        <History aria-hidden className="size-[11px]" />
        <span>{label}</span>
      </button>
      {open &&
        anchor &&
        createPortal(
          <InputsPopover
            ptyId={focusedPtyId}
            entries={entries}
            panelRef={panelRef}
            anchor={anchor}
          />,
          document.body,
        )}
    </>
  );
}
