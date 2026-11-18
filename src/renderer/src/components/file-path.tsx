import { splitFilePath } from '@renderer/lib/file-path';
import { cn } from '@renderer/lib/utils';

/**
 * A file path with the file name emphasised: the directory
 * is muted and is the only part that shrinks - it truncates at its end with an
 * ellipsis - while the file name, carrying its leading "/", stays fully
 * visible. Only once the name alone no longer fits does the directory collapse
 * to nothing and the name itself truncate. Root-level files show just the
 * name. Design: `Label/Changes file path states` in `client_desktop.pen`.
 *
 * Inherits the font from its parent; the caller sizes it in the row (usually
 * `min-w-0 flex-1`). `muted` dims both parts one step (deleted files).
 */
export function FilePath({
  path,
  muted = false,
  className,
  nameClassName,
}: {
  path: string;
  muted?: boolean;
  className?: string;
  nameClassName?: string;
}) {
  const { dir, name } = splitFilePath(path);
  return (
    <span className={cn('flex min-w-0', className)}>
      {dir && (
        // A huge shrink factor means the directory absorbs essentially all of
        // the shortfall (down to its `min-w-0` floor) before the name gives up
        // a single pixel.
        <span
          data-part="dir"
          className={cn(
            'min-w-0 shrink-[1000] truncate',
            muted ? 'text-foreground-subtle' : 'text-foreground-muted',
          )}
        >
          {dir}
        </span>
      )}
      <span
        data-part="name"
        className={cn(
          'min-w-0 shrink truncate font-semibold',
          muted ? 'text-foreground-muted' : 'text-foreground',
          nameClassName,
        )}
      >
        {name}
      </span>
    </span>
  );
}
