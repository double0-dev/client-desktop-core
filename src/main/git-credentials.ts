/**
 * What app-spawned git may borrow from the connected hosting accounts, when
 * the build has any (a private plan › decision 17: the
 * integrations are Pro). Core's git runs with the user's own credentials -
 * their ssh agent, keychain helper, `~/.ssh` - and gets nothing extra here;
 * the official build registers its integrations (`setGitCredentials`).
 */
export type GitCredentials = {
  /** Extra env for one git spawn in `cwd` (the askpass + ssh wrapper). */
  gitEnv(cwd?: string | null): NodeJS.ProcessEnv;
  /** The account key files a host's agent forward may offer (hosts/app-agent.ts). */
  appSshKeyFiles(): string[];
};

const NONE: GitCredentials = { gitEnv: () => ({}), appSshKeyFiles: () => [] };

let current: GitCredentials = NONE;

/** Register the integrations' credentials; returns the undo. */
export function setGitCredentials(credentials: GitCredentials): () => void {
  current = credentials;
  return () => {
    if (current === credentials) current = NONE;
  };
}

export function gitCredentialsEnv(cwd?: string | null): NodeJS.ProcessEnv {
  return current.gitEnv(cwd);
}

export function appSshKeyFiles(): string[] {
  return current.appSshKeyFiles();
}
