import { agentSessionsCollection, projectsCollection } from '@renderer/lib/collections';
import { sanitizeWorktreeName, uniqueBranchName } from '@renderer/lib/git/branch-name';
import {
  setViewLaunch,
  setOneShotCommand,
  setPendingSessionSetup,
  setupPtyId,
} from '@renderer/lib/session/setup';
import { conversationPtyId } from '@renderer/lib/workspace/layout';
import { reRootInWorktree } from '@renderer/lib/session/root';
import { joinPath } from '@renderer/lib/utils';
import { worktreeFolderNames } from '@renderer/lib/git/worktree';
import { clampLabel } from '@renderer/lib/session/label';
import { alertDialog } from '@renderer/components/ui/confirm-dialog';
import { getTerminalSettings } from '@renderer/lib/settings/terminal-settings';
import { sessionViewBridge } from '@renderer/lib/session/view-bridge';

export type LaunchSessionOptions = {
  /**
   * '' = unnamed: the label seeds from `agentLabel` and the session is marked
   * `autoNamed`, so it follows the conversation terminal's title reports until
   * the user renames it (see session/auto-name.ts).
   */
  name: string;
  /** Command the primary terminal auto-runs (e.g. `claude`); '' = plain shell. */
  startCommand: string;
  /** Display label stored on the session's `agent` field (template name / 'Custom'). */
  agentLabel: string;
  /** Whether new "+" terminals also auto-run `startCommand`. */
  runOnNewTerminal: boolean;
  /**
   * An extension's runtime (`SessionViewSlot.runtime`): `startCommand` launches
   * its agent in main, shown in the extension's view - no shell is spawned for
   * it. Absent / null = a terminal session.
   */
  runtime?: string | null;
  /**
   * A terminal session whose primary tab opens on the extension's view over its
   * agent CLI - the shell runs as always; the tab menu flips between the two.
   */
  openInView?: boolean;
  /**
   * Command for the session's FIRST spawn only - a task card's prompt, say
   * (`claude '<prompt>'`). Never persisted: the session stores `startCommand`,
   * so "+" terminals and a respawn after an app restart run the plain template
   * command instead of re-sending the prompt. Defaults to `startCommand`.
   *
   * As a function it is resolved once the worktree exists and the session row is
   * written, but before any shell spawns - the hook for staging files the
   * command then refers to (a task card copies its images into `cwd` and points
   * the prompt at them). Whatever it returns is the command that runs.
   */
  firstRunCommand?:
    string | ((ctx: { sessionId: string; cwd: string | null }) => Promise<string> | string);
  projectId: string | null;
  /** The project's folder - the fallback root, and the fallback worktree base. */
  projectPath: string | null;
  ownerId: string;
  /** Create an isolated git worktree (under `.worktree/`) for this session. */
  worktree: boolean;
  /**
   * Without `worktree`: switch the folder the session runs in to a new branch,
   * named like a worktree branch would be (`git switch -c` in the repo
   * containing it - uncommitted changes come along). Ignored with `worktree`,
   * which always cuts its own branch.
   */
  branch?: boolean;
  /**
   * One-time command for the worktree's setup tab (e.g. `npm i`); only used
   * when `worktree`. Omit to run the project's own setup command (Settings →
   * Worktrees); pass a string - even '' - to decide explicitly, as the New
   * Session dialog does with its prefilled field.
   */
  setupCommand?: string;
  /**
   * Absolute folder to root the session in ("New session here" on an explorer
   * folder, a task card's working folder); null/absent = project root.
   *
   * With `worktree`, this also decides WHICH repo the worktree is cut from: a
   * project can hold several independent checkouts, so the worktree is created
   * in the repo containing this folder (see `git:repoRoot`), and the session is
   * re-rooted at the matching subfolder inside it.
   */
  rootPath?: string | null;
  /**
   * A worktree that already exists - cut by the caller (a session moved from
   * another machine): no worktree or branch is created, it is seeded
   * with the project's ticked ignored files and becomes the row's
   * `worktreePath`. `rootPath`, when given, is a folder inside it.
   */
  existingWorktree?: { path: string; repoRoot: string };
  /**
   * Files from THIS computer's checkout to copy into the new worktree on a
   * host (plan 29 spec › 9.2, New Session's "Copy from this computer"):
   * repo-relative paths, copied after the host project's own seed (so they
   * win on a clash) and before any shell spawns. Only with `worktree`.
   */
  localSeed?: { sourceRoot: string; paths: string[] };
  /**
   * The new session's id, chosen by the caller - a moved session pins the agent
   * conversation to it (the new tab's record) before anything spawns. Fresh
   * uuid otherwise.
   */
  id?: string;
};

/**
 * Create a session - optionally backed by a git worktree at
 * `<projectPath>/.worktree/<name>` on a new branch - and return its id, or null
 * if nothing was created (the worktree command failed, in which case the user
 * has already seen an alert). The caller navigates to the id.
 *
 * The session's shells start HERE, not on first open: the primary shell spawns
 * immediately with the start command (so a launched agent begins working even if
 * the session is never opened - e.g. from a task card, which spawns it with its
 * one-shot `firstRunCommand` prompt), and a worktree setup command runs right
 * away in its own eagerly-spawned shell - after the worktree was seeded with the
 * project's ticked ignored files (Settings → Worktrees). Both use the
 * deterministic PTY ids the workspace derives, so its first mount adopts the
 * live shells (with a scrollback replay) instead of spawning fresh ones; the
 * setup tab itself is still added on first mount (see session-setup).
 */
export async function launchSession(opts: LaunchSessionOptions): Promise<string | null> {
  // Clamped up front, before the worktree is cut: a label the schema rejects
  // would otherwise throw out of `insert` with the branch already created.
  const trimmed = clampLabel(opts.name);
  const id = opts.id ?? crypto.randomUUID();
  // The project's worktree setup (Settings → Worktrees): what to copy into a
  // fresh worktree and the fallback setup command.
  const project = opts.projectId ? projectsCollection.get(opts.projectId) : undefined;

  let rootPath = opts.rootPath ?? null;
  let worktreePath: string | null = null;
  const base = rootPath ?? opts.projectPath;
  // An unnamed session still needs a branch before any title arrives to name
  // it, and renames never rename the branch - so it's cut from the template
  // plus the session id's head, unique and traceable back to the session.
  const wanted = sanitizeWorktreeName(trimmed || `${opts.agentLabel}-${id.slice(0, 8)}`);
  // A project on a remote host (a private plan) takes the
  // same path: main runs every git call below on the host that holds the
  // folder, so the worktree, the branch and the seed copy happen there.
  if (opts.existingWorktree) {
    worktreePath = opts.existingWorktree.path;
    const copyPaths = project?.worktreeCopyPaths ?? [];
    if (copyPaths.length > 0) {
      await window.api?.git
        ?.worktreeSeed?.(opts.existingWorktree.repoRoot, worktreePath, copyPaths)
        .catch(() => undefined);
    }
  } else if (opts.worktree && base) {
    if (!wanted) {
      await alertDialog({
        title: 'Couldn’t create a worktree',
        description: 'The session name has no usable characters for a branch name.',
      });
      return null;
    }
    // The worktree belongs to the repo that actually contains the session's
    // folder, which is not always the project folder: a project can be a folder
    // of independent checkouts, and a session rooted in one of them must branch
    // there so its git surfaces track that repo. Falling back to the project
    // folder keeps pre-existing behaviour when the lookup is unavailable.
    const repoRoot = (await window.api?.git?.repoRoot?.(base))?.root ?? null;
    const worktreeBase = repoRoot ?? opts.projectPath;
    if (worktreeBase) {
      // The same card or ticket launching twice wants the same branch (a second
      // session for one ticket is a normal flow; a deleted session may have
      // kept its branch) - `git worktree add -b` refuses an existing one, so
      // take the next free `-2`, `-3`, … rather than failing the launch.
      const branch = uniqueBranchName(wanted, await takenWorktreeNames(worktreeBase));
      worktreePath = joinPath(joinPath(worktreeBase, '.worktree'), branch);
      const res = await window.api.git.worktreeAdd(worktreeBase, worktreePath, branch);
      if (res?.error) {
        await alertDialog({ title: 'Couldn’t create a worktree', description: res.error });
        return null;
      }
      rootPath = reRootInWorktree(rootPath, worktreeBase, worktreePath);
      // Seed it with the project's ticked ignored files (.env and friends)
      // before any shell spawns, so the agent's first command and the setup
      // tab both find them. Best-effort: a failed copy still launches - the
      // worktree is usable, just unseeded.
      const copyPaths = project?.worktreeCopyPaths ?? [];
      if (copyPaths.length > 0) {
        await window.api?.git
          ?.worktreeSeed?.(worktreeBase, worktreePath, copyPaths)
          .catch(() => undefined);
      }
      // Then what the user ticked from this computer: owner-only, the
      // laptop's copy winning for those paths. A failed copy still launches -
      // the user hears which files did not arrive.
      if (opts.localSeed && opts.localSeed.paths.length > 0) {
        const res = await window.api?.git
          ?.seedFromLocal?.(opts.localSeed.sourceRoot, worktreePath, opts.localSeed.paths)
          .catch((err: unknown) => ({ error: String(err) }));
        const failed = seedFailure(res);
        if (failed) {
          void alertDialog({ title: 'Some files were not copied', description: failed });
        }
      }
    }
  } else if (opts.branch && base) {
    // No worktree: the session runs in the folder itself, so the branch is cut
    // there - in the repo containing it, from whatever is checked out.
    if (!wanted) {
      await alertDialog({
        title: 'Couldn’t create a branch',
        description: 'The session name has no usable characters for a branch name.',
      });
      return null;
    }
    const repoRoot = (await window.api?.git?.repoRoot?.(base))?.root ?? base;
    const branch = uniqueBranchName(wanted, await takenWorktreeNames(repoRoot));
    const res = await window.api?.git?.createBranch?.(repoRoot, branch, true);
    if (res?.error) {
      await alertDialog({ title: 'Couldn’t create a branch', description: res.error });
      return null;
    }
  }

  const viewed = opts.runtime != null;
  const now = new Date();
  const inserted = agentSessionsCollection.insert({
    id,
    // Unnamed launch: the template label stands in until the shell's first
    // title report replaces it (autoNamed gates that - see session/auto-name.ts).
    label: trimmed || opts.agentLabel,
    autoNamed: !trimmed,
    detail: '',
    agent: opts.agentLabel,
    startCommand: opts.startCommand.trim() || null,
    runOnNewTerminal: viewed ? false : opts.runOnNewTerminal,
    runtime: opts.runtime ?? null,
    // A runtime session waits for its first prompt; a terminal session's agent starts working at once.
    status: viewed ? 'idle' : 'active',
    worktreePath,
    rootPath,
    // Ascending sort, so the newest session (most negative) sits on top - a drag
    // later lands it at the midpoint between its neighbours (see workspace-chrome).
    sortOrder: -now.getTime(),
    projectId: opts.projectId,
    ownerId: opts.ownerId,
    createdAt: now,
    updatedAt: now,
  });

  if (opts.openInView && !viewed) setViewLaunch(id);

  const shellCwd = rootPath ?? worktreePath ?? opts.projectPath ?? null;
  const setupCommand = (opts.setupCommand ?? project?.worktreeSetupCommand ?? '').trim();
  const shellIntegration = getTerminalSettings().shellIntegration;

  if (viewed) {
    // A runtime session has no conversation shell: main starts its agent
    // (reading the command and folder from the row just written) and the
    // extension's view shows it. The worktree setup still runs in its own tab.
    // Once the row is written (main reads the command from it), so the agent
    // is up before the first prompt; the view's own open covers a miss.
    void Promise.resolve(inserted?.when('settled'))
      .catch(() => undefined)
      .then(() => sessionViewBridge()?.open(id));
    if (worktreePath && setupCommand) {
      setPendingSessionSetup(id, setupCommand);
      window.api?.terminal.create({
        id: setupPtyId(id),
        cwd: shellCwd,
        initialCommand: setupCommand,
        shellIntegration,
      });
    }
    return id;
  }

  // Eager spawns. `create` is idempotent in main, so the workspace mount's own
  // create for these ids is a no-op adopt - never a second shell.
  const requested = opts.firstRunCommand ?? opts.startCommand;
  const firstRun =
    (typeof requested === 'function'
      ? await requested({ sessionId: id, cwd: shellCwd })
      : requested
    ).trim() || undefined;
  // Register the first-run command as this PTY's one-shot too (memory-only), so
  // it still runs if the eager spawn below couldn't happen (no PTY bridge) - and
  // is gone by the next relaunch, where the tab respawns with `startCommand`.
  if (firstRun) setOneShotCommand(conversationPtyId(id), firstRun);
  // The shell integration setting is read at spawn, like a tab's own create.
  window.api?.terminal.create({
    id: conversationPtyId(id),
    cwd: shellCwd,
    initialCommand: firstRun,
    shellIntegration,
  });

  if (worktreePath && setupCommand) {
    setPendingSessionSetup(id, setupCommand);
    window.api?.terminal.create({
      id: setupPtyId(id),
      cwd: shellCwd,
      initialCommand: setupCommand,
      shellIntegration,
    });
  }
  return id;
}

/**
 * Names a new worktree branch can't take in `repoRoot`: every local branch
 * (`-b` refuses an existing one) and every registered worktree folder under
 * `.worktree/` (a worktree whose branch was deleted still occupies its folder).
 * Best-effort - no git bridge, or a failed read, yields nothing and the launch
 * tries the plain name, exactly as before.
 */
async function takenWorktreeNames(repoRoot: string): Promise<string[]> {
  let refs: Awaited<ReturnType<NonNullable<typeof window.api>['git']['refs']>>['refs'];
  try {
    refs = (await window.api?.git?.refs?.(repoRoot))?.refs;
  } catch {
    refs = undefined;
  }
  if (!refs) return [];
  return [...refs.branches.map((b) => b.name), ...worktreeFolderNames(refs.worktrees, repoRoot)];
}

/**
 * What to tell the user after files from this computer were copied in
 * (`git:seedFromLocal`), or null
 * when everything ticked arrived.
 */
export function seedFailure(
  res:
    | {
        copied?: string[];
        skipped?: string[];
        errors?: { path: string; message: string }[];
        error?: string;
      }
    | undefined,
): string | null {
  if (!res) return null;
  if (res.error) return `The files from this computer were not copied: ${res.error}`;
  const lines = [
    ...(res.errors ?? []).map((e) => `${e.path} - ${e.message}`),
    ...(res.skipped ?? []).map((p) => `${p} - left out`),
  ];
  return lines.length > 0 ? lines.join('\n') : null;
}
