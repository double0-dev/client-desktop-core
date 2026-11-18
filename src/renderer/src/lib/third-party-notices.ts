import type { NoticesDocument } from '../../../main/third-party-notices';

/**
 * Settings › General › Open-source licences (third-party-notices-dialog.tsx):
 * the pure part - which packages a search shows. The notices themselves are
 * written by the build (scripts/third-party-notices.mjs) and read through
 * `window.api.notices`.
 */

export type NoticePackage = NoticesDocument['packages'][number];

/** Packages whose name or licence contains every word of the query, in the document's order. */
export function filterNotices(packages: readonly NoticePackage[], query: string): NoticePackage[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...packages];
  return packages.filter((p) => {
    const hay = `${p.name} ${p.license ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The key a package is selected by: two versions of one package are two rows. */
export const noticeKey = (p: NoticePackage): string => `${p.name}@${p.version}`;
