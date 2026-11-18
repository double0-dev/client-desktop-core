import * as monaco from 'monaco-editor';
import { initialize, LogLevel } from '@codingame/monaco-vscode-api';
import { setUnexpectedErrorHandler } from '@codingame/monaco-vscode-api/monaco';
import getConfigurationServiceOverride, {
  initUserConfiguration,
} from '@codingame/monaco-vscode-configuration-service-override';
import getEditorServiceOverride, {
  type OpenEditor,
} from '@codingame/monaco-vscode-editor-service-override';
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override';
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override';
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override';
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override';
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override';
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override';
// The VS Code extension API (`vscode`, an alias of
// @codingame/monaco-vscode-extension-api) with its in-page extension host:
// vscode-languageclient runs against it.
import 'vscode';
import {
  RegisteredReadOnlyFile,
  registerFileSystemOverlay,
} from '@codingame/monaco-vscode-files-service-override';
import {
  getService,
  ILanguageService,
  IUriIdentityService,
  SyncDescriptor,
} from '@codingame/monaco-vscode-api/services';

// Workers as real Vite worker chunks. `?worker` bundles each entry's whole
// import graph - a plain `new URL(...)` would emit (or data:-inline) only the
// tiny entry file, whose relative imports then can't resolve, and Monaco
// silently falls back to main-thread language services.
import EditorWorker from '@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker.js?worker';
import ExtensionHostWorker from '@codingame/monaco-vscode-api/workers/extensionHost.worker?worker';
import TextMateWorker from '@codingame/monaco-vscode-textmate-service-override/worker?worker';
import TsWorker from '@codingame/monaco-vscode-standalone-typescript-language-features/worker?worker';
import JsonWorker from '@codingame/monaco-vscode-standalone-json-language-features/worker?worker';
import CssWorker from '@codingame/monaco-vscode-standalone-css-language-features/worker?worker';
import HtmlWorker from '@codingame/monaco-vscode-standalone-html-language-features/worker?worker';

// TextMate grammars + the default themes the palette bridge builds on. Each
// import self-registers a VS Code default extension with the services started
// below (extended mode tokenizes with these instead of Monarch).
import '@codingame/monaco-vscode-theme-defaults-default-extension';
import '@codingame/monaco-vscode-typescript-basics-default-extension';
import '@codingame/monaco-vscode-javascript-default-extension';
import '@codingame/monaco-vscode-json-default-extension';
import '@codingame/monaco-vscode-css-default-extension';
import '@codingame/monaco-vscode-html-default-extension';
import '@codingame/monaco-vscode-markdown-basics-default-extension';
import '@codingame/monaco-vscode-python-default-extension';
import '@codingame/monaco-vscode-yaml-default-extension';
import '@codingame/monaco-vscode-shellscript-default-extension';
import '@codingame/monaco-vscode-java-default-extension';
import '@codingame/monaco-vscode-swift-default-extension';
import '@codingame/monaco-vscode-rust-default-extension';
import '@codingame/monaco-vscode-cpp-default-extension';
import '@codingame/monaco-vscode-dart-default-extension';
import '@codingame/monaco-vscode-php-default-extension';

// The classic monaco-editor language workers (IntelliSense for TS/JS, JSON,
// CSS, HTML with no language server involved) - self-registering.
import { getTypeScriptWorker } from '@codingame/monaco-vscode-standalone-typescript-language-features';
import { jsonDefaults } from '@codingame/monaco-vscode-standalone-json-language-features';
import '@codingame/monaco-vscode-standalone-css-language-features';
import '@codingame/monaco-vscode-standalone-html-language-features';

/**
 * JSON is the one standalone package that also ships a TOKENIZER: on first use
 * of the language it calls `setTokensProvider('json', …)` with monaco's legacy
 * (pre-TextMate) JSON tokenizer, which REPLACES the TextMate grammar from
 * json-default-extension in the shared tokenization registry - last writer
 * wins, and the two register in a race. Its token types (`string.value.json`,
 * `delimiter.colon.json`, …) are legacy names that this stack's themes, which
 * colour by TextMate scope, match nothing for - so whenever it won the race
 * every JSON buffer (editor tabs, the Settings-as-JSON dialog, diffs) rendered
 * in one flat foreground colour. Turning its `tokens` mode off leaves the
 * TextMate grammar in place; the rest of its features (completion, validation,
 * hover, formatting) are untouched.
 */
jsonDefaults.setModeConfiguration({ ...jsonDefaults.modeConfiguration, tokens: false });

import { registerExtension, ExtensionHostKind } from '@codingame/monaco-vscode-api/extensions';
// Kotlin has no VS Code built-in grammar (no default-extension package):
// vendored from tm-grammars@1.32.2 (MIT collection; see the package's NOTICE
// for the grammar's upstream license).
import kotlinGrammarUrl from '@renderer/lib/monaco/kotlin.tmLanguage.json?url';

import { DiskFileProvider } from '@renderer/lib/monaco/disk-file-provider';
import { editorOpenTarget, type EditorOpenTarget } from '@renderer/lib/monaco/editor-open-target';
import { currentHostOfPath } from '@renderer/lib/hosts/host-of-path';
import { withActiveWorkspace } from '@renderer/lib/search/search-workspace-bridge';
import { requestEditorReveal } from '@renderer/lib/workspace/editor-reveal';
import { EditorFileProvider } from '@renderer/lib/monaco/editor-file-provider';
import { HostAwareUriIdentityService } from '@renderer/lib/monaco/host-uri-identity';
import { startMonacoThemeSync } from '@renderer/lib/monaco/monaco-theme';
import { markMonacoLoaded } from '@renderer/lib/monaco/monaco-loaded';

export {
  attachLanguageClient,
  retryHostLanguageClients,
  retryLanguageClients,
} from '@renderer/lib/monaco/lsp-manager';

/**
 * The one place the Monaco / monaco-vscode-api stack is imported and started.
 * Everything in this directory is reached ONLY via dynamic import (see
 * monaco-editor.tsx), so the multi-megabyte editor stack stays out of the app
 * chunk until the first editor tab opens. Elsewhere in the renderer, import
 * monaco types as `import type * as monaco from 'monaco-editor'`.
 *
 * The npm alias makes 'monaco-editor' resolve to
 * `@codingame/monaco-vscode-editor-api` - the same editor built from VS Code
 * sources that the service overrides below run. All
 * `@codingame/monaco-vscode-*` packages (and the `vscode` alias) are
 * version-locked to each other: bump them together - a second copy of the api
 * package throws at load (see a private plan).
 */

/** Per-label worker constructors: editor core + extension host + TextMate
 * tokenizer + the standalone language services. All same-origin chunks - the
 * production CSP (script-src 'self') blocks inline/blob/data workers. */
const WORKER_CTORS: Record<string, (new () => Worker) | undefined> = {
  editorWorkerService: EditorWorker,
  extensionHostWorkerMain: ExtensionHostWorker,
  TextMateWorker,
  typescript: TsWorker,
  javascript: TsWorker,
  json: JsonWorker,
  css: CssWorker,
  scss: CssWorker,
  less: CssWorker,
  html: HtmlWorker,
  handlebars: HtmlWorker,
  razor: HtmlWorker,
};

function configureWorkers(): void {
  const env = (globalThis.MonacoEnvironment ??= {});
  env.getWorker = (_moduleId: string, label: string): Worker => {
    const Ctor = WORKER_CTORS[label];
    if (!Ctor) throw new Error(`No worker registered for label '${label}'`);
    return new Ctor();
  };
}

/** VS Code's file service knows nothing about the app's fs IPC; without an
 * overlay, any service that resolves an open file's URI (editor tracking,
 * model references) errors with "Unable to resolve nonexistent file". Each
 * mounted editor registers its file here with a live content reader. */
const fileProvider = new EditorFileProvider(/* readonly */ true);
let overlayInstalled = false;

export function registerEditorFile(
  uri: monaco.Uri,
  readContent: () => string,
): { dispose(): void } {
  if (!overlayInstalled) {
    overlayInstalled = true;
    registerFileSystemOverlay(1, fileProvider);
    // Below every other overlay: a file no editor holds (go-to-definition
    // into a dependency) is read off disk instead of failing the jump.
    // A host's file comes from that host, wherever it lies there (plan 29 ›
    // M9: a definition in its `site-packages` is in no project root).
    registerFileSystemOverlay(
      -1,
      new DiskFileProvider((path, hostId) =>
        hostId ? window.api.fs.readFileOnHost(hostId, path) : window.api.fs.readFile(path),
      ),
    );
  }
  const encoder = new TextEncoder();
  const initial = encoder.encode(readContent());
  return fileProvider.registerFile(
    new RegisteredReadOnlyFile(uri, async () => encoder.encode(readContent()), initial.byteLength),
  );
}

/**
 * Monaco language id for a file path, or undefined when nothing matches.
 *
 * Asks VS Code's language service, the same detection an editor model gets
 * from its `file://` URI - so extensions, bare filenames (`Dockerfile`,
 * `Makefile`) and filename patterns all resolve. NOT
 * `monaco.languages.getLanguages()`: that reads the *standalone* modes
 * registry, which in this extended-mode setup holds only `plaintext` -
 * every real language arrives through extension contributions instead, so
 * matching against it silently returned undefined for every file.
 */
export async function languageIdForPath(path: string): Promise<string | undefined> {
  const languageService = await getService(ILanguageService);
  const id = languageService.guessLanguageIdByFilepathOrFirstLine(monaco.Uri.file(path));
  return id && id !== 'plaintext' ? id : undefined;
}

/** Theme-styled HTML for a block of code (`mtk*` token spans styled by the
 * global Monaco theme CSS) - the Changes diff renders its rows from this. */
export function colorizeText(text: string, languageId: string): Promise<string> {
  return monaco.editor.colorize(text, languageId, { tabSize: 2 });
}

/**
 * Where "open this file" requests from inside Monaco land (go-to-definition
 * into a file that isn't open, link clicks, …): the active session's
 * workspace by default, which opens (or focuses) an editor tab - a host's
 * file outside its projects with the host kept (editor-open-target.ts).
 */
type FileOpener = (target: EditorOpenTarget) => void;

const openInActiveWorkspace: FileOpener = (target) => {
  withActiveWorkspace((a) =>
    a.openFile(target.path, target.hostId ? { hostId: target.hostId } : {}),
  );
};

let fileOpener: FileOpener = openInActiveWorkspace;

/** Replace the opener (null = back to the active workspace's). */
export function setMonacoFileOpener(opener: FileOpener | null): void {
  fileOpener = opener ?? openInActiveWorkspace;
}

const openEditorFunc: OpenEditor = async (modelRef, options) => {
  try {
    const uri = modelRef.object.textEditorModel?.uri;
    const target = uri ? editorOpenTarget(uri, currentHostOfPath) : null;
    if (target) {
      // The jump's line, taken by the tab once its editor is ready.
      const selection = (
        options as { selection?: { startLineNumber?: number; startColumn?: number } }
      )?.selection;
      if (selection?.startLineNumber) {
        requestEditorReveal(target.path, {
          line: selection.startLineNumber,
          column: selection.startColumn,
        });
      }
      fileOpener(target);
    }
  } finally {
    modelRef.dispose();
  }
  // The file opens (or focuses) as a workspace editor tab; there is no
  // directly-created ICodeEditor to hand back.
  return undefined;
};

let startPromise: Promise<typeof monaco> | null = null;

/** Idempotent bootstrap of the monaco-vscode services. Resolves with the
 * monaco namespace once editors can be created. */
export function initMonaco(): Promise<typeof monaco> {
  startPromise ??= start();
  return startPromise;
}

async function start(): Promise<typeof monaco> {
  configureWorkers();
  await initUserConfiguration(
    JSON.stringify({
      // Overridden by the palette bridge right after start; a sane default
      // avoids a flash of unthemed editor on the very first paint.
      'workbench.colorTheme': 'Default Dark Modern',
      // UI-thread tokenization (same as the CodeMirror editor this replaced):
      // the async TextMate-worker path breaks under Vite chunking - its
      // state-stack diff protocol throws applyStateStackDiff TypeErrors and
      // token colors never render.
      'editor.experimental.asyncTokenization': false,
    }),
  );

  // Kotlin, registered like the default-extension grammars but from our
  // vendored TextMate file - real highlighting, and the language id LSP
  // attachment keys off.
  const kotlinExt = registerExtension(
    {
      name: 'kotlin-grammar',
      publisher: 'double0',
      version: '1.0.0',
      engines: { vscode: '*' },
      contributes: {
        languages: [{ id: 'kotlin', extensions: ['.kt', '.kts'], aliases: ['Kotlin'] }],
        grammars: [
          { language: 'kotlin', scopeName: 'source.kotlin', path: './kotlin.tmLanguage.json' },
        ],
      },
    },
    ExtensionHostKind.LocalProcess,
  );
  kotlinExt.registerFileUrl('./kotlin.tmLanguage.json', kotlinGrammarUrl);

  // The services an editor-only (no workbench) setup needs: TextMate
  // tokenization + VS Code themes over the default extensions' grammars, an
  // editor service whose "open this file" lands in a workspace tab, and the
  // in-page extension host vscode-languageclient talks to.
  await initialize(
    {
      ...getConfigurationServiceOverride(),
      ...getLogServiceOverride(),
      ...getModelServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getThemeServiceOverride(),
      ...getEditorServiceOverride(openEditorFunc),
      // A host's file URIs carry an authority, which VS Code's stock
      // canonicalisation folds into the path on a POSIX client - every
      // diagnostic for a host file was lost (host-uri-identity.ts).
      [IUriIdentityService.toString()]: new SyncDescriptor(HostAwareUriIdentityService, [], true),
      ...getExtensionServiceOverride({ enableWorkerExtensionHost: false }),
    },
    undefined,
    {
      workspaceProvider: {
        trusted: true,
        workspace: { workspaceUri: monaco.Uri.file('/workspace.code-workspace') },
        // The app never opens another VS Code window.
        open: async () => false,
      },
      developmentOptions: { logLevel: LogLevel.Warning },
    },
  );
  // VS Code reports its own unexpected errors here; they are not the app's.
  setUnexpectedErrorHandler((error) => console.warn('[monaco] unexpected error', error));
  startMonacoThemeSync();
  markMonacoLoaded();
  return monaco;
}

let warmedUp = false;

/**
 * Deep idle-time warmup (editor-layer.tsx): beyond initMonaco, the FIRST real
 * editor pays first-`create` service wiring, TextMate + oniguruma-wasm
 * startup on first tokenization, and the TypeScript worker spawn. A
 * throwaway hidden editor with a tiny TS model forces all of that now, so
 * the first file the user opens skips the lot. Best-effort - any failure
 * just means the first open pays the original cost.
 */
export async function warmupMonaco(): Promise<void> {
  const m = await initMonaco();
  if (warmedUp) return;
  warmedUp = true;
  try {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:120px;';
    document.body.appendChild(host);
    const uri = m.Uri.file('/__monaco-warmup__/warmup.ts');
    const model =
      m.editor.getModel(uri) ?? m.editor.createModel('const warmup: number = 1;\n', undefined, uri);
    const overlay = registerEditorFile(uri, () => model.getValue());
    const editor = m.editor.create(host, {
      model,
      dimension: { width: 320, height: 120 },
    });
    // Let tokenization kick off, then force the TS worker to spawn. (Through
    // the package's own export: it never registers `languages.typescript` on
    // this editor build, so reading it there found nothing.)
    await new Promise((resolve) => setTimeout(resolve, 300));
    await getTypeScriptWorker()
      .then((worker) => worker(uri))
      .catch(() => {});
    editor.dispose();
    model.dispose();
    overlay.dispose();
    host.remove();
  } catch {
    // best-effort
  }
}
