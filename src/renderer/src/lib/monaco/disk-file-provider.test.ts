import { describe, expect, it, vi } from 'vitest';
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import {
  FileSystemProviderCapabilities,
  FileSystemProviderErrorCode,
  OverlayFileSystemProvider,
  RegisteredReadOnlyFile,
} from '@codingame/monaco-vscode-files-service-override';
import { DiskFileProvider, type DiskReader } from './disk-file-provider';
import { EditorFileProvider } from './editor-file-provider';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

const OPEN = URI.file('/Users/emmaw/production-pipeline/lib/main.dart');
const DEPENDENCY = URI.file(
  '/Users/emmaw/.pub-cache/hosted/pub.dev/acme-1.0.0/lib/src/monitor.dart',
);

/** The `file:` overlay stacked the way monaco.ts stacks it. */
function stack(read: DiskReader) {
  const overlay = new OverlayFileSystemProvider();
  const editors = new EditorFileProvider(true);
  editors.registerFile(new RegisteredReadOnlyFile(OPEN, async () => bytes('unsaved'), 7));
  overlay.register(1, editors);
  overlay.register(-1, new DiskFileProvider(read));
  return overlay;
}

// The first import transforms the VS Code module graph cold (~5 s).
describe('DiskFileProvider', { timeout: 60_000 }, () => {
  it('serves a file no editor holds from disk, so go-to-definition into it resolves', async () => {
    const read = vi.fn<DiskReader>(async () => ({ content: 'class Monitor {}', mtimeMs: 42 }));
    const overlay = stack(read);

    // The bug: only the open editors' overlay answered, so resolving the
    // definition's model threw "Unable to resolve nonexistent file".
    const stat = await overlay.stat(DEPENDENCY);
    expect(stat).toMatchObject({ size: 16, mtime: 42 });
    expect(text(await overlay.readFile(DEPENDENCY))).toBe('class Monitor {}');
    expect(read).toHaveBeenCalledWith(DEPENDENCY.fsPath, null);
  });

  it('never shadows an open editor, whose buffer may be ahead of the disk', async () => {
    const read = vi.fn<DiskReader>(async () => ({ content: 'on disk', mtimeMs: 1 }));
    const overlay = stack(read);

    expect(text(await overlay.readFile(OPEN))).toBe('unsaved');
    expect(read).not.toHaveBeenCalled();
  });

  it('maps fs error codes to provider errors', async () => {
    const provider = (code: string) => new DiskFileProvider(async () => ({ error: 'nope', code }));
    const codeOf = (p: DiskFileProvider) =>
      p.readFile(DEPENDENCY).then(
        () => 'resolved',
        (err: { code?: string }) => err.code,
      );

    expect(await codeOf(provider('ENOENT'))).toBe(FileSystemProviderErrorCode.FileNotFound);
    expect(await codeOf(provider('EACCES'))).toBe(FileSystemProviderErrorCode.NoPermissions);
    expect(await codeOf(provider('EISDIR'))).toBe(FileSystemProviderErrorCode.FileIsADirectory);
    expect(await codeOf(provider('TOO_LARGE'))).toBe(FileSystemProviderErrorCode.Unavailable);
  });

  it('is read-only, so the overlay never writes through it', () => {
    const provider = new DiskFileProvider(async () => ({ content: '' }));
    const readonly = FileSystemProviderCapabilities.Readonly;
    expect(provider.capabilities & readonly).toBe(readonly);
  });

  // A remote file's fsPath is a UNC share (`//build-box/...`): the disk read
  // must get the host path itself AND the host - a language server's jump
  // into the host's `site-packages` lies in no project root, so main could
  // not tell the host from the path (plan 29 › M9).
  it('reads a remote file by its path and host, not its fsPath', async () => {
    const read = vi.fn<DiskReader>(async () => ({ content: 'x', mtimeMs: 1 }));
    const overlay = stack(read);
    const remote = URI.from({
      scheme: 'file',
      authority: 'd0-host.build-box',
      path: '/home/emmaw/a.ts',
    });
    expect(text(await overlay.readFile(remote))).toBe('x');
    expect(read).toHaveBeenCalledWith('/home/emmaw/a.ts', 'build-box');
  });
});
