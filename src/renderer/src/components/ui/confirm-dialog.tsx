import { useRef, useState, type ReactElement } from 'react';
import { presentImperative } from '@renderer/lib/imperative-root';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

/**
 * Imperative, promise-based replacements for `window.confirm`/`window.alert`,
 * built on the app's Radix dialog. Each call mounts a one-off React root that
 * tears itself down after the close animation, so callers don't need a provider
 * anywhere in their tree:
 *
 *   if (await confirmDialog({ title: 'Delete file?', destructive: true })) { … }
 */

export type ConfirmOptions = {
  title: string;
  description?: string;
  /** Label for the confirming action (default "Confirm"). */
  confirmLabel?: string;
  /** Label for the dismissing action (default "Cancel"). */
  cancelLabel?: string;
  /** Style the confirming action as destructive (red). */
  destructive?: boolean;
  /**
   * Glyph for a warning badge beside the title, repeated on the confirming
   * action - the design's `DialogShell` header for a consequential confirm.
   */
  icon?: LucideIcon;
};

export type AlertOptions = {
  title: string;
  description?: string;
  /** Label for the dismissing action (default "OK"). */
  dismissLabel?: string;
};

/** Ask the user to confirm an action; resolves false on Escape/overlay-dismiss. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return present((onDone) => <ConfirmHost opts={opts} onDone={onDone} />);
}

/** Show a message the user can only acknowledge; resolves when dismissed. */
export async function alertDialog(opts: AlertOptions): Promise<void> {
  await present((onDone) => <AlertHost opts={opts} onDone={onDone} />);
}

export type ChoiceOptions<T extends string> = {
  title: string;
  description?: string;
  /** The actions, left to right; the last one is the default (focused). */
  choices: { value: T; label: string; destructive?: boolean }[];
  /** Label for the dismissing action (default "Cancel"); it resolves null. */
  cancelLabel?: string;
};

/**
 * Ask the user to pick one of several actions; resolves the picked value, or
 * null on Cancel / Escape / overlay-dismiss.
 */
export function choiceDialog<T extends string>(opts: ChoiceOptions<T>): Promise<T | null> {
  return presentImperative<T | null>((onDone) => <ChoiceHost opts={opts} onDone={onDone} />);
}

/** Mount a one-off dialog root; `onDone` resolves the promise and (after the
 * close animation has had time to play) unmounts everything again. */
function present(node: (onDone: (ok: boolean) => void) => ReactElement): Promise<boolean> {
  return presentImperative<boolean>((onDone) => node(onDone));
}

/** Shared open/close shell: opens on mount, reports the choice exactly once
 * (a button click also fires onOpenChange(false), which must not re-report). */
function useDialogResult(onDone: (ok: boolean) => void): {
  open: boolean;
  finish: (ok: boolean) => void;
  onOpenChange: (open: boolean) => void;
} {
  const [open, setOpen] = useState(true);
  const done = useRef(false);
  const finish = (ok: boolean): void => {
    if (done.current) return;
    done.current = true;
    setOpen(false);
    onDone(ok);
  };
  return { open, finish, onOpenChange: (o) => !o && finish(false) };
}

// The hosts are mounted in throwaway roots per call, never hot-reloaded, so the
// component/function export mix react-refresh objects to is harmless here.
// eslint-disable-next-line react-refresh/only-export-components
function ConfirmHost({ opts, onDone }: { opts: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const { open, finish, onOpenChange } = useDialogResult(onDone);
  const Icon = opts.icon;
  const header = (
    <DialogHeader className={Icon ? 'min-w-0' : undefined}>
      <DialogTitle className={Icon ? 'text-base' : undefined}>{opts.title}</DialogTitle>
      {opts.description && (
        <DialogDescription className={Icon ? 'leading-relaxed' : undefined}>
          {opts.description}
        </DialogDescription>
      )}
    </DialogHeader>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        {Icon ? (
          // The badge + header pair every consequential dialog uses
          // (project-delete-dialog, worktree-delete-dialog).
          <div className="flex items-start gap-3.5">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-warning/15">
              <Icon className="size-5 text-warning" />
            </div>
            {header}
          </div>
        ) : (
          header
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => finish(false)}>
            {opts.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            variant={opts.destructive ? 'destructive' : 'default'}
            size="sm"
            autoFocus
            onClick={() => finish(true)}
          >
            {Icon && <Icon />}
            {opts.confirmLabel ?? 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- see ConfirmHost
function ChoiceHost<T extends string>({
  opts,
  onDone,
}: {
  opts: ChoiceOptions<T>;
  onDone: (value: T | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const done = useRef(false);
  const finish = (value: T | null): void => {
    if (done.current) return;
    done.current = true;
    setOpen(false);
    onDone(value);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && finish(null)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{opts.title}</DialogTitle>
          {opts.description && <DialogDescription>{opts.description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => finish(null)}>
            {opts.cancelLabel ?? 'Cancel'}
          </Button>
          {opts.choices.map((c, i) => (
            <Button
              key={c.value}
              variant={
                c.destructive
                  ? 'destructive'
                  : i === opts.choices.length - 1
                    ? 'default'
                    : 'outline'
              }
              size="sm"
              autoFocus={i === opts.choices.length - 1}
              onClick={() => finish(c.value)}
            >
              {c.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- see ConfirmHost
function AlertHost({ opts, onDone }: { opts: AlertOptions; onDone: (ok: boolean) => void }) {
  const { open, finish, onOpenChange } = useDialogResult(onDone);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{opts.title}</DialogTitle>
          {opts.description && (
            // A list of lines (an upload's report) keeps its line breaks.
            <DialogDescription className="whitespace-pre-line">
              {opts.description}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" autoFocus onClick={() => finish(true)}>
            {opts.dismissLabel ?? 'OK'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
