import { useEffect, useRef, useState } from 'react';
import { Code, Eye, RotateCw } from 'lucide-react';
import { TextPart } from '@tanstack/ai-react/ui';
import { markdownHighlighter } from '@renderer/lib/markdown/highlight';
import { previewRoot, type PreviewKind } from '@renderer/lib/editor/file-preview';
import { cn } from '@renderer/lib/utils';
import { isWithin, relativeTo } from '@renderer/lib/path-within';

// File previews in an editor tab (a private plan › File
// previews; design: Screen/Workspace - Files · Preview): the header with the
// path and the Code / Preview switch, and the preview itself - Markdown
// rendered here, HTML / SVG / PDF / video in a browser page on `d0-preview://`.

const TEXT_11 = 'text-[length:calc(11px*var(--ui-font-scale,1))]';
const BROWSER_PARTITION = 'persist:double0-browser';

export function PreviewHeader({
  filePath,
  cwd,
  kind,
  mode,
  onMode,
  onReload,
}: {
  filePath: string;
  cwd: string | null;
  kind: PreviewKind;
  mode: 'code' | 'preview';
  onMode: (mode: 'code' | 'preview') => void;
  onReload?: () => void;
}) {
  const shown = (cwd && isWithin(filePath, cwd) && relativeTo(filePath, cwd)) || filePath;
  const seg = (m: 'code' | 'preview', label: string, Icon: typeof Code) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => onMode(m)}
      className={cn(
        'flex items-center gap-1.5 rounded-sm px-2 py-[3px] font-medium transition-colors',
        mode === m
          ? 'bg-accent text-accent-foreground'
          : 'text-foreground-muted hover:text-foreground',
        TEXT_11,
      )}
    >
      <Icon className="size-3" />
      {label}
    </button>
  );
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface pr-2 pl-3">
      <span
        className={cn('min-w-0 flex-1 truncate font-mono text-foreground-subtle', TEXT_11)}
        title={filePath}
      >
        {shown}
      </span>
      {mode === 'preview' && onReload && (
        <button
          type="button"
          aria-label="Reload preview"
          title="Reload preview"
          onClick={onReload}
          className="flex size-6 items-center justify-center rounded-sm text-foreground-muted hover:bg-muted hover:text-foreground"
        >
          <RotateCw className="size-3.5" />
        </button>
      )}
      {kind !== 'media' && (
        <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5">
          {seg('code', 'Code', Code)}
          {seg('preview', 'Preview', Eye)}
        </div>
      )}
    </div>
  );
}

/** Rendered Markdown, re-read whenever the preview is shown (`reloadToken`). */
export function MarkdownPreview({
  filePath,
  reloadToken,
}: {
  filePath: string;
  reloadToken: number;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.api?.fs?.readFile(filePath).then((res) => {
      if (!live) return;
      if (res?.content !== undefined) {
        setContent(res.content);
        setError(null);
      } else setError(res?.error ?? 'Could not read the file.');
    });
    return () => {
      live = false;
    };
  }, [filePath, reloadToken]);
  return (
    <div className="size-full overflow-auto bg-background px-7 py-6">
      {error ? (
        <span className="text-[length:calc(12px*var(--ui-font-scale,1))] text-destructive">
          {error}
        </span>
      ) : content === null ? null : (
        <TextPart
          content={content}
          role="assistant"
          highlighter={markdownHighlighter}
          className="rendered-markdown mx-auto max-w-[760px] text-[length:calc(13px*var(--ui-font-scale,1))] leading-relaxed text-foreground"
        />
      )}
    </div>
  );
}

/** A browser page on the file's `d0-preview://` URL (HTML, SVG, PDF, video). */
export function WebFilePreview({
  filePath,
  cwd,
  reloadToken,
}: {
  filePath: string;
  cwd: string | null;
  reloadToken: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.api?.browser?.previewUrl(previewRoot(filePath, cwd), filePath).then((url) => {
      if (!live) return;
      if (!url) {
        setError('This file cannot be previewed.');
        return;
      }
      const host = hostRef.current;
      if (!host) return;
      const existing = webviewRef.current;
      if (existing) {
        void existing.loadURL(url).catch(() => {});
        return;
      }
      const wv = document.createElement('webview') as Electron.WebviewTag;
      wv.setAttribute('partition', BROWSER_PARTITION);
      wv.setAttribute('src', url);
      wv.style.cssText = 'display:flex;width:100%;height:100%;border:0;background:#fff';
      webviewRef.current = wv;
      host.appendChild(wv);
    });
    return () => {
      live = false;
    };
  }, [filePath, cwd]);

  useEffect(() => {
    if (reloadToken > 0) webviewRef.current?.reload();
  }, [reloadToken]);

  return (
    <div className="relative size-full">
      <div ref={hostRef} className="flex size-full" />
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-background text-[length:calc(12px*var(--ui-font-scale,1))] text-foreground-muted">
          {error}
        </div>
      )}
    </div>
  );
}
