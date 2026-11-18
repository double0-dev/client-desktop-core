import { afterEach, describe, expect, it, vi } from 'vitest';

// VS Code's `isWindows` is fixed when its platform module is evaluated: from
// `process.platform` wherever a Node `process` exists (here, under vitest), else
// from the user agent (the app's renderer). Each case fakes the platform for
// that one evaluation and imports the stack afresh - so the Windows case runs
// the same on a macOS / Linux machine as on Windows.
async function load(platform: NodeJS.Platform) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  try {
    vi.resetModules();
    const { URI } = await import('@codingame/monaco-vscode-api/vscode/vs/base/common/uri');
    const { RegisteredFileSystemProvider, RegisteredReadOnlyFile } =
      await import('@codingame/monaco-vscode-files-service-override');
    const { EditorFileProvider } = await import('./editor-file-provider');
    return { URI, RegisteredFileSystemProvider, RegisteredReadOnlyFile, EditorFileProvider };
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

// The first import transforms the VS Code module graph cold (~5 s).
describe('EditorFileProvider', { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('registers a file on a Windows drive, which the stock provider refuses', async () => {
    const { URI, RegisteredFileSystemProvider, RegisteredReadOnlyFile, EditorFileProvider } =
      await load('win32');
    const uri = URI.file('C:\\Users\\emmaw\\production-pipeline\\src\\app.ts');
    expect(uri.path).toMatch(/^\/[cC]:\/Users\//);
    const file = () => new RegisteredReadOnlyFile(uri, async () => bytes('hi'), 2);

    // The bug: the drive folder `/c:` is its own dirname on Windows, so every
    // editor's registration threw and the pane stayed black.
    expect(() => new RegisteredFileSystemProvider(true).registerFile(file())).toThrow(
      /file not found/,
    );

    const provider = new EditorFileProvider(true);
    const registration = provider.registerFile(file());
    expect((await provider.stat(uri)).size).toBe(2);
    expect(new TextDecoder().decode(await provider.readFile(uri))).toBe('hi');

    // A second file on the same drive reuses the folders made for the first.
    const other = URI.file('C:\\Users\\emmaw\\production-pipeline\\README.md');
    provider.registerFile(new RegisteredReadOnlyFile(other, async () => bytes('x'), 1));
    expect((await provider.stat(other)).size).toBe(1);

    // Closing and reopening the editor registers the same path again.
    registration.dispose();
    expect(() => provider.registerFile(file())).not.toThrow();
  });

  it.each(['darwin', 'linux'] as const)('keeps POSIX paths working on %s', async (platform) => {
    const { URI, RegisteredReadOnlyFile, EditorFileProvider } = await load(platform);
    const uri = URI.file('/home/emmaw/production-pipeline/src/app.ts');
    const provider = new EditorFileProvider(true);
    provider.registerFile(new RegisteredReadOnlyFile(uri, async () => bytes('hi'), 2));
    expect((await provider.stat(uri)).size).toBe(2);
  });

  // Remote sessions (lib/remote-uri.ts): the host is the URI authority, so two
  // hosts' identical paths are two registered files, never one.
  it('keeps the same path on two hosts apart', async () => {
    const { URI, RegisteredReadOnlyFile, EditorFileProvider } = await load('darwin');
    const path = '/home/emmaw/acme/src/app.ts';
    const a = URI.from({ scheme: 'file', authority: 'd0-host.build-box', path });
    const b = URI.from({ scheme: 'file', authority: 'd0-host.other-box', path });
    const provider = new EditorFileProvider(true);
    provider.registerFile(new RegisteredReadOnlyFile(a, async () => bytes('a'), 1));
    provider.registerFile(new RegisteredReadOnlyFile(b, async () => bytes('bb'), 2));
    expect((await provider.stat(a)).size).toBe(1);
    expect((await provider.stat(b)).size).toBe(2);
  });
});
