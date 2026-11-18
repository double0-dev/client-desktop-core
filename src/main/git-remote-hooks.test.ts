import { describe, expect, it } from 'vitest';
import { gitRemoteHooks, setGitRemoteHooks, type GitRemoteHooks } from './git-remote-hooks';

describe('git remote hooks', () => {
  it('has none by default: a host-key refusal is the answer, never a retry', () => {
    expect(gitRemoteHooks()).toBeNull();
  });

  it('serves the registered hooks until they are taken back', () => {
    const hooks: GitRemoteHooks = {
      hasPinnedKeys: (server): server is string => server === 'github.com',
      trustProviderHostKey: async () => 'added',
    };
    const undo = setGitRemoteHooks(hooks);
    expect(gitRemoteHooks()).toBe(hooks);
    undo();
    expect(gitRemoteHooks()).toBeNull();
  });
});
