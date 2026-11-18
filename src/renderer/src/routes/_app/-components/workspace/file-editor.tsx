import { useCallback, useEffect, useRef, useState } from 'react';
import { FileWarning, Loader2 } from 'lucide-react';

import { useWorkspaceLayout } from '@renderer/lib/workspace/layout-context';
import { useGitOptional } from '@renderer/lib/git/context';
import {
  bannerInfoFor,
  dismissLanguagePrompt,
  ensureHostLanguageServers,
  installLanguageServer,
  lsKey,
  useLanguageServers,
} from '@renderer/lib/language-server-store';
import { currentHostOfPath } from '@renderer/lib/hosts/host-of-path';
import { onHostConnected, useHostStatus } from '@renderer/lib/hosts/host-status';
import { useHosts } from '@renderer/lib/hosts/host-directory';
import { canUseLanguageServer } from '@renderer/lib/session/remote-capabilities';
import type { GitGutterBase } from '@renderer/lib/monaco/monaco-git-gutter';
import { MonacoEditorView, type MonacoEditorHandle } from '@renderer/components/monaco-editor';
import { subscribeEditorReveal, takeEditorReveal } from '@renderer/lib/workspace/editor-reveal';
import { alertDialog, confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { cn, fileName } from '@renderer/lib/utils';
import type { TabId } from '@renderer/lib/workspace/layout';
import { registerEditorFocus } from '@renderer/lib/workspace/surface-focus';

/**
 * Heuristic for a non-UTF-8 file that decoded with replacement chars (U+FFFD):
 * editing and saving it would write the mangled text back over the original
 * bytes, so such files open read-only. A couple of stray � are tolerated (the
 * char itself is legal UTF-8); more than that near the start means a bad decode.
 */
function looksGarbled(text: string): boolean {
  let count = 0;
  const probe = text.slice(0, 64 * 1024);
  for (let i = 0; i < probe.length; i++) {
    if (probe.charCodeAt(i) === 0xfffd && ++count > 2) return true;
  }
  return false;
}

/** The editor holds LF-normalized text (Monaco normalizes at model creation);
 * disk text is normalized the same way before any saved-vs-live comparison. */
function normalizeEol(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

const NOTICE_ACTION =
  'shrink-0 whitespace-nowrap rounded-sm border border-border-strong px-1.5 py-0.5 text-foreground-muted outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground';

/**
 * A single file open in a Monaco editor. The file is read once on mount (and
 * when its path changes - the editor is keyed by path); edits live in the
 * Monaco model and are persisted to disk on ⌘/Ctrl-S. The tab's dirty flag
 * (driving the strip's dot) is reported up through the workspace context so it
 * survives the editor scrolling out of an inactive pane. Language detection is
 * by file extension off the model's file:// URI; unknown extensions render as
 * plain text.
 */
export function FileEditor({
  filePath,
  hostId: foreignHost = null,
  tabId,
  active,
  className,
}: {
  filePath: string;
  /**
   * A host's file outside every project root there (an editor jump into its
   * `site-packages`, plan 29 › M9): read through that host, never editable.
   * Null for every other file - its machine follows from its path.
   */
  hostId?: string | null;
  tabId: TabId;
  /** This editor's tab is the active one in the active pane (drives focus). */
  active: boolean;
  className?: string;
}) {
  const { setTabDirty, closeEditorsUnder } = useWorkspaceLayout();
  const handleRef = useRef<MonacoEditorHandle>(null);
  // Let ⇧⌘→ (focus back into the surface from a sidebar) reach this editor.
  useEffect(() => registerEditorFocus(tabId, () => handleRef.current?.focus()), [tabId]);
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'binary'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  // The Monaco editor behind the ready status mounts asynchronously (the
  // editor stack lazy-loads); gates the effects that talk to it.
  const [editorReady, setEditorReady] = useState(false);
  // The file changed on disk under our unsaved edits (or a save hit a conflict);
  // the status row offers Overwrite / Reload instead of clobbering either side.
  const [conflict, setConflict] = useState(false);
  // Garbled decode (see `looksGarbled`): the buffer is shown but not editable.
  const [readOnly, setReadOnly] = useState(false);
  // The on-disk content (LF-normalized); edits are dirty until they match again.
  const savedRef = useRef('');
  // Mirror of the dirty flag, read inside the (stable) file-watch subscription.
  const dirtyRef = useRef(false);
  // The mtime of the content in `savedRef` - sent with saves so a file that
  // changed on disk in between fails with CONFLICT instead of being clobbered.
  const mtimeRef = useRef<number | undefined>(undefined);
  // Latest git gutter base, re-applied when the editor comes up after it.
  const gitBaseRef = useRef<GitGutterBase | null>(null);

  const hasBridge = typeof window !== 'undefined' && !!window.api?.fs;
  // The machine the file is on: the tab's host for a file outside the
  // projects, else the host its path lies under (null = this computer).
  const machine = foreignHost ?? currentHostOfPath(filePath);
  const machineStatus = useHostStatus(machine);
  const hosts = useHosts();
  const machineLabel = machine ? (hosts.find((h) => h.id === machine)?.label ?? machine) : null;
  const read = useCallback(
    (path: string) =>
      foreignHost
        ? window.api!.fs.readFileOnHost(foreignHost, path)
        : window.api!.fs.readFile(path),
    [foreignHost],
  );

  // Bumped to read again: a file on a host that failed to load while the host
  // was away (a tab restored before its host connected) loads once it is
  // connected. Only a FAILED load retries - a loaded buffer may hold edits.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    if (!machine) return;
    return onHostConnected((hostId) => {
      if (hostId === machine && statusRef.current === 'error') setLoadAttempt((n) => n + 1);
    });
  }, [machine]);

  // Read the file (re-runs only if the path changes - paths are stable per tab -
  // or a failed read is retried above).
  useEffect(() => {
    if (!hasBridge) {
      setStatus('error');
      setErrorMsg('File editing runs in the double0 desktop app.');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setEditorReady(false);
    read(filePath).then((res) => {
      if (cancelled) return;
      if (res.code === 'BINARY') {
        setStatus('binary');
      } else if (res.error) {
        setErrorMsg(res.error);
        setStatus('error');
      } else {
        const text = res.content ?? '';
        savedRef.current = normalizeEol(text);
        mtimeRef.current = res.mtimeMs;
        dirtyRef.current = false;
        setReadOnly(!!foreignHost || looksGarbled(text));
        setConflict(false);
        setContent(text);
        setStatus('ready');
        setTabDirty(tabId, false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, hasBridge, tabId, setTabDirty, read, foreignHost, loadAttempt]);

  const save = useCallback(
    (opts?: { overwrite?: boolean }) => {
      if (!hasBridge || readOnly) return;
      const value = handleRef.current?.getValue();
      if (value == null) return;
      // `overwrite` (the conflict bar's action) skips the mtime check on purpose.
      const expected = opts?.overwrite ? undefined : mtimeRef.current;
      window.api!.fs.writeFile(filePath, value, expected).then((res) => {
        if (res.code === 'CONFLICT') {
          // The file changed on disk since we read it - nothing was written.
          setConflict(true);
          return;
        }
        if (res.error) {
          void alertDialog({
            title: 'Could not save',
            description: `${fileName(filePath)}: ${res.error}`,
          });
          return;
        }
        savedRef.current = value;
        mtimeRef.current = res.mtimeMs;
        setConflict(false);
        // Keystrokes may have landed while the write was in flight - only mark
        // the tab clean if the live doc still matches what was just written.
        const live = handleRef.current?.getValue();
        const stillDirty = live != null && live !== value;
        dirtyRef.current = stillDirty;
        setTabDirty(tabId, stillDirty);
      });
    },
    [filePath, tabId, hasBridge, readOnly, setTabDirty],
  );
  // Read the freshest save() inside stable callbacks/subscriptions.
  const saveRef = useRef(save);
  saveRef.current = save;

  // Adopt on-disk text as the new baseline: swap it into the live editor when
  // one exists (undo-preserving), otherwise reseed the mount text.
  const adoptDiskText = useCallback(
    (text: string) => {
      const normalized = handleRef.current?.replaceText(text);
      savedRef.current = normalized ?? normalizeEol(text);
      setReadOnly(!!foreignHost || looksGarbled(text));
      setContent(text);
    },
    [foreignHost],
  );

  // The conflict bar's "Reload from disk": replace the buffer with the on-disk
  // content. Discards unsaved edits, so those are confirmed away first.
  const reloadFromDisk = useCallback(async () => {
    if (!hasBridge) return;
    if (dirtyRef.current) {
      const ok = await confirmDialog({
        title: 'Reload from disk?',
        description: `Your unsaved changes to ${fileName(filePath)} will be lost.`,
        confirmLabel: 'Reload',
        destructive: true,
      });
      if (!ok) return;
    }
    const res = await read(filePath);
    if (res.error) {
      void alertDialog({
        title: 'Could not reload',
        description: `${fileName(filePath)}: ${res.error}`,
      });
      return;
    }
    adoptDiskText(res.content ?? '');
    mtimeRef.current = res.mtimeMs;
    dirtyRef.current = false;
    setConflict(false);
    setTabDirty(tabId, false);
  }, [filePath, tabId, hasBridge, setTabDirty, adoptDiskText, read]);

  const onChange = useCallback(
    (value: string) => {
      const dirty = value !== savedRef.current;
      dirtyRef.current = dirty;
      setTabDirty(tabId, dirty);
    },
    [tabId, setTabDirty],
  );

  // Keep this editor in sync with on-disk changes (made outside the app). When our
  // file changes: reload it if the user has no unsaved edits; if it was deleted,
  // drop the tab (again, only when clean - otherwise keep it so edits can be saved
  // back). With unsaved edits the buffer is left alone and the conflict bar comes
  // up instead. Our own saves also fire this, but reconcile to a no-op.
  useEffect(() => {
    const fs = window.api?.fs;
    // A host file outside the projects is watched by no tree watch - and a
    // local path that happens to match must never reload it.
    if (!fs?.onChanged || foreignHost) return;
    return fs.onChanged((_root, paths) => {
      if (!paths.includes(filePath)) return;
      void fs.readFile(filePath).then((res) => {
        if (res.error) {
          if (res.code === 'ENOENT' && !dirtyRef.current) closeEditorsUnder(filePath);
          return;
        }
        const text = res.content ?? '';
        const incoming = normalizeEol(text);
        if (!dirtyRef.current) {
          // Clean: adopt the on-disk content (and its mtime, so the conflict
          // baseline stays current even when only the mtime changed).
          mtimeRef.current = res.mtimeMs;
          if (incoming !== savedRef.current) {
            adoptDiskText(text);
            setTabDirty(tabId, false);
          }
          setConflict(false);
        } else if (incoming !== savedRef.current) {
          setConflict(true);
        }
      });
    });
  }, [filePath, tabId, closeEditorsUnder, setTabDirty, adoptDiskText, foreignHost]);

  // The editor mounted behind the ready status: its model normalized EOLs at
  // creation, so re-baseline the saved snapshot on the normalized text.
  const onEditorReady = useCallback((normalizedText: string) => {
    if (!dirtyRef.current) savedRef.current = normalizedText;
    setEditorReady(true);
    if (gitBaseRef.current) handleRef.current?.setGitBase(gitBaseRef.current);
  }, []);

  // A caret position asked for this file (a terminal file link with a line):
  // taken once the editor is ready, and at once for later requests while open.
  useEffect(() => {
    if (!editorReady) return;
    const apply = (): void => {
      const position = takeEditorReveal(filePath);
      if (position) handleRef.current?.revealPosition(position.line, position.column);
    };
    apply();
    return subscribeEditorReveal(apply);
  }, [editorReady, filePath]);

  // Feed the gutter its diff base (the file's INDEX version) - refreshed when
  // the repo state moves (stage/unstage/commit change the index, and the
  // provider's status identity changes on every git/fs tick). Outside a
  // GitProvider (detached windows) or outside a repo the gutter stays off.
  const gitCtx = useGitOptional();
  const gitStatus = gitCtx?.status;
  // A host file outside the projects has no repo of the session's.
  const loadFileBase = gitCtx?.cwd != null && !foreignHost ? gitCtx.loadFileBase : null;

  // "Language support available" banner: this file's extension maps to an
  // installable-but-missing server (see language-server-store.ts) ON THE
  // FILE'S MACHINE - a host's file asks that host's list and installs there,
  // never here; a host whose daemon predates `lsp` gets no banner. The
  // conflict / read-only notices take precedence - at most one notice row.
  const lsState = useLanguageServers();
  const lsMachineOk = canUseLanguageServer(machine, machineStatus?.caps);
  useEffect(() => {
    if (machine && lsMachineOk) ensureHostLanguageServers(machine);
  }, [machine, lsMachineOk]);
  const lsBanner = lsMachineOk ? bannerInfoFor(lsState, filePath, machine) : null;
  const lsProgress = lsBanner ? lsState.progress[lsKey(machine, lsBanner.id)] : undefined;
  const lsError = lsBanner ? lsState.errors[lsKey(machine, lsBanner.id)] : undefined;
  useEffect(() => {
    if (status !== 'ready' || !editorReady) return;
    let live = true;
    const apply = (base: GitGutterBase): void => {
      if (!live) return;
      gitBaseRef.current = base;
      handleRef.current?.setGitBase(base);
    };
    if (!loadFileBase) {
      apply({ kind: 'off' });
    } else {
      void loadFileBase(filePath).then((r) => {
        if (!live) return;
        if (r.error || r.binary) apply({ kind: 'off' });
        else if (r.content == null) apply({ kind: 'new' });
        else apply({ kind: 'content', text: r.content });
      });
    }
    return () => {
      live = false;
    };
  }, [filePath, status, editorReady, loadFileBase, gitStatus]);

  if (status === 'loading') {
    return (
      <div
        className={cn(
          'flex items-center justify-center gap-2 text-xs text-foreground-muted',
          className,
        )}
      >
        <Loader2 className="size-3.5 animate-spin" />
        Loading {fileName(filePath)}…
      </div>
    );
  }

  if (status === 'error' || status === 'binary') {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-2 px-6 text-center',
          className,
        )}
      >
        <FileWarning className="size-6 text-foreground-subtle" />
        <p className="text-sm font-medium text-foreground">{fileName(filePath)}</p>
        <p className="max-w-sm text-xs text-foreground-muted">
          {status === 'binary'
            ? 'This looks like a binary file and can’t be shown in the editor.'
            : errorMsg || 'This file could not be opened.'}
        </p>
      </div>
    );
  }

  return (
    <div className={cn('flex size-full flex-col overflow-hidden text-left', className)}>
      {(conflict || readOnly || lsBanner) && (
        // Wraps in a narrow pane: the text first, the buttons on the next
        // line, each button on one line.
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-surface px-3 py-1.5 font-mono text-xs">
          {conflict ? (
            <>
              <span className="min-w-0 truncate text-warning">File changed on disk.</span>
              <button
                type="button"
                onClick={() => saveRef.current({ overwrite: true })}
                className={NOTICE_ACTION}
              >
                Overwrite
              </button>
              <button type="button" onClick={() => void reloadFromDisk()} className={NOTICE_ACTION}>
                Reload from disk
              </button>
            </>
          ) : foreignHost ? (
            <span className="min-w-0 truncate text-foreground-muted">
              {machineLabel} · outside the project - opened read-only.
            </span>
          ) : readOnly ? (
            <span className="min-w-0 truncate text-warning">
              File is not valid UTF-8 - opened read-only.
            </span>
          ) : lsBanner!.status === 'installing' ? (
            <span className="min-w-0 truncate text-foreground-muted">
              Installing {lsBanner!.name} language support
              {machineLabel ? ` on ${machineLabel}` : ''}…
              {lsProgress ? ` ${lsProgress.done}/${lsProgress.total}` : ''}
            </span>
          ) : (
            <>
              <span className="min-w-0 flex-[1_1_16rem] text-foreground-muted">
                {lsError
                  ? `Install failed: ${lsError}`
                  : machineLabel
                    ? `Install the ${lsBanner!.name} language server on ${machineLabel} (~${lsBanner!.approxMb ?? '?'} MB).`
                    : `${lsBanner!.name} language support is available (~${lsBanner!.approxMb ?? '?'} MB).`}
              </span>
              <button
                type="button"
                onClick={() => installLanguageServer(lsBanner!.id, machine)}
                className={NOTICE_ACTION}
              >
                {lsError ? 'Retry' : 'Install'}
              </button>
              <button
                type="button"
                onClick={() => dismissLanguagePrompt(lsBanner!.id, false)}
                className={NOTICE_ACTION}
              >
                Not now
              </button>
              <button
                type="button"
                onClick={() => dismissLanguagePrompt(lsBanner!.id, true)}
                className={NOTICE_ACTION}
              >
                Don’t ask again
              </button>
            </>
          )}
        </div>
      )}
      <MonacoEditorView
        key={`${foreignHost ?? ''}:${filePath}`}
        ref={handleRef}
        filePath={filePath}
        hostId={foreignHost}
        initialText={content}
        readOnly={readOnly}
        active={active}
        lspRoot={foreignHost ? null : (gitCtx?.cwd ?? null)}
        className="min-h-0 w-full flex-1 overflow-hidden"
        onContentChange={onChange}
        onSave={() => saveRef.current()}
        onReady={onEditorReady}
      />
    </div>
  );
}
