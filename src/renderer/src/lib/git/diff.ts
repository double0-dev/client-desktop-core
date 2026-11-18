// Unified-diff parsing for the Changes diff view. Pure (tested in
// git-diff.test.ts): raw `git diff` text in → hunks with numbered lines, plus a
// verbatim per-hunk patch (file header + hunk) that `git apply` accepts for
// stage / unstage / discard-hunk.

export type DiffLineKind = 'context' | 'add' | 'del';

export type DiffLine = {
  kind: DiffLineKind;
  /** Line number in the old file (null for added lines). */
  oldNo: number | null;
  /** Line number in the new file (null for deleted lines). */
  newNo: number | null;
  /** Content without the +/-/space marker. */
  text: string;
};

export type DiffHunk = {
  /** The `@@ -a,b +c,d @@` range part of the header. */
  header: string;
  /** The function context git appends after the second `@@`, if any. */
  context: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
  /** File header + raw hunk text, exactly as git printed it - `git apply`-able. */
  patch: string;
};

export type ParsedDiff = {
  hunks: DiffHunk[];
  adds: number;
  dels: number;
  binary: boolean;
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(text: string): ParsedDiff {
  const result: ParsedDiff = { hunks: [], adds: 0, dels: 0, binary: /^Binary files /m.test(text) };
  if (!text) return result;

  const lines = text.split('\n');
  let fileHeader = '';
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      const [, oldStart, oldCount, newStart, newCount, context] = m;
      hunk = {
        header: line.slice(0, line.indexOf('@@', 3) + 2),
        context: (context ?? '').trim(),
        oldStart: Number(oldStart),
        oldCount: oldCount === undefined ? 1 : Number(oldCount),
        newStart: Number(newStart),
        newCount: newCount === undefined ? 1 : Number(newCount),
        lines: [],
        patch: fileHeader + line + '\n',
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      result.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      // Between `diff --git` and the first @@: the file header (also reset on a
      // second file block, which per-path diffs shouldn't produce but cost nothing
      // to handle).
      if (line.startsWith('diff --git ')) fileHeader = '';
      if (line) fileHeader += line + '\n';
      continue;
    }
    // Git prefixes every hunk-body line with a marker (an empty context line is
    // a lone ' '), so a truly empty string is only split()'s trailing artifact.
    if (line === '') continue;
    const marker = line[0];
    if (marker === ' ') {
      hunk.lines.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
      hunk.patch += line + '\n';
    } else if (marker === '+') {
      hunk.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
      hunk.patch += line + '\n';
      result.adds++;
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
      hunk.patch += line + '\n';
      result.dels++;
    } else if (marker === '\\') {
      // "\ No newline at end of file" - invisible in the view, required in the patch.
      hunk.patch += line + '\n';
    } else if (line.startsWith('diff --git ')) {
      // A new file block (defensive) - stop attributing lines to the old hunk.
      hunk = null;
      fileHeader = line + '\n';
    }
  }
  return result;
}

/** Unchanged-line count folded away between two adjacent hunks (0 if contiguous). */
export function foldedBetween(prev: DiffHunk, next: DiffHunk): number {
  return Math.max(0, next.oldStart - (prev.oldStart + prev.oldCount));
}

/** Unchanged-line count folded away above the first hunk. */
export function foldedBefore(first: DiffHunk): number {
  return Math.max(0, first.oldStart - 1);
}

// --- Split (side-by-side) pairing ---------------------------------------------

/** One row of the split view; a null side renders as a filler cell. */
export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

/**
 * Pair a hunk's lines for the side-by-side view: context lines mirror across,
 * and each run of deletions pairs index-wise with the additions that follow it
 * (git always prints the run's `-` lines before its `+` lines), padding the
 * shorter side with fillers.
 */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === 'del') {
      // A new deletion after additions starts a new change run.
      if (adds.length) flush();
      dels.push(line);
    } else if (line.kind === 'add') {
      adds.push(line);
    } else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}
