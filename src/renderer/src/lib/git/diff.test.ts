import { describe, expect, it } from 'vitest';
import { foldedBefore, foldedBetween, parseUnifiedDiff, splitRows } from '@renderer/lib/git/diff';

const FILE_HEADER = [
  'diff --git a/src/auth/session.ts b/src/auth/session.ts',
  'index 1234567..89abcde 100644',
  '--- a/src/auth/session.ts',
  '+++ b/src/auth/session.ts',
].join('\n');

const HUNK_1 = [
  '@@ -24,7 +24,9 @@ async function refreshSession() {',
  '   const session = await store.get(sid);',
  '   if (!session) return null;',
  '-  if (session.expiresAt < Date.now()) {',
  '-    await store.delete(sid);',
  '+  const deadline = session.expiresAt + skewMs;',
  '+  if (deadline < Date.now()) {',
  '+    await store.delete(sid);',
  '+    metrics.count();',
  '     return null;',
  '   }',
  '   return session;',
].join('\n');

const HUNK_2 = [
  '@@ -58,2 +61,2 @@ persistSession()',
  '-  log.debug();',
  '+  log.debug({ sid });',
  '   return session;',
].join('\n');

const SAMPLE = `${FILE_HEADER}\n${HUNK_1}\n${HUNK_2}\n`;

describe('parseUnifiedDiff', () => {
  it('parses hunks, headers and totals', () => {
    const diff = parseUnifiedDiff(SAMPLE);
    expect(diff.binary).toBe(false);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.adds).toBe(5);
    expect(diff.dels).toBe(3);

    const [h1, h2] = diff.hunks;
    expect(h1.header).toBe('@@ -24,7 +24,9 @@');
    expect(h1.context).toBe('async function refreshSession() {');
    expect(h1.oldStart).toBe(24);
    expect(h1.oldCount).toBe(7);
    expect(h1.newStart).toBe(24);
    expect(h1.newCount).toBe(9);
    expect(h2.oldStart).toBe(58);
    expect(h2.newStart).toBe(61);
  });

  it('numbers lines per side', () => {
    const [h1] = parseUnifiedDiff(SAMPLE).hunks;
    expect(h1.lines[0]).toMatchObject({ kind: 'context', oldNo: 24, newNo: 24 });
    expect(h1.lines[2]).toMatchObject({ kind: 'del', oldNo: 26, newNo: null });
    expect(h1.lines[4]).toMatchObject({ kind: 'add', oldNo: null, newNo: 26 });
    // After 2 dels (old 26-27) and 4 adds (new 26-29), context resumes aligned.
    expect(h1.lines[8]).toMatchObject({ kind: 'context', oldNo: 28, newNo: 30 });
  });

  it('rebuilds an apply-able per-hunk patch verbatim', () => {
    const [h1, h2] = parseUnifiedDiff(SAMPLE).hunks;
    expect(h1.patch).toBe(`${FILE_HEADER}\n${HUNK_1}\n`);
    expect(h2.patch).toBe(`${FILE_HEADER}\n${HUNK_2}\n`);
  });

  it('keeps the no-newline marker in the patch but out of the lines', () => {
    const text = `${FILE_HEADER}\n@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file\n`;
    const [hunk] = parseUnifiedDiff(text).hunks;
    expect(hunk.lines).toHaveLength(2);
    expect(hunk.patch).toContain('\\ No newline at end of file\n');
  });

  it('parses a new-file (untracked) diff', () => {
    const text = [
      'diff --git a/dev/null b/notes.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/notes.md',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '',
    ].join('\n');
    const diff = parseUnifiedDiff(text);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.adds).toBe(2);
    expect(diff.dels).toBe(0);
    expect(diff.hunks[0].lines.every((l) => l.kind === 'add')).toBe(true);
  });

  it('flags binary diffs and handles empty input', () => {
    expect(parseUnifiedDiff('Binary files a/x.png and b/x.png differ\n').binary).toBe(true);
    expect(parseUnifiedDiff('').hunks).toHaveLength(0);
  });
});

describe('folds', () => {
  it('computes hidden line counts above and between hunks', () => {
    const [h1, h2] = parseUnifiedDiff(SAMPLE).hunks;
    expect(foldedBefore(h1)).toBe(23);
    expect(foldedBetween(h1, h2)).toBe(27); // 58 - (24 + 7)
  });
});

describe('splitRows', () => {
  it('mirrors context and pairs del/add runs with fillers', () => {
    const [h1] = parseUnifiedDiff(SAMPLE).hunks;
    const rows = splitRows(h1);
    // 2 ctx + max(2 dels, 4 adds) + 3 ctx
    expect(rows).toHaveLength(9);
    expect(rows[0].left).toBe(rows[0].right);
    expect(rows[2].left?.kind).toBe('del');
    expect(rows[2].right?.kind).toBe('add');
    // Adds outnumber dels by 2 → two filler cells on the left.
    expect(rows[4].left).toBeNull();
    expect(rows[5].left).toBeNull();
    expect(rows[6].left?.kind).toBe('context');
  });

  it('starts a new run when a deletion follows additions', () => {
    const text = `${FILE_HEADER}\n@@ -1,3 +1,3 @@\n-a\n+b\n-c\n+d\n x\n`;
    const [hunk] = parseUnifiedDiff(text).hunks;
    const rows = splitRows(hunk);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ left: { text: 'a' }, right: { text: 'b' } });
    expect(rows[1]).toMatchObject({ left: { text: 'c' }, right: { text: 'd' } });
  });
});
