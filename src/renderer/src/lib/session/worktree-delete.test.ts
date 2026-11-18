import { afterEach, describe, expect, it } from 'vitest';
import { registerRestoredLayouts } from '@renderer/lib/session/bridge';
import type { AgentSession } from '@renderer/lib/collections';
import { sessionBusyStatus, worktreeParts } from '@renderer/lib/session/worktree-delete';
import { clearTerminalBusy, setTerminalBusy } from '@renderer/lib/terminal/busy';
import {
  addTab,
  conversationPtyId,
  initialLayout,
  removeTab,
  CONVERSATION_TAB_ID,
} from '@renderer/lib/workspace/layout';

describe('worktreeParts', () => {
  it('splits a worktree path into the repo dir and the branch', () => {
    expect(worktreeParts('/repo/production-pipeline/.worktree/fix-auth-tokens')).toEqual({
      projectDir: '/repo/production-pipeline',
      branch: 'fix-auth-tokens',
    });
  });

  it('falls back to the last segment when the path is not under .worktree', () => {
    expect(worktreeParts('/tmp/detached-tree')).toEqual({
      projectDir: '/tmp/detached-tree',
      branch: 'detached-tree',
    });
  });

  it('splits a Windows worktree path, native or mixed', () => {
    // Native since 2026-10-28; sessions created before carry `C:\…/.worktree/…`.
    const want = { projectDir: 'C:\\Users\\emmaw\\acme', branch: 'fix-auth' };
    expect(worktreeParts('C:\\Users\\emmaw\\acme\\.worktree\\fix-auth')).toEqual(want);
    expect(worktreeParts('C:\\Users\\emmaw\\acme/.worktree/fix-auth')).toEqual(want);
    expect(worktreeParts('C:\\tmp\\detached-tree').branch).toBe('detached-tree');
  });
});

describe('sessionBusyStatus', () => {
  // The busy registry is module-level and leaks between tests - unique session
  // ids per test, and each entry cleared afterwards.
  const marked: string[] = [];
  const mark = (sessionId: string, status: 'running' | 'needs-input'): void => {
    const ptyId = conversationPtyId(sessionId);
    setTerminalBusy(ptyId, status);
    marked.push(ptyId);
  };
  afterEach(() => {
    for (const ptyId of marked.splice(0)) clearTerminalBusy(ptyId);
  });

  const session = (id: string): AgentSession => ({ id, agent: 'Claude Code' }) as AgentSession;

  it('is null for a session with nothing busy', () => {
    expect(sessionBusyStatus(session('wd-idle'))).toBeNull();
  });

  it('reports the conversation terminal state for an unopened session', () => {
    mark('wd-running', 'running');
    expect(sessionBusyStatus(session('wd-running'))).toBe('running');
    mark('wd-blocked', 'needs-input');
    expect(sessionBusyStatus(session('wd-blocked'))).toBe('needs-input');
  });

  it('checks every tab of the layout a session not opened yet this run is restored with', () => {
    // The bug: only the conversation terminal was checked, so a Claude working
    // in a second tab of such a session was killed by the delete without a
    // warning (2026-10-29). Its conversation tab is gone from the layout here.
    const layout = removeTab(
      addTab(initialLayout('wd-second'), 'root:wd-second', {
        id: 't2',
        kind: 'terminal',
        title: 'Claude Code 2',
        ptyId: 'wd-second-pty-2',
      }),
      CONVERSATION_TAB_ID,
    );
    const off = registerRestoredLayouts((id) => (id === 'wd-second' ? layout : undefined));
    try {
      setTerminalBusy('wd-second-pty-2', 'running');
      marked.push('wd-second-pty-2');
      expect(sessionBusyStatus(session('wd-second'))).toBe('running');
    } finally {
      off();
    }
  });
});
