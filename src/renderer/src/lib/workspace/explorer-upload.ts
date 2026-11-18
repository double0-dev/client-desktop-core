/**
 * The explorer's drop of files from this computer (a private plan
 * › 9.3), pure: which drags it takes, the folder a drop lands in, and the
 * words of the footer row and the reports. The copy itself is main's
 * (`fs:upload`); the renderer only hands it the dropped paths.
 */

/** A drag from outside the window carrying files (never a tab or a tree row). */
export function isFileDrag(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes('Files');
}

/** Progress as main pushes it. */
export type UploadProgressView = { done: number; total: number; bytes: number; totalBytes: number };

const MB = 1024 * 1024;

/** `4.2` - megabytes with one decimal under 100, whole above. */
function mb(bytes: number): string {
  const v = bytes / MB;
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
}

/**
 * The footer row: `Uploading 3 files to build-box - 4.2 of 12.0 MB`, or
 * `Copying 3 files - …` onto this computer; `Preparing…` before the walk
 * has counted anything.
 */
export function uploadLabel(progress: UploadProgressView | null, hostLabel: string | null): string {
  if (!progress || progress.total === 0) {
    return hostLabel ? `Preparing the upload to ${hostLabel}…` : 'Preparing the copy…';
  }
  const files = `${progress.total} ${progress.total === 1 ? 'file' : 'files'}`;
  const amount = `${mb(progress.bytes)} of ${mb(progress.totalBytes)} MB`;
  return hostLabel
    ? `Uploading ${files} to ${hostLabel} - ${amount}`
    : `Copying ${files} - ${amount}`;
}

/** The clash prompt's title: one name, or how many. */
export function clashTitle(clash: { name: string; count: number }, folder: string): string {
  return clash.count === 1
    ? `“${clash.name}” is already in ${folder}`
    : `“${clash.name}” and ${clash.count - 1} more are already in ${folder}`;
}

export type UploadOutcome = {
  ok?: boolean;
  copied?: string[];
  skipped?: { path: string; reason: string }[];
  errors?: { path: string; message: string }[];
  cancelled?: true;
  unreachable?: true;
  error?: string;
};

/**
 * What to tell the user once a drop finished, or null when it all landed (a
 * cancel the user asked for is not news either). Lists at most eight lines.
 */
export function uploadReport(
  res: UploadOutcome,
  hostLabel: string | null,
): { title: string; description: string } | null {
  if (res.unreachable) {
    return {
      title: 'The upload stopped',
      description: `${hostLabel ?? 'The server'} is unreachable - ${res.copied?.length ?? 0} files arrived before it went.`,
    };
  }
  if (res.error)
    return { title: hostLabel ? 'Could not upload' : 'Could not copy', description: res.error };
  const lines = [
    ...(res.errors ?? []).map((e) => `${e.path} - ${e.message}`),
    ...(res.skipped ?? []).map((s) => `${s.path} - ${s.reason}`),
  ];
  if (lines.length === 0) return null;
  const shown = lines.slice(0, 8);
  if (lines.length > shown.length) shown.push(`and ${lines.length - shown.length} more`);
  const copied = res.copied?.length ?? 0;
  return {
    title: res.cancelled
      ? `Cancelled - ${copied} ${copied === 1 ? 'file' : 'files'} copied`
      : (res.errors?.length ?? 0) > 0
        ? 'Some files were not copied'
        : 'Some items were left out',
    description: shown.join('\n'),
  };
}
