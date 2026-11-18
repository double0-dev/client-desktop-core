import type * as monaco from 'monaco-editor';
import { RegisteredFileSystemProvider } from '@codingame/monaco-vscode-files-service-override';

/** A Windows drive folder as a file URI path: `/c:`. */
const DRIVE_PATH = /^\/[a-zA-Z]:$/;

/**
 * The read-only overlay that backs open editors' URIs (monaco.ts ›
 * `registerEditorFile`), made to work for Windows paths.
 *
 * `registerFile` creates each parent folder with `mkdirSync`, which looks the
 * new folder's parent up by `dirname`. On Windows a file URI's first segment is
 * the drive (`/c:/Users/…`), and VS Code's file-scheme `dirname` of `/c:` is
 * `/c:` itself - so the drive folder was looked for inside itself, every
 * registration threw "file not found" and no editor mounted (a black pane,
 * 2026-10-28). The provider keys folders by authority + path and ignores the
 * scheme, so the drive folder is made under a scheme whose `dirname` is plain
 * POSIX (`/c:` → `/`) and file URIs find it.
 */
export class EditorFileProvider extends RegisteredFileSystemProvider {
  override mkdirSync(resource: monaco.Uri): ReturnType<RegisteredFileSystemProvider['mkdirSync']> {
    if (resource.scheme === 'file' && DRIVE_PATH.test(resource.path)) {
      return super.mkdirSync(resource.with({ scheme: 'drive-folder' }));
    }
    return super.mkdirSync(resource);
  }
}
