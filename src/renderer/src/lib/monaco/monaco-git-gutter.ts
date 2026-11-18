import type * as monaco from 'monaco-editor';

import { diffGutterDetailed, type DetailedGutterChange } from '@renderer/lib/git/line-diff';

/**
 * Git change gutter for the Monaco file editor: a success bar on
 * added lines, a warning bar on modified ones, a destructive wedge where lines
 * were deleted (classes styled in globals.css). The diff base (the file's
 * INDEX version) arrives asynchronously via `setBase`; the live document is
 * re-diffed against it on every edit, so the marks track unsaved changes too.
 *
 * Marks are clickable (design: `Screen/Workspace - Editor` revert popover):
 * a click in the decorations lane on a changed line reports the change +
 * viewport coordinates through `onMarkClick`; `revert(change)` then restores
 * the base lines for that change as a single undoable edit. Reverting is only
 * offered against a real base - an untracked file's all-added marks have
 * nothing to restore.
 *
 * Hovering the gutter on a change widens its mark (`m-git-hover`, styled in
 * globals.css) for an easier click target. Monaco renders one decoration
 * element per line, so a CSS :hover could only widen the hovered line - the
 * hover is tracked here instead and the class applied to every line of the
 * change, widening the whole bar as one.
 */

export type GitGutterBase =
  /** No repo / binary / error - gutter stays empty. */
  | { kind: 'off' }
  /** Untracked file: every line is new. */
  | { kind: 'new' }
  | { kind: 'content'; text: string };

export type GitGutterMarkClick = {
  change: DetailedGutterChange;
  /** Viewport coordinates of the click (popover anchor). */
  x: number;
  y: number;
};

export type GitGutter = {
  setBase(base: GitGutterBase): void;
  /** Restore the base lines for a change (single undoable edit). */
  revert(change: DetailedGutterChange): void;
  dispose(): void;
};

export function createGitGutter(
  m: typeof monaco,
  editor: monaco.editor.IStandaloneCodeEditor,
  opts?: { onMarkClick?: (click: GitGutterMarkClick) => void },
): GitGutter {
  const collection = editor.createDecorationsCollection();
  let base: GitGutterBase = { kind: 'off' };
  let changes: DetailedGutterChange[] = [];
  let hovered: DetailedGutterChange | null = null;
  let raf = 0;

  const deco = (
    fromLine: number,
    toLine: number,
    cls: string,
  ): monaco.editor.IModelDeltaDecoration => ({
    range: new m.Range(fromLine, 1, toLine, 1),
    options: { isWholeLine: true, linesDecorationsClassName: `m-git-mark ${cls}` },
  });

  const render = (): void => {
    const model = editor.getModel();
    if (!model || base.kind === 'off') {
      collection.clear();
      return;
    }
    const lineCount = model.getLineCount();
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    if (base.kind === 'new') {
      decos.push(deco(1, lineCount, 'm-git-added'));
    } else {
      for (const change of changes) {
        const hover = change === hovered ? ' m-git-hover' : '';
        if (change.type === 'deleted') {
          if (change.afterLine === 0) decos.push(deco(1, 1, `m-git-deleted-above${hover}`));
          else if (change.afterLine <= lineCount)
            decos.push(deco(change.afterLine, change.afterLine, `m-git-deleted-below${hover}`));
          continue;
        }
        const to = Math.min(change.toLine, lineCount);
        decos.push(
          deco(
            change.fromLine,
            to,
            (change.type === 'added' ? 'm-git-added' : 'm-git-modified') + hover,
          ),
        );
      }
    }
    collection.set(decos);
  };

  const compute = (): void => {
    const model = editor.getModel();
    if (!model || base.kind === 'off') {
      changes = [];
    } else if (base.kind === 'new') {
      changes = [];
    } else {
      // Diff against LF-normalized text - the git base is LF, and a CRLF
      // model would otherwise make every line look modified.
      const current = model.getValue(m.editor.EndOfLinePreference.LF);
      changes = diffGutterDetailed(base.text, current);
    }
    // A re-diff replaces the change objects; the stale hover clears with them.
    hovered = null;
    render();
  };

  const changeAt = (line: number): DetailedGutterChange | undefined =>
    changes.find((c) =>
      c.type === 'deleted'
        ? Math.max(c.afterLine, 1) === line
        : c.fromLine <= line && line <= c.toLine,
    );

  // Coalesce keystroke bursts into one recompute per frame.
  const schedule = (): void => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(compute);
  };

  const setHovered = (next: DetailedGutterChange | null): void => {
    if (next === hovered) return;
    hovered = next;
    render();
  };

  const gutterLineAt = (target: monaco.editor.IMouseTarget): number | null => {
    const t = m.editor.MouseTargetType;
    const inGutter =
      target.type === t.GUTTER_GLYPH_MARGIN ||
      target.type === t.GUTTER_LINE_NUMBERS ||
      target.type === t.GUTTER_LINE_DECORATIONS;
    return inGutter ? (target.position?.lineNumber ?? null) : null;
  };

  const subscriptions = [
    editor.onDidChangeModelContent(schedule),
    editor.onDidChangeModel(schedule),
    editor.onMouseMove((e) => {
      const line = gutterLineAt(e.target);
      setHovered(line == null ? null : (changeAt(line) ?? null));
    }),
    editor.onMouseLeave(() => setHovered(null)),
    editor.onMouseDown((e) => {
      if (!opts?.onMarkClick) return;
      if (e.target.type !== m.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      const line = e.target.position?.lineNumber;
      if (!line) return;
      const change = changeAt(line);
      if (!change) return;
      const browserEvent = e.event.browserEvent;
      opts.onMarkClick({ change, x: browserEvent.clientX, y: browserEvent.clientY });
    }),
  ];

  return {
    setBase(next) {
      base = next;
      schedule();
    },
    revert(change) {
      const model = editor.getModel();
      if (!model || base.kind !== 'content') return;
      const baseLines = base.text.split('\n');
      const restore = baseLines.slice(change.baseFrom - 1, change.baseFrom - 1 + change.baseCount);
      let range: monaco.Range;
      let text: string;
      if (change.type === 'deleted') {
        if (change.afterLine === 0) {
          range = new m.Range(1, 1, 1, 1);
          text = `${restore.join('\n')}\n`;
        } else {
          const col = model.getLineMaxColumn(change.afterLine);
          range = new m.Range(change.afterLine, col, change.afterLine, col);
          text = `\n${restore.join('\n')}`;
        }
      } else if (change.type === 'added') {
        const lineCount = model.getLineCount();
        text = '';
        if (change.toLine < lineCount) {
          // Delete the lines including their trailing newline.
          range = new m.Range(change.fromLine, 1, change.toLine + 1, 1);
        } else if (change.fromLine > 1) {
          // Block ends the file: eat the preceding newline instead.
          range = new m.Range(
            change.fromLine - 1,
            model.getLineMaxColumn(change.fromLine - 1),
            change.toLine,
            model.getLineMaxColumn(change.toLine),
          );
        } else {
          range = new m.Range(1, 1, lineCount, model.getLineMaxColumn(lineCount));
        }
      } else {
        range = new m.Range(
          change.fromLine,
          1,
          change.toLine,
          model.getLineMaxColumn(change.toLine),
        );
        text = restore.join('\n');
      }
      model.pushEditOperations([], [{ range, text }], () => null);
    },
    dispose() {
      cancelAnimationFrame(raf);
      for (const s of subscriptions) s.dispose();
      collection.clear();
    },
  };
}
