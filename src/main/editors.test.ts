import { describe, expect, it, vi } from 'vitest';

const { editorHandlers } = vi.hoisted(() => ({
  editorHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      editorHandlers.set(channel, fn);
    },
    removeHandler: vi.fn(),
  },
}));
vi.mock('./ipc-util', () => ({ isTrustedSender: () => true }));

const { resolveLinuxCommand, registerEditorsIpc } = await import('./editors');

describe('resolveLinuxCommand', () => {
  it('takes the first launcher found on PATH', async () => {
    // Linux had no "Open in" at all: detection only knew macOS app bundles.
    const onPath = new Map([
      ['intellij-idea-community', '/snap/bin/intellij-idea-community'],
      ['idea.sh', '/opt/idea/bin/idea.sh'],
    ]);
    const find = vi.fn(async (bin: string) => onPath.get(bin) ?? null);
    await expect(
      resolveLinuxCommand(['idea', 'intellij-idea-community', 'idea.sh'], find),
    ).resolves.toBe('/snap/bin/intellij-idea-community');
    // Stops at the first hit.
    expect(find).not.toHaveBeenCalledWith('idea.sh');
  });

  it('finds nothing for an editor with no Linux launcher or none installed', async () => {
    const find = async () => null;
    await expect(resolveLinuxCommand([], find)).resolves.toBeNull();
    await expect(resolveLinuxCommand(['code'], find)).resolves.toBeNull();
  });
});

describe('editors:open on a remote host', () => {
  it('refuses a folder that lives on a remote host - it is not on this machine', async () => {
    const { localRuntime, setRuntimeResolver } = await import('./host-runtime');
    const restore = setRuntimeResolver((path) =>
      path?.startsWith('/home/emmaw/acme')
        ? { ...localRuntime, remote: { hostId: 'build-box' } }
        : localRuntime,
    );
    const dispose = registerEditorsIpc();
    try {
      expect(
        await editorHandlers.get('editors:open')!(
          {},
          { editorId: 'vscode', path: '/home/emmaw/acme' },
        ),
      ).toEqual({ error: 'That folder is on a remote host' });
    } finally {
      dispose();
      restore();
    }
  });
});
