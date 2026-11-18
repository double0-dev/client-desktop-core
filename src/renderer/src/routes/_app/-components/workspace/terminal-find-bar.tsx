import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, CaseSensitive, Regex, Search, WholeWord, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { getPooledTerminal } from '@renderer/lib/terminal/pool';
import {
  closeTerminalFind,
  findCountText,
  findDecorations,
  isValidQuery,
  type FindOptions,
  type FindRequest,
  type FindResults,
} from '@renderer/lib/terminal/find';
import {
  getTerminalSettings,
  resolveTerminalTheme,
} from '@renderer/lib/settings/terminal-settings';
import { getKeymap, isMac, matchCombo } from '@renderer/lib/settings/keyboard-shortcuts';

/** The current accent, read live - the user can recolour it at any time. */
function primaryColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--primary');
}

/**
 * The find bar over a terminal (design: `Terminal/FindBar`, placed top-right of
 * the pane in `Screen/Workspace - Terminal Find`). Searches the terminal's
 * whole buffer with the pool's search addon as you type; ↩ / ⇧↩ (and ⌘G /
 * ⇧⌘G) step through the matches, Esc closes it and hands focus back to the
 * terminal. The query and toggles live only while the bar is open.
 */
export function TerminalFindBar({ ptyId, request }: { ptyId: string; request: FindRequest }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(request.seed);
  const [options, setOptions] = useState<FindOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [results, setResults] = useState<FindResults | null>(null);
  const valid = isValidQuery(query, options);

  // Every open request (⌘F, also on an open bar) puts the caret in the field
  // with its text selected, taking the terminal's selection when there is one.
  useEffect(() => {
    if (request.seed) setQuery(request.seed);
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [request]);

  // The count comes from the addon, which re-counts as output arrives.
  useEffect(() => {
    const search = getPooledTerminal(ptyId)?.search;
    if (!search) return;
    const sub = search.onDidChangeResults((r) =>
      setResults({ index: r.resultIndex, count: r.resultCount }),
    );
    return () => {
      sub.dispose();
      search.clearDecorations();
    };
  }, [ptyId]);

  const searchOptions = (incremental: boolean) => ({
    ...options,
    incremental,
    decorations: findDecorations(
      primaryColor(),
      resolveTerminalTheme(getTerminalSettings()).background ?? '#000000',
    ),
  });

  // Search as you type: incremental, so the current match grows with the query
  // instead of jumping to the next one.
  useEffect(() => {
    const search = getPooledTerminal(ptyId)?.search;
    if (!search) return;
    if (!query || !valid) {
      search.clearDecorations();
      setResults(null);
      return;
    }
    search.findNext(query, searchOptions(true));
    // searchOptions reads the live colours; the query and toggles are the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId, query, options, valid]);

  const step = (backwards: boolean): void => {
    const search = getPooledTerminal(ptyId)?.search;
    if (!search || !query || !valid) return;
    if (backwards) search.findPrevious(query, searchOptions(false));
    else search.findNext(query, searchOptions(false));
  };

  const close = (): void => {
    closeTerminalFind(ptyId);
    getPooledTerminal(ptyId)?.term.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const native = e.nativeEvent;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey);
    } else if (mod && e.code === 'KeyG') {
      e.preventDefault();
      step(e.shiftKey);
    } else if (matchCombo(native, getKeymap()['terminal-find'])) {
      e.preventDefault();
      inputRef.current?.select();
    }
  };

  const count = findCountText(query, valid, results);
  const hasMatches = valid && !!results && results.count > 0;
  const toggle = (key: keyof FindOptions) => () => setOptions((o) => ({ ...o, [key]: !o[key] }));

  return (
    <div
      role="search"
      aria-label="Find in terminal"
      // The pane wrapper refocuses the terminal on pointer-up; a click in the
      // bar must keep the caret here.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      className={cn(
        'absolute right-3 top-2 z-20 flex h-8 items-center gap-0.5 rounded-md border bg-surface-elevated pl-2 pr-1 shadow-sm',
        valid ? 'border-border' : 'border-destructive',
      )}
    >
      <Search className="size-3.5 shrink-0 text-foreground-subtle" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find"
        aria-label="Find"
        aria-invalid={!valid}
        spellCheck={false}
        className="ml-1.5 w-[180px] min-w-0 bg-transparent text-[length:calc(13px*var(--ui-font-scale,1))] text-foreground outline-none placeholder:text-foreground-subtle"
      />
      <FindToggle label="Match case" on={options.caseSensitive} onClick={toggle('caseSensitive')}>
        <CaseSensitive />
      </FindToggle>
      <FindToggle label="Match whole word" on={options.wholeWord} onClick={toggle('wholeWord')}>
        <WholeWord />
      </FindToggle>
      <FindToggle label="Use regular expression" on={options.regex} onClick={toggle('regex')}>
        <Regex />
      </FindToggle>
      <div className="mx-1 h-4 w-px shrink-0 bg-border" />
      <span
        aria-live="polite"
        className={cn(
          'min-w-14 shrink-0 whitespace-nowrap text-right font-mono text-[length:calc(11px*var(--ui-font-scale,1))]',
          count.error ? 'text-destructive' : 'text-foreground-muted',
        )}
      >
        {count.text}
      </span>
      <FindButton label="Previous match" disabled={!hasMatches} onClick={() => step(true)}>
        <ArrowUp />
      </FindButton>
      <FindButton label="Next match" disabled={!hasMatches} onClick={() => step(false)}>
        <ArrowDown />
      </FindButton>
      <FindButton label="Close" onClick={close}>
        <X />
      </FindButton>
    </div>
  );
}

const ICON_BUTTON =
  'flex size-[22px] shrink-0 items-center justify-center rounded-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5';

function FindToggle({
  label,
  on,
  onClick,
  children,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        ICON_BUTTON,
        on
          ? 'bg-primary/15 text-primary'
          : 'text-foreground-muted hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function FindButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        ICON_BUTTON,
        'text-foreground-muted hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      {children}
    </button>
  );
}
