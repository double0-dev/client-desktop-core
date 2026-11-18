import type { IDisposable } from '@xterm/xterm';

/**
 * Decorations for the Ghostty engine, which draws none of its own: boxes laid
 * over its canvas at cell positions (the Inputs flash, find's matches). The
 * canvas paints every cell opaquely, so a box sits ON the text - fills are
 * translucent.
 *
 * A box names its row in buffer coordinates and which buffer they count in:
 * `normal` (a marker - hidden while the alternate screen shows, as xterm hides
 * a normal-buffer decoration there) or `active` (find's matches, counted in
 * whichever buffer they were found in). The layer is laid out again after
 * every frame the engine draws, so boxes follow scrolling and new output.
 */

export type DecorationScope = 'normal' | 'active';

export type DecorationHost = {
  /** The buffer row shown at the top of the view, in `scope`'s coordinates; null = not shown. */
  viewTop(scope: DecorationScope): number | null;
  /** The grid's size in cells. */
  grid(): { cols: number; rows: number };
  cellSize(): { width: number; height: number } | null;
  /** Where the grid starts inside the layer's parent, in CSS pixels. */
  origin(): { left: number; top: number };
};

export type DecorationBox = {
  /** The buffer row of the box's first line, read at every layout (a marker moves). */
  line: () => number;
  col: number;
  /** Cells across and rows down. */
  width: number;
  height: number;
  scope: DecorationScope;
  /** Applied to the element when it is made. */
  style?: Partial<CSSStyleDeclaration>;
  className?: string;
};

type Entry = DecorationBox & {
  element: HTMLElement | null;
  rendered: Set<(element: HTMLElement) => void>;
};

/** xterm's `IDecoration`, the part the app reads. */
export type LayerDecoration = IDisposable & {
  readonly isDisposed: boolean;
  readonly element: HTMLElement | undefined;
  onRender(listener: (element: HTMLElement) => void): IDisposable;
  onDispose(listener: () => void): IDisposable;
};

export class DecorationLayer {
  readonly element: HTMLElement;
  private readonly entries = new Set<Entry>();

  constructor(
    parent: HTMLElement,
    private readonly host: DecorationHost,
  ) {
    const layer = document.createElement('div');
    layer.className = 'ghostty-decorations';
    Object.assign(layer.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: '1',
    } satisfies Partial<CSSStyleDeclaration>);
    parent.appendChild(layer);
    this.element = layer;
  }

  get size(): number {
    return this.entries.size;
  }

  /** `layoutNow: false` for a batch, laid out once with `layout()`. */
  add(box: DecorationBox, layoutNow = true): LayerDecoration {
    const entry: Entry = { ...box, element: null, rendered: new Set() };
    const disposed = new Set<() => void>();
    let isDisposed = false;
    this.entries.add(entry);
    const decoration: LayerDecoration = {
      get isDisposed() {
        return isDisposed;
      },
      get element() {
        return entry.element ?? undefined;
      },
      onRender: (listener) => {
        entry.rendered.add(listener);
        // A box already on screen tells a late listener at once, as xterm's
        // next render would.
        if (entry.element && entry.element.style.display !== 'none') listener(entry.element);
        return { dispose: () => entry.rendered.delete(listener) };
      },
      onDispose: (listener) => {
        disposed.add(listener);
        return { dispose: () => disposed.delete(listener) };
      },
      dispose: () => {
        if (isDisposed) return;
        isDisposed = true;
        this.entries.delete(entry);
        entry.element?.remove();
        entry.element = null;
        for (const listener of [...disposed]) listener();
        disposed.clear();
      },
    };
    if (layoutNow) this.layoutEntry(entry, this.frame());
    return decoration;
  }

  /** Put every box where its row now is (after a frame, a scroll, a resize). */
  layout(): void {
    if (this.entries.size === 0) return;
    const frame = this.frame();
    for (const entry of this.entries) this.layoutEntry(entry, frame);
  }

  dispose(): void {
    this.entries.clear();
    this.element.remove();
  }

  private frame(): {
    cell: { width: number; height: number };
    rows: number;
    tops: Map<DecorationScope, number | null>;
  } | null {
    const cell = this.host.cellSize();
    if (!cell) return null;
    const { left, top } = this.host.origin();
    const { cols, rows } = this.host.grid();
    Object.assign(this.element.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${cols * cell.width}px`,
      height: `${rows * cell.height}px`,
    });
    return {
      cell,
      rows,
      tops: new Map<DecorationScope, number | null>([
        ['normal', this.host.viewTop('normal')],
        ['active', this.host.viewTop('active')],
      ]),
    };
  }

  private layoutEntry(entry: Entry, frame: ReturnType<DecorationLayer['frame']>): void {
    const top = frame?.tops.get(entry.scope);
    const line = entry.line();
    const offset = top == null ? null : line - top;
    const visible =
      frame != null &&
      offset != null &&
      line >= 0 &&
      offset + entry.height > 0 &&
      offset < frame.rows;
    if (!visible) {
      if (entry.element) entry.element.style.display = 'none';
      return;
    }
    let element = entry.element;
    if (!element) {
      element = document.createElement('div');
      if (entry.className) element.className = entry.className;
      Object.assign(element.style, { position: 'absolute', pointerEvents: 'none' }, entry.style);
      this.element.appendChild(element);
      entry.element = element;
    }
    const { width, height } = frame.cell;
    Object.assign(element.style, {
      display: '',
      left: `${entry.col * width}px`,
      top: `${offset * height}px`,
      width: `${entry.width * width}px`,
      height: `${entry.height * height}px`,
    });
    for (const listener of [...entry.rendered]) listener(element);
  }
}

/** `#rrggbb` (or `#rgb`) with an alpha, for a translucent fill; null when unreadable. */
export function translucent(hex: string | undefined, alpha: number): string | null {
  const m = hex?.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
