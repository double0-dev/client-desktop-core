import { useEffect, useState } from 'react';
import { FileWarning, Loader2 } from 'lucide-react';
import { useWorkspaceLayout } from '@renderer/lib/workspace/layout-context';
import { imageMime } from '@renderer/lib/image-files';
import { cn, fileName } from '@renderer/lib/utils';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A single image open in an editor tab: the file's bytes are read over the fs
 * bridge and shown via a blob URL (the renderer can't load file:// URLs). Kept
 * in sync with the disk like FileEditor - an on-disk change reloads the image,
 * a delete closes the tab. Images are never dirty; there is nothing to save.
 */
export function ImageViewer({ filePath, className }: { filePath: string; className?: string }) {
  const { closeEditorsUnder } = useWorkspaceLayout();
  const [url, setUrl] = useState<string | null>(null);
  const [byteSize, setByteSize] = useState(0);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  // Bumped by the file-watch subscription to re-read the bytes after an on-disk
  // change; 0 means the initial load (which shows the spinner - reloads don't).
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    const fs = window.api?.fs;
    if (!fs?.readFileBinary) {
      setErrorMsg('Image viewing runs in the double0 desktop app.');
      setStatus('error');
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    if (loadTick === 0) setStatus('loading');
    fs.readFileBinary(filePath).then((res) => {
      if (cancelled) return;
      if (res.error || !res.bytes) {
        // Deleted under an open tab: drop the tab, like FileEditor does. On the
        // initial load (a stale restored layout) show the error instead.
        if (res.code === 'ENOENT' && loadTick > 0) {
          closeEditorsUnder(filePath);
          return;
        }
        setErrorMsg(res.error ?? 'This image could not be opened.');
        setStatus('error');
        return;
      }
      // Re-wrap: the IPC-delivered Uint8Array types as ArrayBufferLike-backed,
      // which BlobPart rejects.
      objectUrl = URL.createObjectURL(
        new Blob([new Uint8Array(res.bytes)], { type: imageMime(filePath) }),
      );
      setByteSize(res.bytes.byteLength);
      setUrl(objectUrl);
      setStatus('ready');
    });
    return () => {
      cancelled = true;
      // Revoking only blocks future loads - an <img> already showing it is fine.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, loadTick, closeEditorsUnder]);

  // Reload when the file changes on disk (same watch feed as FileEditor).
  useEffect(() => {
    const fs = window.api?.fs;
    if (!fs?.onChanged) return;
    return fs.onChanged((_root, paths) => {
      if (paths.includes(filePath)) setLoadTick((t) => t + 1);
    });
  }, [filePath]);

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

  if (status === 'error') {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-2 px-6 text-center',
          className,
        )}
      >
        <FileWarning className="size-6 text-foreground-subtle" />
        <p className="text-sm font-medium text-foreground">{fileName(filePath)}</p>
        <p className="max-w-sm text-xs text-foreground-muted">{errorMsg}</p>
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden', className)}>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        <img
          src={url ?? undefined}
          alt={fileName(filePath)}
          onLoad={(e) =>
            setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
          className="max-h-full max-w-full object-contain"
        />
      </div>
      <div className="flex shrink-0 items-center justify-center gap-3 px-3 pb-2 font-mono text-[11px] text-foreground-muted">
        {dims && (
          <span>
            {dims.w}×{dims.h}
          </span>
        )}
        <span>{formatBytes(byteSize)}</span>
      </div>
    </div>
  );
}
