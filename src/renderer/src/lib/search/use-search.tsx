import { useEffect, useMemo, useState } from 'react';
import fuzzysort from 'fuzzysort';
import type { FileIndex, SearchCandidate, SearchGroup, SearchItem, SearchKind } from './types';

const GROUP_ORDER: SearchKind[] = ['file', 'project', 'session', 'command', 'setting', 'action'];
const HEADINGS: Record<SearchKind, string> = {
  file: 'Files',
  project: 'Projects',
  session: 'Sessions',
  command: 'Commands',
  setting: 'Settings',
  action: 'Actions',
};

/**
 * Load the cross-project file index when the palette opens. Cheap on repeat -
 * main TTL-caches the disk walk - and the last list stays visible while
 * refetching, so reopening never flashes empty. A remote host's part lands
 * later (plan 29 › M5): main pushes `search:indexChanged` and the list is
 * asked again while the palette is open.
 */
const EMPTY_INDEX: FileIndex = { files: [], pending: [], unreachable: [] };

export function useFileIndex(open: boolean): FileIndex {
  const [index, setIndex] = useState<FileIndex>(EMPTY_INDEX);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let seq = 0;
    const load = (): void => {
      const mine = ++seq;
      void window.api?.search
        ?.listFiles()
        .then((res) => {
          if (cancelled || mine !== seq || !res?.files) return;
          setIndex({
            files: res.files,
            pending: res.pending ?? [],
            unreachable: res.unreachable ?? [],
          });
        })
        .catch(() => {});
    };
    load();
    const off = window.api?.search?.onIndexChanged?.(load);
    return () => {
      cancelled = true;
      off?.();
    };
  }, [open]);
  return index;
}

/**
 * Rank candidates with fuzzysort, ranked PER KIND so a flood of file matches
 * can't crowd projects/sessions/actions out of the "All" view. With a query,
 * groups float by their best match; an active tab narrows to its kinds and shows
 * a longer list. Empty query yields a browseable default (files excluded unless
 * the Files tab is focused - the index is far too large to list raw).
 */
export function useSearchResults(
  query: string,
  scopeKinds: SearchKind[] | null,
  candidatesByKind: Record<SearchKind, SearchCandidate[]>,
): SearchGroup[] {
  return useMemo(() => {
    const q = query.trim();
    const perGroup = scopeKinds ? 50 : 6;
    const filesFocused = scopeKinds?.length === 1 && scopeKinds[0] === 'file';

    const groups: SearchGroup[] = [];
    for (const kind of GROUP_ORDER) {
      if (scopeKinds && !scopeKinds.includes(kind)) continue;
      const pool = candidatesByKind[kind] ?? [];
      if (pool.length === 0) continue;

      let items: SearchItem[];
      if (!q) {
        if (kind === 'file' && !filesFocused) continue;
        items = pool.slice(0, perGroup).map((c) => ({ ...c, titleNodes: c.title, score: 1 }));
      } else {
        // threshold 0: every match, ranked - fuzzysort 4 drops scores under .5
        // by default, which hid loose matches the list showed before.
        const results = fuzzysort.go(q, pool, { key: 'title', limit: perGroup, threshold: 0 });
        if (results.length === 0) continue;
        items = results.map((r) => ({
          ...r.obj,
          titleNodes: r.highlight((m, i) => (
            <mark key={i} className="bg-transparent font-semibold text-inherit">
              {m}
            </mark>
          )),
          score: r.score,
        }));
      }
      if (items.length > 0) groups.push({ kind, heading: HEADINGS[kind], items });
    }

    if (q) groups.sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0));
    return groups;
  }, [query, scopeKinds, candidatesByKind]);
}
