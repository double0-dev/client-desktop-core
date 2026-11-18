import type { HostRuntime } from './host-runtime';

/**
 * What git on a REMOTE host may do after an ssh host-key refusal from a
 * hosting service: learn the service's pinned keys and run once more
 * (hosts/provider-host-keys.ts, plan 29 › 12). The remote hosts are the
 * official build's (a private plan › M7); with no hooks
 * registered the refusal is simply the answer.
 */
export type GitRemoteHooks = {
  /** Whether double0 pins keys for this ssh server (GitHub, GitLab, Bitbucket). */
  hasPinnedKeys(server: string | null): server is string;
  /** Append the server's pinned keys on the host; `'added'` = run git again. */
  trustProviderHostKey(runtime: HostRuntime, server: string | null): Promise<string>;
};

let hooks: GitRemoteHooks | null = null;

/** Register the hooks; returns the undo. */
export function setGitRemoteHooks(next: GitRemoteHooks): () => void {
  hooks = next;
  return () => {
    if (hooks === next) hooks = null;
  };
}

export function gitRemoteHooks(): GitRemoteHooks | null {
  return hooks;
}
