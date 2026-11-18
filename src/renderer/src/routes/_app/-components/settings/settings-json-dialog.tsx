import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type * as monacoNs from 'monaco-editor';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { resolveEditorFontCss, useEditorSettings } from '@renderer/lib/settings/editor-settings';
import {
  applyAppSettings,
  collectAppSettings,
  ensureSettingsSectionsLoaded,
  validateAppSettings,
} from '@renderer/lib/settings/settings-transfer';
import { isMac } from '@renderer/lib/settings/keyboard-shortcuts';
import { cn } from '@renderer/lib/utils';

/**
 * Settings → General → "Edit as JSON": every app setting as one editable JSON
 * document in a Monaco buffer (the same editor stack as file tabs - theme,
 * fonts and JSON smarts included). Apply validates first - a parse error or a
 * schema violation is shown (with paths) and nothing changes until it's fixed.
 * Valid settings apply live (theme, terminal/editor themes, workspace chrome).
 *
 * The find bar drives Monaco's `findMatches` + a decorations collection
 * (`m-search-hl*` classes in globals.css) - same UX the CodeMirror version
 * had, now over the shared editor.
 */

function JsonEditor({
  initialText,
  query,
  activeIndex,
  onChange,
  onMatchCount,
}: {
  initialText: string;
  query: string;
  activeIndex: number;
  onChange: (text: string) => void;
  onMatchCount: (count: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monacoNs.editor.IEditorDecorationsCollection | null>(null);
  const [ready, setReady] = useState(false);

  const initialTextRef = useRef(initialText);
  initialTextRef.current = initialText;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onMatchCountRef = useRef(onMatchCount);
  onMatchCountRef.current = onMatchCount;
  const settings = useEditorSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let editor: monacoNs.editor.IStandaloneCodeEditor | null = null;
    let model: monacoNs.editor.ITextModel | null = null;
    let overlay: { dispose(): void } | undefined;
    let contentSub: { dispose(): void } | undefined;

    void import('@renderer/lib/monaco/monaco').then(async (mod) => {
      const mon = await mod.initMonaco();
      if (disposed || !hostRef.current) return;
      const uri = mon.Uri.file('/__app-settings__/settings.json');
      model =
        mon.editor.getModel(uri) ?? mon.editor.createModel(initialTextRef.current, 'json', uri);
      model.setValue(initialTextRef.current);
      overlay = mod.registerEditorFile(uri, () => model?.getValue() ?? '');
      const s = settingsRef.current;
      editor = mon.editor.create(host, {
        model,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        padding: { top: 8, bottom: 8 },
        fontFamily: resolveEditorFontCss(s),
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        lineNumbersMinChars: 3,
        lineDecorationsWidth: 6,
        stickyScroll: { enabled: false },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      });
      editorRef.current = editor;
      decorationsRef.current = editor.createDecorationsCollection();
      contentSub = model.onDidChangeContent(() => {
        if (model) onChangeRef.current(model.getValue());
      });
      setReady(true);
    });

    return () => {
      disposed = true;
      setReady(false);
      contentSub?.dispose();
      overlay?.dispose();
      editor?.dispose();
      model?.dispose();
      editorRef.current = null;
      decorationsRef.current = null;
    };
  }, []);

  // Find: highlight every match, emphasize + reveal the active one.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const decorations = decorationsRef.current;
    if (!ready || !editor || !model || !decorations) return;
    if (!query) {
      decorations.clear();
      onMatchCountRef.current(0);
      return;
    }
    const matches = model.findMatches(query, false, false, false, null, false);
    onMatchCountRef.current(matches.length);
    const active = matches.length ? Math.min(activeIndex, matches.length - 1) : -1;
    decorations.set(
      matches.map((m, i) => ({
        range: m.range,
        options: { inlineClassName: i === active ? 'm-search-hl-active' : 'm-search-hl' },
      })),
    );
    if (active >= 0) editor.revealRangeInCenterIfOutsideViewport(matches[active].range);
  }, [ready, query, activeIndex]);

  return <div ref={hostRef} className="min-h-0 w-full flex-1 overflow-hidden text-left" />;
}

export function SettingsJsonDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [initialText, setInitialText] = useState('');
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Fresh snapshot every time the editor opens - after the extension's
  // sections have been seeded, so the document never opens without them.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void ensureSettingsSectionsLoaded().then(() => {
      if (cancelled) return;
      const snapshot = JSON.stringify(collectAppSettings(), null, 2);
      setInitialText(snapshot);
      setText(snapshot);
      setErrors([]);
      setQuery('');
      setActiveIndex(0);
      setMatchCount(0);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    setActiveIndex(0);
  }, []);

  // Cycle through matches (Enter / arrows / the up-down buttons), wrapping around.
  const step = useCallback(
    (dir: 1 | -1) => {
      if (!matchCount) return;
      setActiveIndex((i) => (i + dir + matchCount) % matchCount);
    },
    [matchCount],
  );

  function apply(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      setErrors([`Not valid JSON: ${err instanceof Error ? err.message : 'parse error'}`]);
      return;
    }
    const result = validateAppSettings(raw);
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    applyAppSettings(result.doc);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
          }
        }}
        className="flex h-[min(700px,88vh)] max-w-[760px] flex-col gap-0 overflow-hidden p-0"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex flex-col gap-0.5">
            <DialogTitle className="text-[length:calc(15px*var(--ui-font-scale,1))] font-semibold">
              Settings as JSON
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              The whole configuration - every settings section, minus tokens and keys. Apply
              validates before anything changes.
            </DialogDescription>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="flex size-7 shrink-0 items-center justify-center rounded text-foreground-muted outline-none transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-5 py-2">
          <Search className="size-4 shrink-0 text-foreground-muted" />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape' && query) {
                e.preventDefault();
                e.stopPropagation();
                onQueryChange('');
              }
            }}
            placeholder={`Search settings…  (${isMac ? '⌘F' : 'Ctrl+F'})`}
            className="min-w-0 flex-1 bg-transparent text-[length:calc(13px*var(--ui-font-scale,1))] text-foreground outline-none placeholder:text-foreground-muted"
          />
          <span className="shrink-0 tabular-nums text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
            {query
              ? matchCount
                ? `${Math.min(activeIndex + 1, matchCount)}/${matchCount}`
                : 'No results'
              : ''}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            {(
              [
                ['prev', ChevronUp, -1],
                ['next', ChevronDown, 1],
              ] as const
            ).map(([label, Icon, dir]) => (
              <button
                key={label}
                type="button"
                aria-label={label === 'prev' ? 'Previous match' : 'Next match'}
                disabled={matchCount === 0}
                onClick={() => step(dir)}
                className={cn(
                  'flex size-6 items-center justify-center rounded text-foreground-muted outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted',
                  matchCount === 0 && 'pointer-events-none opacity-40',
                )}
              >
                <Icon className="size-4" />
              </button>
            ))}
          </div>
        </div>

        {errors.length > 0 && (
          <div className="max-h-32 shrink-0 overflow-y-auto border-b border-destructive/30 bg-destructive/10 px-5 py-2">
            {errors.map((error, i) => (
              <p
                key={i}
                className="break-words font-mono text-[length:calc(11px*var(--ui-font-scale,1))] leading-relaxed text-destructive"
              >
                {error}
              </p>
            ))}
          </div>
        )}

        <JsonEditor
          initialText={initialText}
          query={query}
          activeIndex={activeIndex}
          onChange={(value) => {
            setText(value);
            setErrors((prev) => (prev.length ? [] : prev));
          }}
          onMatchCount={setMatchCount}
        />

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
          <p className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
            Out-of-range values are clamped; unknown theme ids fall back to defaults.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={apply}>
              Apply settings
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
