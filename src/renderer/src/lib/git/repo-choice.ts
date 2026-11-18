import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePersistedState } from '@renderer/lib/use-persisted-state';
import { integrationHooks } from '@renderer/lib/integrations';
import type { RepoTool } from '@renderer/lib/extension/types';
import { isWithin, trimSeparators } from '@renderer/lib/path-within';

/**
 * The repo pickers of a folder-of-repos view (a private plan).
 * A project opened on `acme/` - no checkout itself, its stacks `acme/api`,
 * `acme/web` are - has no repo for the git surfaces to show. Instead each
 * tool offers the child checkouts the integrations allow (`useRepoOffered`)
 * and keeps its own pick: the workspace's git pick (`GIT_REPO_TOOL`) aims
 * every git surface (explorer marks, gutters, the status bar branch) at its
 * repo; an extension's tool may keep a pick of its own. Terminals and files
 * keep the view's folder.
 *
 * The git pick lasts only while you stay on the view: selecting a session -
 * another one, or the same one again - goes back to that session's own repo
 * (user decision 2026-09-23). A remembered pick left a session showing the
 * repo you had peeked at last time. Any other tool's picks are remembered per
 * folder, machine-local (absolute paths mean nothing on another machine), in
 * one map key, under `<tool>:<folder>` (a bare-folder key is a git pick from
 * before; it is no longer read).
 */
export const REPO_CHOICE_KEY = 'double0-repo-choice';

/** One checkout directly under the view's folder (mirrors main's ChildRepo). */
export type ChildRepo = { name: string; path: string };

/** Parse the stored folder → repo map; corrupt entries just fall away. */
export function decodeRepoChoice(raw: string | null): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === 'string' && v.length > 0),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

export function encodeRepoChoice(map: Record<string, string>): string {
  return JSON.stringify(map);
}

/**
 * The folder the git tools read, given the view's folder and its child repos:
 * the folder itself when it has no child repos, else the remembered repo - or
 * the first one when nothing is remembered or the remembered one is gone.
 * While the child repos are still being listed: `undefined` (the providers
 * wait rather than report "not a repository" for a beat) for a folder known
 * to hold repos, and the folder itself for every other one - a plain
 * checkout must not start blank on every first visit for a lookup that
 * almost always answers "none".
 */
export function resolveRepoCwd(
  base: string | null | undefined,
  repos: ChildRepo[] | null,
  stored: string | undefined,
  holdsRepos = false,
  preferred?: string,
): string | null | undefined {
  if (base === undefined) return undefined;
  if (base === null) return null;
  if (repos === null) return holdsRepos ? undefined : base;
  if (repos.length === 0) return base;
  return (
    repos.find((r) => r.path === stored)?.path ??
    repos.find((r) => r.path === preferred)?.path ??
    repos[0].path
  );
}

/**
 * The repos a view's picker offers: the project's child repos, with the one
 * the view itself works in pointing at the view's OWN folder - a session
 * rooted in `acme/api/src`, or in a worktree under `acme/api/.worktree/`,
 * lists `api` as that checkout, so picking it goes back to exactly where the
 * session works rather than to the main checkout.
 */
export function offeredRepos(repos: ChildRepo[], base: string): ChildRepo[] {
  return repos.map((repo) =>
    isWithin(base, repo.path) && trimSeparators(base) !== trimSeparators(repo.path)
      ? { ...repo, path: base }
      : repo,
  );
}

export type RepoChoice = {
  /** The child repos on offer; empty when the view's folder is a repo (or none
   * were found) - the picker then stays out of the way. */
  repos: ChildRepo[];
  /** The picked repo's folder, null while there is nothing to pick. */
  selected: string | null;
  select: (path: string) => void;
  /** Re-list the child repos (the picker calls it on open: a stack cloned
   * since shows up without a restart). */
  reload: () => void;
};

export const NO_REPO_CHOICE: RepoChoice = {
  repos: [],
  selected: null,
  select: () => {},
  reload: () => {},
};

/** The workspace's own pick: the repo every git surface reads. */
export const GIT_REPO_TOOL = 'git';

/** Each tool's choice for the view (an extension's tool adds its own beneath). */
export type { RepoTool };
export type RepoChoices = Readonly<Record<RepoTool, RepoChoice>>;

export const RepoChoiceContext = createContext<RepoChoices>({ [GIT_REPO_TOOL]: NO_REPO_CHOICE });

export function useRepoChoiceContext(tool: RepoTool): RepoChoice {
  return useContext(RepoChoiceContext)[tool] ?? NO_REPO_CHOICE;
}

/** Where a tool's pick for `base` is stored in the map. */
const choiceKey = (tool: RepoTool, base: string): string =>
  tool === GIT_REPO_TOOL ? base : `${tool}:${base}`;

// Child repos per folder, shared by every view in the window: a revisit (or a
// second session on the same folder) paints at once instead of waiting a beat
// on "loading" with the git tools blank. Lookups in flight are shared too -
// both tools of a view ask for the same folder.
const listed = new Map<string, ChildRepo[]>();
const listing = new Map<string, Promise<ChildRepo[]>>();

function listChildRepos(base: string): Promise<ChildRepo[]> {
  const pending = listing.get(base);
  if (pending) return pending;
  const next = window.api.git
    .childRepos(base)
    .then((r) => r.repos ?? [])
    .finally(() => listing.delete(base));
  listing.set(base, next);
  return next;
}

/**
 * One tool's repo choice for the view plus the folder that tool should read
 * (`cwd`). Mounted once per tool per workspace view (workspace-chrome /
 * detached window). The repos are listed from `projectFolder` (else the
 * view's own `base`), so EVERY session of a folder-of-repos project gets the
 * picker - one rooted in `acme/api` too, starting on its own repo - not only
 * the sessions that run on the parent folder. `visit` names the session the
 * view shows: a git pick is dropped as soon as it (or `base`) changes.
 */
export function useRepoChoice(
  base: string | null | undefined,
  tool: RepoTool = GIT_REPO_TOOL,
  projectFolder?: string | null,
  visit?: string | null,
): RepoChoice & { cwd: string | null | undefined } {
  const remembers = tool !== GIT_REPO_TOOL;
  // Where the repos are listed: the project folder when the view knows it.
  const from = base ? (projectFolder ?? base) : base;
  const [map, setMap] = usePersistedState(REPO_CHOICE_KEY, decodeRepoChoice, encodeRepoChoice);
  const [repos, setRepos] = useState<{ base: string; list: ChildRepo[] } | null>(() =>
    from && listed.has(from) ? { base: from, list: listed.get(from)! } : null,
  );
  const [tick, setTick] = useState(0);
  // The git pick of this visit; stale once the view shows something else.
  const visitKey = `${visit ?? ''}\u001f${base ?? ''}`;
  const [pick, setPick] = useState<{ visit: string; path: string } | null>(null);
  // Leaving drops it outright - else coming back to the same session would
  // match its key again and bring the old pick back.
  if (pick && pick.visit !== visitKey) setPick(null);

  useEffect(() => {
    if (!from) return;
    const api = window.api?.git;
    if (!api?.childRepos) {
      // No bridge (a test harness without it): behave like a plain folder.
      setRepos({ base: from, list: [] });
      return;
    }
    let live = true;
    void listChildRepos(from).then((list) => {
      if (!live) return;
      listed.set(from, list);
      setRepos((prev) =>
        prev?.base === from && sameRepos(prev.list, list) ? prev : { base: from, list },
      );
    });
    return () => {
      live = false;
    };
  }, [from, tick]);

  // A result for another folder (a session switch) is not an answer for this one.
  const all = from && repos?.base === from ? repos.list : from ? (listed.get(from) ?? null) : null;
  // Only the repos this tool's Settings ticks allow (judged on the repo's own
  // path), then the view's own repo pointed at the view's folder.
  const integrations = integrationHooks();
  const offered = integrations.useRepoOffered(tool);
  const repoFolders = integrations.useRepoFolders();
  const list = useMemo(
    () =>
      all && base
        ? offeredRepos(
            all.filter((repo) => offered(repo.path)),
            base,
          )
        : null,
    [all, base, offered],
  );
  // Project folders main already knows hold child repos (the scopes carry
  // them): only those wait for the listing before the git tools start.
  const holdsRepos = !!from && repoFolders.includes(trimSeparators(from));
  const cwd = resolveRepoCwd(
    base,
    list,
    !base
      ? undefined
      : remembers
        ? map[choiceKey(tool, base)]
        : pick?.visit === visitKey
          ? pick.path
          : undefined,
    holdsRepos,
    // Nothing picked yet: the view's own repo, when this tool offers it.
    base ?? undefined,
  );

  const select = useCallback(
    (path: string) => {
      if (!base) return;
      if (!remembers) {
        setPick({ visit: visitKey, path });
        return;
      }
      const key = choiceKey(tool, base);
      setMap((prev) => (prev[key] === path ? prev : { ...prev, [key]: path }));
    },
    [base, tool, setMap, remembers, visitKey],
  );
  const reload = useCallback(() => setTick((t) => t + 1), []);

  return useMemo(
    () => ({
      repos: list ?? [],
      selected: list?.length ? (cwd ?? null) : null,
      select,
      reload,
      cwd,
    }),
    [list, cwd, select, reload],
  );
}

const sameRepos = (a: ChildRepo[], b: ChildRepo[]): boolean =>
  a.length === b.length && a.every((r, i) => r.path === b[i].path && r.name === b[i].name);
