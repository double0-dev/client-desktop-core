import type * as monaco from 'monaco-editor';
import {
  EmptyFileSystemProvider,
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
} from '@codingame/monaco-vscode-files-service-override';
import { pathOf } from '@renderer/lib/remote-uri';

/**
 * A file's text by path: `window.api.fs.readFile` for this machine,
 * `fs.readFileOnHost` for a host (`hostId`) - wherever the file lies there.
 */
export type DiskReader = (
  path: string,
  hostId: string | null,
) => Promise<{ content?: string; mtimeMs?: number; error?: string; code?: string }>;

function providerError(message: string, code?: string): FileSystemProviderError {
  const kind =
    code === 'ENOENT' || code === 'ENOTDIR'
      ? FileSystemProviderErrorCode.FileNotFound
      : code === 'EISDIR'
        ? FileSystemProviderErrorCode.FileIsADirectory
        : code === 'EACCES' || code === 'EPERM'
          ? FileSystemProviderErrorCode.NoPermissions
          : FileSystemProviderErrorCode.Unavailable;
  return FileSystemProviderError.create(message, kind);
}

/**
 * The last read-only overlay under `file:` (monaco.ts): any file no editor has
 * registered is read off disk through the app's fs IPC.
 *
 * Go-to-definition into a file that is not open (a language server pointing
 * into a dependency, e.g. the Dart server into `~/.pub-cache`) resolves a text
 * model for the target BEFORE `openEditorFunc` hands it to the workspace. With
 * only the open editors' overlay that read failed with "Unable to resolve
 * nonexistent file" - an unhandled rejection reported as a crash (crash report,
 * v0.5.6) - and the jump did nothing.
 */
export class DiskFileProvider extends EmptyFileSystemProvider {
  override capabilities =
    FileSystemProviderCapabilities.FileReadWrite |
    FileSystemProviderCapabilities.PathCaseSensitive |
    FileSystemProviderCapabilities.Readonly;

  constructor(private readonly readDisk: DiskReader) {
    super();
  }

  private async load(resource: monaco.Uri): Promise<{ bytes: Uint8Array; mtimeMs: number }> {
    if (resource.scheme !== 'file') {
      throw FileSystemProviderError.create('Not found', FileSystemProviderErrorCode.FileNotFound);
    }
    // A remote file's path, never its fsPath (a UNC share with an authority),
    // and its host - a definition in the host's `site-packages` lies in no
    // project root, so the path alone would name THIS machine's file.
    const { hostId, path } = pathOf(resource);
    const res = await this.readDisk(path, hostId);
    if (res.content === undefined) {
      throw providerError(res.error ?? 'Could not read file', res.code);
    }
    return { bytes: new TextEncoder().encode(res.content), mtimeMs: res.mtimeMs ?? Date.now() };
  }

  override async stat(resource?: monaco.Uri) {
    const { bytes, mtimeMs } = await this.load(resource!);
    return { type: FileType.File, ctime: mtimeMs, mtime: mtimeMs, size: bytes.byteLength };
  }

  override async readFile(resource?: monaco.Uri): Promise<Uint8Array> {
    return (await this.load(resource!)).bytes;
  }
}
