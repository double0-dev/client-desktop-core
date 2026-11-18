import { describe, expect, it } from 'vitest';
import { canOpenInIde, canShowInFolder, canUseLanguageServer } from './remote-capabilities';

const ALL = {
  canShowInFolder,
  canOpenInIde,
  canUseLanguageServer: (hostId: string | null | undefined) => canUseLanguageServer(hostId),
};

describe('remote capabilities', () => {
  // Local behaviour must not change: a null / absent host allows everything.
  it.each(Object.entries(ALL))('%s allows every local path', (_name, can) => {
    expect(can(null)).toBe(true);
    expect(can(undefined)).toBe(true);
    expect(can('')).toBe(true);
  });

  it.each(Object.entries(ALL))('%s is off for a path on a host', (_name, can) => {
    expect(can('build-box')).toBe(false);
  });

  // Plan 29 › M6: runtime agents run in the host's daemon and previews read
  // host files - neither surface is gated by a predicate any more.
  it('has no predicate for runtime agents or file previews', async () => {
    const mod: Record<string, unknown> = await import('./remote-capabilities');
    expect(mod.canRunChatAgents).toBeUndefined();
    expect(mod.canPreviewFiles).toBeUndefined();
  });

  // Plan 29 › M8: the explorer's drop target serves every root, local and remote.
  it('has no predicate for dropping local files', async () => {
    const mod: Record<string, unknown> = await import('./remote-capabilities');
    expect(mod.canDropLocalFiles).toBeUndefined();
  });

  // Plan 29 › M9: a host's language servers follow its daemon's `lsp` cap -
  // an older runtime keeps the MVP state (no server, no banner).
  it('allows a language server on a host only when its daemon announces lsp', () => {
    expect(canUseLanguageServer('build-box', ['remote', 'files', 'lsp'])).toBe(true);
    expect(canUseLanguageServer('build-box', ['remote', 'files', 'usage'])).toBe(false);
    expect(canUseLanguageServer('build-box', null)).toBe(false);
    expect(canUseLanguageServer(null, null)).toBe(true);
  });
});
