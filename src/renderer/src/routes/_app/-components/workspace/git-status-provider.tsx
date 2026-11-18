import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitContext, type GitStatusValue } from '@renderer/lib/git/context';
import type { GitProviderProps } from '@renderer/lib/extension/types';
import type { GitStatus } from '@renderer/lib/git/types';
import { isWithin } from '@renderer/lib/path-within';

const NOT_A_REPO: GitStatus = {
  repo: false,
  branch: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  userName: null,
  userEmail: null,
  mergeMsg: null,
  operation: null,
  headPushed: false,
};

/**
 * The core build's git provider (a private plan › M4):
 * the status of the view's repo and nothing else - the explorer's colours,
 * the editor gutter, the repo picker's counts. An extension's git client
 * mounts its full provider instead (`RendererExtension.git`), which
 * fills this same context. Same freshness rules as that one: re-read on the
 * repo's git-dir events, on `fs:changed` inside the repo (the surface owns
 * that watch) and when the window comes back into focus; only the visible
 * session's provider talks to git.
 */
export function GitStatusProvider({ cwd, projectId = null, active, children }: GitProviderProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [tick, setTick] = useState(0);
  const root = typeof cwd === 'string' && cwd ? cwd : null;
  const canLoad = active && root != null && !!window.api?.git;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Drop the old repo's status at once when the view points elsewhere.
  useEffect(() => setStatus(null), [root]);

  useEffect(() => {
    if (!canLoad || !root) return;
    let live = true;
    void window.api.git.status(root).then((r) => {
      if (!live) return;
      if (r.status) setStatus(r.status);
      else if (r.error) setStatus(NOT_A_REPO);
    });
    return () => {
      live = false;
    };
  }, [canLoad, root, tick]);

  useEffect(() => {
    if (!canLoad) return;
    const onFocus = (): void => setTick((t) => t + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [canLoad]);

  // Main refuses to watch a folder that is not a repo, so one that becomes a
  // repo (a clone into it) is watched again once its status says so.
  const notRepo = status?.repo === false;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!canLoad || !root) return;
    const git = window.api.git;
    void git.watch(root); // fails quietly when not a repo
    // Coalesce a burst of events into one read.
    const refreshSoon = (): void => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        setTick((t) => t + 1);
      }, 250);
    };
    const offGit = git.onChanged((r) => {
      if (r === root) refreshSoon();
    });
    const offFs = window.api.fs?.onChanged((r, paths) => {
      if (r === root) {
        refreshSoon();
        return;
      }
      // An ancestor's event (a folder-of-repos view watches the parent) counts
      // only for an edit inside this repo; one naming no paths counts too.
      if (!isWithin(root, r)) return;
      if (paths.length === 0 || paths.some((p) => isWithin(p, root))) refreshSoon();
    });
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      offGit();
      offFs?.();
      void git.unwatch(root);
    };
  }, [canLoad, root, notRepo]);

  const loadFileBase = useCallback(
    async (path: string) => {
      if (!root || !window.api?.git) return { error: 'No repository' };
      const r = await window.api.git.show(root, path);
      return { content: r.content, binary: r.binary, error: r.error };
    },
    [root],
  );

  const value = useMemo<GitStatusValue>(
    () => ({ cwd: root, projectId, status, refresh, loadFileBase }),
    [root, projectId, status, refresh, loadFileBase],
  );
  return <GitContext.Provider value={value}>{children}</GitContext.Provider>;
}
