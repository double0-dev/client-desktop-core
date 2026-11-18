import { useCallback, useEffect, useRef, useState } from 'react';
import { alertDialog, choiceDialog } from '@renderer/components/ui/confirm-dialog';
import {
  clashTitle,
  uploadReport,
  type UploadProgressView,
} from '@renderer/lib/workspace/explorer-upload';
import { fileName } from '@renderer/lib/utils';

export type ExplorerUploadRun = {
  uploadId: string;
  destDir: string;
  progress: UploadProgressView | null;
};

/**
 * The explorer's copy of dropped files (a private plan
 * › 9.3): one at a time per explorer. Main walks and copies the paths; a taken
 * name is asked once for the batch (Replace / Skip / Keep both), and what was
 * left out is reported when it ends.
 */
export function useExplorerUpload(hostLabel: string | null, onLanded: (destDir: string) => void) {
  const [run, setRun] = useState<ExplorerUploadRun | null>(null);
  const runRef = useRef<ExplorerUploadRun | null>(null);
  runRef.current = run;
  const onLandedRef = useRef(onLanded);
  onLandedRef.current = onLanded;

  useEffect(() => {
    const off = window.api?.fs?.onUploadProgress?.((p) => {
      setRun((r) => (r && r.uploadId === p.uploadId ? { ...r, progress: p } : r));
    });
    return off;
  }, []);

  const drop = useCallback(
    async (paths: string[], destDir: string) => {
      const fs = window.api?.fs;
      if (!fs?.upload || paths.length === 0) return;
      if (runRef.current) {
        void alertDialog({
          title: 'A copy is still running',
          description: 'Wait for it to finish, or cancel it, before dropping more files.',
        });
        return;
      }
      const uploadId = `up${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const started: ExplorerUploadRun = { uploadId, destDir, progress: null };
      runRef.current = started;
      setRun(started);
      try {
        let res = await fs.upload({ uploadId, paths, destDir, onClash: 'ask' });
        if (res.clash) {
          const choice = await choiceDialog({
            title: clashTitle(res.clash, fileName(destDir)),
            description:
              res.clash.count === 1
                ? 'Replace it, skip it, or keep both (the copy gets a number).'
                : 'The choice applies to every name that is taken in this drop.',
            choices: [
              { value: 'skip', label: 'Skip' },
              { value: 'keep-both', label: 'Keep both' },
              { value: 'replace', label: 'Replace' },
            ],
          });
          if (!choice) return;
          res = await fs.upload({ uploadId, paths, destDir, onClash: choice });
        }
        onLandedRef.current(destDir);
        const report = uploadReport(res, hostLabel);
        if (report) void alertDialog(report);
      } catch (err) {
        void alertDialog({ title: 'Could not copy', description: String(err) });
      } finally {
        runRef.current = null;
        setRun(null);
      }
    },
    [hostLabel],
  );

  const cancel = useCallback(() => {
    const r = runRef.current;
    if (r) void window.api?.fs?.uploadCancel?.(r.uploadId);
  }, []);

  return { run, drop, cancel };
}
