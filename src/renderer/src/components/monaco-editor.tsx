import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Undo2 } from 'lucide-react';
import type * as monacoNs from 'monaco-editor';

import { resolveEditorFontCss, useEditorSettings } from '@renderer/lib/settings/editor-settings';
import {
  getKeymap,
  isCapturing,
  matchCombo,
  type CommandId,
} from '@renderer/lib/settings/keyboard-shortcuts';
import {
  createGitGutter,
  type GitGutter,
  type GitGutterBase,
  type GitGutterMarkClick,
} from '@renderer/lib/monaco/monaco-git-gutter';
import { cn } from '@renderer/lib/utils';
import { currentHostOfPath } from '@renderer/lib/hosts/host-of-path';
import { uriOf } from '@renderer/lib/remote-uri';
import { canUseLanguageServer } from '@renderer/lib/session/remote-capabilities';
import { useHostStatus } from '@renderer/lib/hosts/host-status';
import { isSurfaceFocusHeld } from '@renderer/lib/workspace/focus-regions';

/**
 * Thin React host for a Monaco editor. The heavy monaco-vscode stack loads
 * through a dynamic import on first mount (initMonaco is idempotent), so the
 * editor bundle stays out of the app chunk. One model per file, addressed by a
 * real `file://` URI - language detection and (later) LSP attachment key off
 * it. Content ownership stays with the parent: it seeds `initialText`, hears
 * every edit via `onContentChange`, and pushes external changes (disk reloads)
 * through the imperative handle - replaceText preserves the undo stack, which
 * `setValue` would clear.
 *
 * All returned/reported text is LF-normalized (matching what CodeMirror did),
 * so the parent's saved-vs-live dirty comparison never trips over EOLs.
 */

/**
 * Shared body-level host for Monaco's overflowing widgets (suggest, hover,
 * signature help). With `fixedOverflowWidgets` the widgets are positioned in
 * viewport coordinates - but the editor layer places editors with a CSS
 * transform, which re-bases `position: fixed` descendants and threw the
 * widgets to the screen edge. A host outside any transformed ancestor keeps
 * them glued to the cursor. The `monaco-editor` class is required for the
 * widgets' styles to apply.
 */
let overflowWidgetsHost: HTMLElement | null = null;
function getOverflowWidgetsHost(): HTMLElement {
  if (!overflowWidgetsHost) {
    overflowWidgetsHost = document.createElement('div');
    overflowWidgetsHost.className = 'monaco-editor';
    overflowWidgetsHost.style.position = 'fixed';
    overflowWidgetsHost.style.top = '0';
    overflowWidgetsHost.style.left = '0';
    overflowWidgetsHost.style.zIndex = '100';
    document.body.appendChild(overflowWidgetsHost);
  }
  return overflowWidgetsHost;
}

export type MonacoEditorHandle = {
  /** Current document text (LF), or null before the editor is live. */
  getValue(): string | null;
  /** Replace the whole document preserving undo; returns the LF text as the
   * model now holds it, or null before ready. */
  replaceText(text: string): string | null;
  focus(): void;
  /** Feed the git gutter its diff base (no-op before ready). */
  setGitBase(base: GitGutterBase): void;
  /** The live model - Phase 2 attaches language clients to it. */
  getModel(): monacoNs.editor.ITextModel | null;
  /** Put the caret at a 1-based line / column (clamped to the document),
   * scroll it to the middle and focus the editor. No-op before ready. */
  revealPosition(line: number, column?: number): void;
};

export const MonacoEditorView = forwardRef<
  MonacoEditorHandle,
  {
    filePath: string;
    /**
     * The host of a file outside every project root there (plan 29 › M9) -
     * null / absent: the machine follows from the path.
     */
    hostId?: string | null;
    /** Text the editor is created with. Later external changes must go
     * through `replaceText` - this prop is only read until the editor is live. */
    initialText: string;
    readOnly: boolean;
    /** Focus + relayout when this editor's tab becomes the active one. */
    active: boolean;
    /** Project/worktree root for language-server support; null disables LSP
     * (detached windows without a project context degrade gracefully). */
    lspRoot?: string | null;
    className?: string;
    onContentChange: (value: string) => void;
    onSave: () => void;
    /** Fired once the editor is live, with the normalized document text. */
    onReady: (normalizedText: string) => void;
  }
>(function MonacoEditorView(
  {
    filePath,
    hostId: foreignHost = null,
    initialText,
    readOnly,
    active,
    lspRoot,
    className,
    onContentChange,
    onSave,
    onReady,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The machine the file is on (null = this computer).
  const machine = foreignHost ?? currentHostOfPath(filePath);
  const machineCaps = useHostStatus(machine)?.caps;
  const lspAllowed = canUseLanguageServer(machine, machineCaps);
  const machineRef = useRef(machine);
  machineRef.current = machine;
  const [mon, setMon] = useState<typeof monacoNs | null>(null);
  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null);
  const gutterRef = useRef<GitGutter | null>(null);
  const [ready, setReady] = useState(false);
  // A clicked git-gutter mark (design: workspace editor's revert popover).
  const [revertTarget, setRevertTarget] = useState<GitGutterMarkClick | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Latest-value refs so the one-shot create effect and Monaco callbacks never
  // capture stale props.
  const initialTextRef = useRef(initialText);
  initialTextRef.current = initialText;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const settings = useEditorSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const monacoModRef = useRef<typeof import('@renderer/lib/monaco/monaco') | null>(null);
  useEffect(() => {
    let live = true;
    void import('@renderer/lib/monaco/monaco')
      .then(async (m) => {
        const ns = await m.initMonaco();
        if (live) {
          monacoModRef.current = m;
          setMon(ns);
        }
      })
      .catch((err) => {
        console.error('Monaco failed to initialize', err);
      });
    return () => {
      live = false;
    };
  }, []);

  // Create the editor once the stack is up. The component is keyed by
  // filePath (file-editor.tsx), so a path retarget is a clean remount.
  useEffect(() => {
    const container = containerRef.current;
    if (!mon || !container) return;

    // A file on a remote host carries the host as the URI authority, so the
    // same path on two machines is two models (lib/remote-uri.ts).
    const uri = uriOf(mon.Uri, machineRef.current, filePath);
    // getModel guard: StrictMode double-mounts run this effect twice.
    const model =
      mon.editor.getModel(uri) ?? mon.editor.createModel(initialTextRef.current, undefined, uri);
    // Back the URI with the live model so VS Code's file service can resolve
    // it (editor tracking would otherwise error on the unknown file).
    const overlay = monacoModRef.current?.registerEditorFile(uri, () => model.getValue());

    const s = settingsRef.current;
    const editor = mon.editor.create(container, {
      model,
      readOnly: readOnlyRef.current,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      padding: { top: 8, bottom: 8 },
      // Hover/suggest widgets must escape the pane wrapper's overflow-hidden -
      // rendered into the shared body-level host (see getOverflowWidgetsHost).
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: getOverflowWidgetsHost(),
      lineDecorationsWidth: 10,
      lineNumbersMinChars: 3,
      stickyScroll: { enabled: false },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      fontFamily: resolveEditorFontCss(s),
      fontSize: s.fontSize,
      // Values < 8 are a multiplier of fontSize - exactly our settings model.
      lineHeight: s.lineHeight,
    });
    editorRef.current = editor;

    const lf = mon.editor.EndOfLinePreference.LF;
    const contentSub = model.onDidChangeContent(() => {
      setRevertTarget(null);
      onContentChangeRef.current(model.getValue(lf));
    });

    // Editor-group shortcuts (Settings → Keyboard shortcuts), resolved against
    // the live keymap. Capture phase so rebindings win over Monaco's own
    // keybinding service and the browser defaults. When a binding matches a
    // Monaco default the same action runs either way; a REBOUND combo adds the
    // new key - Monaco's stock keybinding for that action stays live too.
    const EDITOR_ACTIONS: [CommandId, string][] = [
      ['editor-format', 'editor.action.formatDocument'],
      ['editor-go-to-definition', 'editor.action.revealDefinition'],
      ['editor-find-references', 'editor.action.goToReferences'],
      ['editor-rename', 'editor.action.rename'],
      ['editor-quick-fix', 'editor.action.quickFix'],
      ['editor-toggle-comment', 'editor.action.commentLine'],
      ['editor-go-to-line', 'editor.action.gotoLine'],
      ['editor-move-line-up', 'editor.action.moveLinesUpAction'],
      ['editor-move-line-down', 'editor.action.moveLinesDownAction'],
      ['editor-duplicate-line', 'editor.action.copyLinesDownAction'],
    ];
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isCapturing()) return;
      const keymap = getKeymap();
      if (matchCombo(e, keymap['editor-save'])) {
        e.preventDefault();
        e.stopPropagation();
        onSaveRef.current();
        return;
      }
      for (const [commandId, actionId] of EDITOR_ACTIONS) {
        if (matchCombo(e, keymap[commandId])) {
          e.preventDefault();
          e.stopPropagation();
          void editor.getAction(actionId)?.run();
          return;
        }
      }
    };
    container.addEventListener('keydown', onKeyDown, true);

    gutterRef.current = createGitGutter(mon, editor, {
      onMarkClick: (click) => {
        if (!readOnlyRef.current) setRevertTarget(click);
      },
    });

    setReady(true);
    onReadyRef.current(model.getValue(lf));

    return () => {
      setReady(false);
      container.removeEventListener('keydown', onKeyDown, true);
      gutterRef.current?.dispose();
      gutterRef.current = null;
      contentSub.dispose();
      overlay?.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
  }, [mon, filePath]);

  // Font settings apply live; the color theme is global (monaco-theme.ts).
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: resolveEditorFontCss(settings),
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
    });
  }, [settings, ready]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly, ready]);

  // Language-server attachment for this model, scoped to the project root.
  // The manager refcounts per (machine, language, root) - mounting the second
  // .py tab reuses the running pyright rather than spawning another. A host's
  // file gets the host's server (run there, plan 29 › M9) only while its
  // daemon announces `lsp`; an older runtime keeps highlighting alone.
  useEffect(() => {
    if (!ready || !lspRoot || !lspAllowed) return;
    const model = editorRef.current?.getModel();
    const mod = monacoModRef.current;
    if (!model || !mod) return;
    return mod.attachLanguageClient(model, lspRoot, machine);
  }, [ready, lspRoot, filePath, lspAllowed, machine]);

  // Dismiss the revert popover on outside pointerdown or Escape.
  useEffect(() => {
    if (!revertTarget) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setRevertTarget(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setRevertTarget(null);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [revertTarget]);

  // When this becomes the active tab (display:none → block), remeasure (it may
  // have been 0×0 while hidden) and move the caret in. automaticLayout's
  // ResizeObserver covers most cases; the explicit layout() is the belt for
  // show-and-resize landing in the same frame.
  useEffect(() => {
    if (!active || !ready) return;
    const raf = requestAnimationFrame(() => {
      editorRef.current?.layout();
      // Not while a sidebar region is being keyboard-navigated (the tab was
      // picked with ↑/↓ there) - see lib/workspace/focus-regions.ts.
      if (!isSurfaceFocusHeld()) editorRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, ready]);

  useImperativeHandle(
    ref,
    (): MonacoEditorHandle => ({
      getValue() {
        const model = editorRef.current?.getModel();
        return model && mon ? model.getValue(mon.editor.EndOfLinePreference.LF) : null;
      },
      replaceText(text) {
        const model = editorRef.current?.getModel();
        if (!model || !mon) return null;
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
        return model.getValue(mon.editor.EndOfLinePreference.LF);
      },
      focus() {
        editorRef.current?.focus();
      },
      setGitBase(base) {
        gutterRef.current?.setBase(base);
      },
      getModel() {
        return editorRef.current?.getModel() ?? null;
      },
      revealPosition(line, column = 1) {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (!editor || !model) return;
        const position = model.validatePosition({ lineNumber: line, column });
        editor.setPosition(position);
        editor.revealPositionInCenter(position);
        editor.focus();
      },
    }),
    [mon],
  );

  const revertLabel = revertTarget
    ? revertTarget.change.type === 'deleted'
      ? `Line ${Math.max(revertTarget.change.afterLine, 1)} · deleted`
      : `${
          revertTarget.change.fromLine === revertTarget.change.toLine
            ? `Line ${revertTarget.change.fromLine}`
            : `Lines ${revertTarget.change.fromLine}–${revertTarget.change.toLine}`
        } · ${revertTarget.change.type}`
    : null;

  return (
    <>
      <div ref={containerRef} className={cn('text-left', className)} />
      {revertTarget &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: 'fixed',
              left: revertTarget.x - 4,
              top: revertTarget.y + 8,
              zIndex: 120,
            }}
            className="flex flex-col gap-0.5 rounded-md border border-border bg-surface p-1 shadow-lg"
          >
            <span className="px-2 pt-0.5 text-[10px] font-semibold tracking-[0.4px] text-foreground-subtle">
              {revertLabel}
            </span>
            <button
              type="button"
              onClick={() => {
                gutterRef.current?.revert(revertTarget.change);
                setRevertTarget(null);
              }}
              className="flex items-center gap-2 rounded-sm px-2 py-1 text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
            >
              <Undo2 className="size-3.5 shrink-0" />
              Revert change
            </button>
          </div>,
          document.body,
        )}
    </>
  );
});
