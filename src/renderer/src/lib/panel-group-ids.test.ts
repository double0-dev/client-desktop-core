import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A react-resizable-panels `<Group>` must never get a fixed `id`. Since v4 the
 * library keeps every mounted group in one document-wide table keyed by that
 * id, and the workspace keeps several session views mounted at once (hidden),
 * each with its own copy of every screen. Two groups sharing an id read each
 * other's layout, and the whole window died on "No layout data found for
 * index 0" the moment a second copy mounted (2026-11-12, right after the v2 ->
 * v4 upgrade turned `autoSaveId="…"` into `id="…"`). A layout worth
 * remembering goes through `useDefaultLayout({ id, panelIds })` - its `id` is
 * only a storage key - and the group itself gets no id, or one unique per
 * instance (a layout node's uuid).
 */

const REPO = resolve(__dirname, '../../../..');
const ROOTS = ['src/renderer', 'the official build'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(path);
  }
  return out;
}

/** `<Group … id="x" …>` or `id={'x'}` / `id={"x"}` / an expression-free template. */
const FIXED_GROUP_ID = /<Group\b[^>]*?\sid=(?:["']|\{\s*["']|\{\s*`[^`$]*`\s*\})/;

describe('resizable panel groups', () => {
  it('never get a fixed id, so a screen mounted twice keeps its own layout', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      // The public tree has no pro/.
      if (!existsSync(join(REPO, root))) continue;
      for (const file of sourceFiles(join(REPO, root))) {
        if (FIXED_GROUP_ID.test(readFileSync(file, 'utf8'))) {
          offenders.push(relative(REPO, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard matches the shapes it is meant to catch', () => {
    expect(FIXED_GROUP_ID.test('<Group orientation="horizontal" id="content">')).toBe(true);
    expect(FIXED_GROUP_ID.test("<Group\n  id={'content'}\n>")).toBe(true);
    expect(FIXED_GROUP_ID.test('<Group id={`content`}>')).toBe(true);
    expect(FIXED_GROUP_ID.test('<Group id={node.id} orientation="vertical">')).toBe(false);
    expect(FIXED_GROUP_ID.test('<Group orientation="vertical" className="x">')).toBe(false);
  });
});
