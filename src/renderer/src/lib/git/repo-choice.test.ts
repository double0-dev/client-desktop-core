import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@renderer/test-support';
import type { IntegrationsSlot } from '@renderer/lib/extension/types';
import {
  GIT_REPO_TOOL,
  REPO_CHOICE_KEY,
  decodeRepoChoice,
  offeredRepos,
  resolveRepoCwd,
  useRepoChoice,
  type ChildRepo,
} from '@renderer/lib/git/repo-choice';

const ACME = '/Users/emmaw/code/acme';
const API = { name: 'api', path: `${ACME}/api` };
const WEB = { name: 'web', path: `${ACME}/web` };

describe('resolveRepoCwd - which folder the git tools read', () => {
  it('waits while the folder is resolving, or a folder known to hold repos is listed', () => {
    // Answering with the parent here would flash "not a git repository".
    expect(resolveRepoCwd(undefined, [API], undefined)).toBeUndefined();
    expect(resolveRepoCwd(ACME, null, undefined, true)).toBeUndefined();
  });

  it('starts a plain folder on itself while its (empty) listing is pending', () => {
    // Every first visit of an ordinary checkout used to start blank for one
    // round trip - for a lookup that answers "no child repos".
    expect(resolveRepoCwd('/Users/emmaw/code/production-pipeline', null, undefined)).toBe(
      '/Users/emmaw/code/production-pipeline',
    );
  });

  it('keeps the folder itself when it has no child repos', () => {
    expect(resolveRepoCwd('/Users/emmaw/code/production-pipeline', [], undefined)).toBe(
      '/Users/emmaw/code/production-pipeline',
    );
    expect(resolveRepoCwd(null, [], undefined)).toBeNull();
  });

  it('takes the remembered repo, else the first', () => {
    expect(resolveRepoCwd(ACME, [API, WEB], WEB.path)).toBe(WEB.path);
    expect(resolveRepoCwd(ACME, [API, WEB], undefined)).toBe(API.path);
    // A remembered repo that was deleted or moved falls back instead of
    // pointing the tools at a folder that is gone.
    expect(resolveRepoCwd(ACME, [API, WEB], `${ACME}/mobile`)).toBe(API.path);
  });
});

describe('offeredRepos - the view own repo points at the view', () => {
  it('points the repo a session works in at the session folder', () => {
    expect(offeredRepos([API, WEB], `${API.path}/src`)).toEqual([
      { ...API, path: `${API.path}/src` },
      WEB,
    ]);
  });

  it('leaves the list alone on the parent folder, a repo itself or a plain subfolder', () => {
    expect(offeredRepos([API, WEB], ACME)).toEqual([API, WEB]);
    expect(offeredRepos([API, WEB], `${API.path}/`)).toEqual([API, WEB]);
    expect(offeredRepos([API, WEB], `${ACME}/docs`)).toEqual([API, WEB]);
  });
});

describe('decodeRepoChoice', () => {
  it('keeps string entries and drops the rest', () => {
    expect(decodeRepoChoice(JSON.stringify({ [ACME]: WEB.path, x: 3, y: '' }))).toEqual({
      [ACME]: WEB.path,
    });
    expect(decodeRepoChoice('not json')).toEqual({});
    expect(decodeRepoChoice(null)).toEqual({});
  });
});

describe('useRepoChoice', () => {
  let childRepos: ReturnType<typeof vi.fn<(cwd: string) => Promise<{ repos: ChildRepo[] }>>>;

  beforeEach(() => {
    localStorage.clear();
    childRepos = vi.fn(async (cwd: string) => ({ repos: cwd === ACME ? [API, WEB] : [] }));
    stubApi({ git: { childRepos } });
  });

  it('aims Changes at the first repo, then at the picked one, for this visit only', async () => {
    const { result, rerender } = renderHook(
      ({ visit }) => useRepoChoice(ACME, GIT_REPO_TOOL, undefined, visit),
      { initialProps: { visit: 's-1' } },
    );
    await waitFor(() => expect(result.current.cwd).toBe(API.path));
    expect(result.current.repos).toEqual([API, WEB]);
    expect(result.current.selected).toBe(API.path);

    act(() => result.current.select(WEB.path));
    expect(result.current.cwd).toBe(WEB.path);
    expect(result.current.selected).toBe(WEB.path);
    // Nothing is written down: a remembered pick greeted the next visit with
    // the repo peeked at last time instead of the session's own.
    expect(decodeRepoChoice(localStorage.getItem(REPO_CHOICE_KEY))).toEqual({});

    // Another session on the same folder opens on its own repo...
    rerender({ visit: 's-2' });
    expect(result.current.cwd).toBe(API.path);
    // ...and so does coming back to the first one.
    rerender({ visit: 's-1' });
    expect(result.current.cwd).toBe(API.path);
  });

  it('remembers any other tool’s pick per folder', async () => {
    const { result } = renderHook(() => useRepoChoice(ACME, 'gadget', undefined, 's-1'));
    await waitFor(() => expect(result.current.cwd).toBe(API.path));
    act(() => result.current.select(WEB.path));
    expect(decodeRepoChoice(localStorage.getItem(REPO_CHOICE_KEY))).toEqual({
      [`gadget:${ACME}`]: WEB.path,
    });
    const again = renderHook(() => useRepoChoice(ACME, 'gadget', undefined, 's-2'));
    expect(again.result.current.cwd).toBe(WEB.path);
  });

  it('offers nothing for a folder that is a repo itself', async () => {
    const plain = '/Users/emmaw/code/production-pipeline';
    const { result } = renderHook(() => useRepoChoice(plain));
    await waitFor(() => expect(result.current.cwd).toBe(plain));
    expect(result.current.repos).toEqual([]);
    expect(result.current.selected).toBeNull();
  });

  it('follows a session switch and ignores a late answer for the folder it left', async () => {
    const OTHER = '/Users/emmaw/code/other';
    const OTHER_API = { name: 'api', path: `${OTHER}/api` };
    let answerOther: (v: { repos: ChildRepo[] }) => void = () => {};
    childRepos.mockImplementation(async (cwd: string) =>
      cwd === OTHER
        ? new Promise((resolve) => {
            answerOther = resolve;
          })
        : { repos: cwd === ACME ? [API, WEB] : [] },
    );
    const { result, rerender } = renderHook(({ base }) => useRepoChoice(base), {
      initialProps: { base: ACME },
    });
    await waitFor(() => expect(result.current.cwd).toBe(API.path));

    // To OTHER, whose listing hangs: never ACME's repos for it.
    rerender({ base: OTHER });
    expect(result.current.repos).toEqual([]);
    expect(result.current.cwd).not.toBe(API.path);

    // Back to ACME before OTHER answers: the cached listing paints at once...
    rerender({ base: ACME });
    expect(result.current.cwd).toBe(API.path);
    // ...and OTHER's late answer must not land on ACME's view.
    await act(async () => answerOther({ repos: [OTHER_API] }));
    expect(result.current.repos).toEqual([API, WEB]);
    expect(result.current.cwd).toBe(API.path);
  });

  /**
   * An integrations slot that offers `acme`'s repos per tool as given (the
   * official build's answers from Settings › Integrations ticks), installed in
   * a freshly imported module graph.
   */
  async function withScopes(gadget: { api: boolean; web: boolean }) {
    stubApi({ git: { childRepos } });
    vi.resetModules();
    const { installRendererExtension } = await import('@renderer/lib/extension/registry');
    const offered = (tool: string, path: string): boolean =>
      tool !== 'gadget' || (path === API.path ? gadget.api : gadget.web);
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      integrations: {
        useRepoOffered: (tool: string) => (path: string) => offered(tool, path),
        useProjectRepoFolder: () => null,
        useRepoFolders: () => [],
      } as unknown as IntegrationsSlot,
    });
    return import('@renderer/lib/git/repo-choice');
  }

  it('lists per tool what the integrations offer, and remembers each pick apart', async () => {
    // `api` has the gadget tool switched off: its picker must not offer it,
    // and picking a repo in one tool must not move the other.
    const fresh = await withScopes({ api: false, web: true });
    const { result } = renderHook(() => ({
      changes: fresh.useRepoChoice(ACME, fresh.GIT_REPO_TOOL),
      gadget: fresh.useRepoChoice(ACME, 'gadget'),
    }));
    await waitFor(() => expect(result.current.gadget.repos).toEqual([WEB]));
    expect(result.current.changes.repos).toEqual([API, WEB]);
    expect(result.current.gadget.cwd).toBe(WEB.path);
    expect(result.current.changes.cwd).toBe(API.path);

    act(() => result.current.changes.select(WEB.path));
    expect(result.current.changes.cwd).toBe(WEB.path);
    act(() => result.current.changes.select(API.path));
    // The gadget never followed - and never lands on the repo it may not show.
    expect(result.current.gadget.cwd).toBe(WEB.path);
  });

  it('gives a session rooted in one repo the whole project, starting on its own checkout', async () => {
    // Only sessions on the parent folder had a picker; one rooted in a repo
    // (here a worktree of `api`) had none. Listed from the project folder, it
    // gets every repo - its own pointing at its worktree, not the main checkout.
    const worktree = `${API.path}/.worktree/fix-auth`;
    const fresh = await withScopes({ api: false, web: true });
    const { result } = renderHook(() => ({
      changes: fresh.useRepoChoice(worktree, fresh.GIT_REPO_TOOL, ACME),
      gadget: fresh.useRepoChoice(worktree, 'gadget', ACME),
    }));
    await waitFor(() => expect(result.current.changes.repos).toHaveLength(2));
    expect(childRepos).toHaveBeenCalledWith(ACME);
    expect(result.current.changes.repos).toEqual([{ ...API, path: worktree }, WEB]);
    expect(result.current.changes.cwd).toBe(worktree);
    // The gadget is off for `api`: this session opens it on `web`.
    await waitFor(() => expect(result.current.gadget.repos).toEqual([WEB]));
    expect(result.current.gadget.cwd).toBe(WEB.path);

    // Away and back: the session's own entry returns to its worktree.
    act(() => result.current.changes.select(WEB.path));
    expect(result.current.changes.cwd).toBe(WEB.path);
    act(() => result.current.changes.select(worktree));
    expect(result.current.changes.cwd).toBe(worktree);
  });

  it('opens Changes on the session own repo again after a switch away and back', async () => {
    // The reported bug: pick `web` in a session rooted in `api`, go to another
    // session and return - Changes still showed `web`.
    const worktree = `${API.path}/.worktree/fix-auth`;
    const { result, rerender } = renderHook(
      ({ base, visit }) => useRepoChoice(base, GIT_REPO_TOOL, ACME, visit),
      { initialProps: { base: worktree, visit: 's-api' } },
    );
    await waitFor(() => expect(result.current.cwd).toBe(worktree));
    act(() => result.current.select(WEB.path));
    expect(result.current.cwd).toBe(WEB.path);

    rerender({ base: ACME, visit: 's-root' });
    // A session on the parent folder has no repo of its own: the first one.
    expect(result.current.cwd).toBe(API.path);
    rerender({ base: worktree, visit: 's-api' });
    expect(result.current.cwd).toBe(worktree);
  });

  it('re-lists on reload, so a stack cloned since shows up', async () => {
    const { result } = renderHook(() => useRepoChoice(ACME));
    await waitFor(() => expect(result.current.repos).toHaveLength(2));
    const mobile = { name: 'mobile', path: `${ACME}/mobile` };
    childRepos.mockResolvedValueOnce({ repos: [API, mobile, WEB] });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.repos).toEqual([API, mobile, WEB]));
  });
});
