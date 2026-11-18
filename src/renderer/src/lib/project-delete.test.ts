import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, Project } from '@renderer/lib/collections';
import { confirmProjectDeletion, linkedSessionsNote } from '@renderer/lib/project-delete';
import { registerHostSource, resetHostSourceForTest } from '@renderer/lib/hosts/host-directory';
import { confirmProjectDelete } from '@renderer/components/project-delete-dialog';
import { alertDialog, confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { stubApi } from '@renderer/test-support';

vi.mock('@renderer/components/project-delete-dialog', () => ({
  confirmProjectDelete: vi.fn(),
}));
vi.mock('@renderer/components/ui/confirm-dialog', () => ({
  confirmDialog: vi.fn(),
  alertDialog: vi.fn(async () => {}),
}));

const dialog = vi.mocked(confirmProjectDelete);
const confirm = vi.mocked(confirmDialog);
const alert = vi.mocked(alertDialog);

const PROJECT = { id: 'p1', name: 'acme', path: '/repo/acme' } as Project;
const WT1 = '/repo/acme/.worktree/fix-auth-tokens';
const WT2 = '/repo/acme/.worktree/add-retry-to-sync';

function session(id: string, worktreePath: string | null, projectId = 'p1'): AgentSession {
  return {
    id,
    projectId,
    label: id,
    agent: 'Claude Code',
    worktreePath,
  } as AgentSession;
}

let worktreeRemove: ReturnType<typeof vi.fn>;
let deleteBranch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dialog.mockReset();
  confirm.mockReset();
  alert.mockClear();
  worktreeRemove = vi.fn(async () => ({ ok: true }));
  deleteBranch = vi.fn(async () => ({ ok: true }));
  stubApi({ git: { worktreeRemove, deleteBranch } });
});

describe('a project with no sessions', () => {
  it('falls back to a plain confirm and never opens the rich dialog', async () => {
    confirm.mockResolvedValue(true);
    await expect(confirmProjectDeletion(PROJECT, [])).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));
    expect(dialog).not.toHaveBeenCalled();
    expect(worktreeRemove).not.toHaveBeenCalled();
  });

  it('only counts the project’s own sessions', async () => {
    // Another project's worktree session must not drag the rich dialog in -
    // and must never have its worktree touched.
    confirm.mockResolvedValue(true);
    await expect(confirmProjectDeletion(PROJECT, [session('other', WT1, 'p2')])).resolves.toBe(
      true,
    );
    expect(dialog).not.toHaveBeenCalled();
    expect(worktreeRemove).not.toHaveBeenCalled();
  });
});

describe('cancelling', () => {
  it('resolves false when the dialog is dismissed', async () => {
    dialog.mockResolvedValue(null);
    await expect(confirmProjectDeletion(PROJECT, [session('s1', WT1)])).resolves.toBe(false);
    expect(worktreeRemove).not.toHaveBeenCalled();
  });
});

describe('worktree cleanup', () => {
  it('keeps the worktrees on disk when the option is un-ticked', async () => {
    dialog.mockResolvedValue({ removeWorktrees: false, deleteBranches: false });
    await expect(confirmProjectDeletion(PROJECT, [session('s1', WT1)])).resolves.toBe(true);
    expect(worktreeRemove).not.toHaveBeenCalled();
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it('removes every worktree from its project dir, unforced first', async () => {
    dialog.mockResolvedValue({ removeWorktrees: true, deleteBranches: false });
    await expect(
      confirmProjectDeletion(PROJECT, [
        session('s1', WT1),
        session('s2', WT2),
        session('s3', null),
      ]),
    ).resolves.toBe(true);
    expect(worktreeRemove).toHaveBeenCalledTimes(2);
    expect(worktreeRemove).toHaveBeenCalledWith('/repo/acme', WT1, false);
    expect(worktreeRemove).toHaveBeenCalledWith('/repo/acme', WT2, false);
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it('force-deletes the branches only when opted in', async () => {
    dialog.mockResolvedValue({ removeWorktrees: true, deleteBranches: true });
    await expect(
      confirmProjectDeletion(PROJECT, [session('s1', WT1), session('s2', WT2)]),
    ).resolves.toBe(true);
    expect(deleteBranch).toHaveBeenCalledWith('/repo/acme', 'fix-auth-tokens', true);
    expect(deleteBranch).toHaveBeenCalledWith('/repo/acme', 'add-retry-to-sync', true);
  });

  it('retries dirty worktrees forced after one aggregate confirm', async () => {
    dialog.mockResolvedValue({ removeWorktrees: true, deleteBranches: false });
    confirm.mockResolvedValue(true);
    worktreeRemove.mockImplementation(async (_dir: string, path: string, force: boolean) =>
      path === WT1 && !force ? { error: 'contains modified or untracked files' } : { ok: true },
    );
    await expect(
      confirmProjectDeletion(PROJECT, [session('s1', WT1), session('s2', WT2)]),
    ).resolves.toBe(true);
    // Clean one removed unforced; the dirty one retried with force after the confirm.
    expect(worktreeRemove).toHaveBeenCalledWith('/repo/acme', WT2, false);
    expect(worktreeRemove).toHaveBeenCalledWith('/repo/acme', WT1, true);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: 'Remove anyway' }),
    );
  });

  it('aborts without forcing when the dirty confirm is declined', async () => {
    dialog.mockResolvedValue({ removeWorktrees: true, deleteBranches: false });
    confirm.mockResolvedValue(false);
    worktreeRemove.mockResolvedValue({ error: 'is dirty' });
    await expect(confirmProjectDeletion(PROJECT, [session('s1', WT1)])).resolves.toBe(false);
    expect(worktreeRemove).toHaveBeenCalledTimes(1);
    expect(worktreeRemove).toHaveBeenCalledWith('/repo/acme', WT1, false);
  });

  it('aborts on a non-forceable removal failure', async () => {
    dialog.mockResolvedValue({ removeWorktrees: true, deleteBranches: true });
    worktreeRemove.mockResolvedValue({ error: 'not a working tree' });
    await expect(confirmProjectDeletion(PROJECT, [session('s1', WT1)])).resolves.toBe(false);
    expect(alert).toHaveBeenCalled();
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it('still deletes the project when only a branch delete fails', async () => {
    // The worktrees are already gone at that point - mirroring the per-session
    // flow, the failure is reported but doesn't strand the project.
    dialog.mockResolvedValue({ removeWorktrees: true, deleteBranches: true });
    deleteBranch.mockResolvedValue({ error: 'branch not found' });
    await expect(confirmProjectDeletion(PROJECT, [session('s1', WT1)])).resolves.toBe(true);
    expect(alert).toHaveBeenCalled();
  });
});

/** A host directory holding `hosts` - the official build's store, as core reads it. */
function withHosts(hosts: { id: string; label: string }[]): void {
  // One array, so the directory's snapshot is stable.
  registerHostSource({ list: () => hosts, subscribe: () => () => {} });
}

describe('sessions on a server listed under the project', () => {
  it('says they stay - they live in a host project of their own', () => {
    const hostId = 'host-1';
    withHosts([{ id: hostId, label: 'build-box' }]);
    const projects = [
      PROJECT,
      { id: 'h1', name: 'acme', path: '/home/emmaw/acme', hostId, linkedProjectId: 'p1' },
      { id: 'h2', name: 'tools', path: '/srv/tools', hostId, linkedProjectId: null },
    ] as Project[];
    const sessions = [session('own', null), session('box', null, 'h1'), session('x', null, 'h2')];
    expect(linkedSessionsNote('p1', sessions, projects)).toBe(
      'Its 1 session on build-box stays, under its own project there.',
    );
    expect(linkedSessionsNote('p1', [session('own', null)], projects)).toBeNull();
    resetHostSourceForTest();
  });
});
