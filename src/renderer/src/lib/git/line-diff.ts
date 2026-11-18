// Line diff for the editor's git gutter (tested in line-diff.test.ts): base
// (index version) vs the live document → which lines are added/modified, and
// where lines were deleted. Pure and dependency-free. The raw edit script
// (myersOps) also feeds the three-way merge in merge3.ts.

export type GutterChange =
  /** 1-based inclusive line range in the CURRENT document. */
  | { type: 'added' | 'modified'; fromLine: number; toLine: number }
  /** Lines were removed after this CURRENT-document line (0 = before line 1). */
  | { type: 'deleted'; afterLine: number };

export type LineOp = { type: 'eq' | 'del' | 'add'; count: number };

/** Above this many changed lines, fall back to one coarse replace block. */
const MYERS_LIMIT = 5000;
/** Above this many total lines, skip diffing entirely. */
export const LINE_DIFF_MAX_LINES = 100_000;

/**
 * Myers O((N+M)·D) edit script on the (prefix/suffix-trimmed) middle of the two
 * line arrays. Typical edits trim to a small window; a pathological one (huge
 * rewrite) falls back to a single replace run, which the gutter renders as one
 * modified block.
 */
export function myersOps(a: string[], b: string[]): LineOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: LineOp[] = [];
  if (start > 0) ops.push({ type: 'eq', count: start });
  ops.push(...myersCore(a.slice(start, endA), b.slice(start, endB)));
  if (a.length - endA > 0) ops.push({ type: 'eq', count: a.length - endA });
  return ops;
}

function myersCore(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ type: 'add', count: m }];
  if (m === 0) return [{ type: 'del', count: n }];
  if (n + m > MYERS_LIMIT) {
    return [
      { type: 'del', count: n },
      { type: 'add', count: m },
    ];
  }

  // Forward Myers with a saved V per depth for backtracking.
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let depth = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]; // down: insertion
      } else {
        x = v[offset + k - 1] + 1; // right: deletion
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        depth = d;
        break outer;
      }
    }
  }

  // Backtrack from (n, m) through the saved Vs into reversed ops.
  const reversed: LineOp[] = [];
  const push = (type: LineOp['type'], count: number): void => {
    if (count <= 0) return;
    const last = reversed[reversed.length - 1];
    if (last && last.type === type) last.count += count;
    else reversed.push({ type, count });
  };
  let x = n;
  let y = m;
  for (let d = depth; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;
    const snake = down ? x - prevX : x - prevX - 1;
    push('eq', snake);
    push(down ? 'add' : 'del', 1);
    x = prevX;
    y = prevY;
  }
  push('eq', x); // d=0 leading snake
  return reversed.reverse();
}

/** A gutter change plus the base-side line range it replaced - what a revert
 * needs to restore the original lines. `baseFrom` is 1-based; `baseCount` is 0
 * for pure additions. */
export type DetailedGutterChange = GutterChange & { baseFrom: number; baseCount: number };

/**
 * Like `diffGutter`, but each change carries the base-side range it came from
 * (the gutter's click-to-revert uses `base.split('\n').slice(baseFrom - 1,
 * baseFrom - 1 + baseCount)` as the restore text).
 */
export function diffGutterDetailed(base: string, current: string): DetailedGutterChange[] {
  if (base === current) return [];
  const a = base.split('\n');
  const b = current.split('\n');
  if (a.length + b.length > LINE_DIFF_MAX_LINES) return [];

  const ops = myersOps(a, b);
  const changes: DetailedGutterChange[] = [];
  let line = 0; // current-document line just passed
  let baseLine = 0; // base-document line just passed
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'eq') {
      line += op.count;
      baseLine += op.count;
      continue;
    }
    let dels = 0;
    let adds = 0;
    while (i < ops.length && ops[i].type !== 'eq') {
      if (ops[i].type === 'del') dels += ops[i].count;
      else adds += ops[i].count;
      i++;
    }
    i--;
    const baseFrom = baseLine + 1;
    if (adds > 0) {
      changes.push({
        type: dels > 0 ? 'modified' : 'added',
        fromLine: line + 1,
        toLine: line + adds,
        baseFrom,
        baseCount: dels,
      });
      line += adds;
    } else {
      changes.push({ type: 'deleted', afterLine: line, baseFrom, baseCount: dels });
    }
    baseLine += dels;
  }
  return changes;
}

/**
 * Gutter classification: walk the edit script grouping each change run -
 * deletions paired with additions render as `modified`, pure additions as
 * `added`, pure deletions as a `deleted` marker between lines.
 */
export function diffGutter(base: string, current: string): GutterChange[] {
  if (base === current) return [];
  const a = base.split('\n');
  const b = current.split('\n');
  if (a.length + b.length > LINE_DIFF_MAX_LINES) return [];

  const ops = myersOps(a, b);
  const changes: GutterChange[] = [];
  let line = 0; // current-document line just passed (1-based after ++)
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'eq') {
      line += op.count;
      continue;
    }
    // Coalesce one change run (any mix of consecutive del/add ops).
    let dels = 0;
    let adds = 0;
    while (i < ops.length && ops[i].type !== 'eq') {
      if (ops[i].type === 'del') dels += ops[i].count;
      else adds += ops[i].count;
      i++;
    }
    i--;
    if (adds > 0) {
      changes.push({
        type: dels > 0 ? 'modified' : 'added',
        fromLine: line + 1,
        toLine: line + adds,
      });
      line += adds;
    } else {
      changes.push({ type: 'deleted', afterLine: line });
    }
  }
  return changes;
}
