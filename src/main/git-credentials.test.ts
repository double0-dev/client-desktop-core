import { describe, expect, it } from 'vitest';
import { appSshKeyFiles, gitCredentialsEnv, setGitCredentials } from './git-credentials';

describe('git credentials', () => {
  it('lends git nothing in the core build - the user’s own credentials apply', () => {
    expect(gitCredentialsEnv('/Users/emmaw/code/acme')).toEqual({});
    expect(appSshKeyFiles()).toEqual([]);
  });

  it('serves the registered integrations until they are taken back', () => {
    const undo = setGitCredentials({
      gitEnv: (cwd) => ({ GIT_ASKPASS: `/askpass for ${cwd}` }),
      appSshKeyFiles: () => ['/keys/double0_github_ed25519'],
    });
    expect(gitCredentialsEnv('/a')).toEqual({ GIT_ASKPASS: '/askpass for /a' });
    expect(appSshKeyFiles()).toEqual(['/keys/double0_github_ed25519']);
    undo();
    expect(gitCredentialsEnv('/a')).toEqual({});
    expect(appSshKeyFiles()).toEqual([]);
  });
});
