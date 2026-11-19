import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RotateCw, Sparkles, X } from 'lucide-react';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { Logo } from '@renderer/components/logo';
import { DevBadge, TitleBar } from '@renderer/components/title-bar';
import { Button } from '@renderer/components/ui/button';
import { reportRenderError } from '@renderer/lib/report-render-error';
import { noteCrashScreen, requestStartFresh, windowActions } from '@renderer/lib/start-fresh';
import { setAppLocked, useAppLocked } from '@renderer/lib/app-lock';

/** Where to write when it keeps happening. */
export const HELP_EMAIL = 'hello@double0.dev';

/**
 * The whole window, when the part that failed IS the window (the workspace,
 * the router, a torn-off window's surface): what happened and ways out that
 * work even when the failure repeats on every launch (lib/start-fresh.ts).
 * It has its own title strip: with no OS title bar the window could not be
 * moved or closed otherwise.
 *
 * While the extension's cover is up (`lib/app-lock.ts`) it stays out of the
 * way: it renders inside the app's root, which the cover makes `inert`, so
 * shown it would hide the cover's own buttons (Check again, Sign out) and
 * take no click itself. It shows once the cover goes.
 *
 * `cover`: it stands in for a cover that failed to render, so it must keep
 * the window locked itself (`useErrorCover`) - the window never runs its
 * content uncovered.
 *
 * `detached`: a torn-off window, which shows only what it was handed - its
 * way out is to close and give its tabs back to the window they came from.
 */
export function AppErrorScreen({
  error,
  detached = false,
  cover = false,
}: {
  error?: unknown;
  detached?: boolean;
  cover?: boolean;
}) {
  // Counted once per boot: the second quick crash in a row makes the next
  // boot start fresh by itself.
  const [looping] = useState(() => noteCrashScreen());
  const locked = useAppLocked();
  const host = useErrorCover(cover);
  const screen = <ErrorCard error={error} detached={detached} looping={looping} />;
  if (cover) return host ? createPortal(screen, host) : null;
  return locked ? null : screen;
}

/**
 * The error screen as the window's cover: a layer of its own under <body>,
 * every other <body> child (the app's root, open dialogs, menus, and any
 * added later) `inert`, the window marked locked and the keyboard taken off
 * whatever had it, and neither Escape nor a press on it reaches a dialog
 * left open underneath. A cover that throws unmounts, and its own cleanup lifts
 * all of that - this runs after it, in the same commit, and puts it back:
 * the workspace stays out of reach of the keyboard and the window-level
 * shortcuts until a reload.
 */
function useErrorCover(active: boolean): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const el = document.createElement('div');
    el.setAttribute('data-error-cover', '');
    el.style.pointerEvents = 'auto';
    document.body.appendChild(el);
    const madeInert: HTMLElement[] = [];
    const cover = (child: Element): void => {
      if (child === el || !(child instanceof HTMLElement) || child.inert) return;
      child.inert = true;
      madeInert.push(child);
    };
    for (const child of Array.from(document.body.children)) cover(child);
    const late = new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach((node) => cover(node as Element));
    });
    late.observe(document.body, { childList: true });
    // A dialog open underneath listens on `document` for a press outside it
    // and for Escape, which `inert` does not stop: a click on this layer or
    // Escape would close it and lose what was typed in it.
    const stayInside = (e: Event): void => e.stopPropagation();
    el.addEventListener('pointerdown', stayInside);
    el.addEventListener('mousedown', stayInside);
    const noEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') e.stopPropagation();
    };
    window.addEventListener('keydown', noEscape, true);
    (document.activeElement as HTMLElement | null)?.blur?.();
    setAppLocked(true);
    setHost(el);
    return () => {
      late.disconnect();
      window.removeEventListener('keydown', noEscape, true);
      for (const child of madeInert) child.inert = false;
      setAppLocked(false);
      el.remove();
      setHost(null);
    };
  }, [active]);
  return active ? host : null;
}

function ErrorCard({
  error,
  detached,
  looping,
}: {
  error: unknown;
  detached: boolean;
  looping: boolean;
}): ReactNode {
  const detail = errorText(error);
  return (
    <div
      role="alert"
      className="fixed inset-0 z-[1001] flex items-center justify-center bg-background text-foreground"
    >
      <TitleBar
        size={detached ? 'compact' : 'full'}
        className="absolute inset-x-0 top-0 flex items-center px-3.5"
      >
        <DevBadge />
      </TitleBar>
      <div className="flex w-[440px] max-w-[calc(100%-32px)] flex-col items-center gap-4 rounded-xl border border-border-strong bg-surface-elevated px-8 pt-8 pb-7 text-center">
        <Logo className="h-[26px] w-auto" />
        <h1 className="text-base font-semibold">Something went wrong</h1>
        <p className="text-sm text-foreground-muted">
          {detached
            ? 'This window ran into a problem. Reload it, or close it - its tabs go back to the window they came from.'
            : 'This window ran into a problem. Reload it, or start fresh if it happens again - that opens without your last view. Nothing is deleted.'}
        </p>
        {looping && (
          <p className="text-sm text-foreground">
            {detached
              ? 'It failed again right after a reload, so the next reload closes this window and gives its tabs back.'
              : 'It failed again right after a reload, so the next reload starts fresh.'}
          </p>
        )}
        {detail && (
          <p className="max-h-24 w-full overflow-auto rounded-md bg-muted px-3 py-2 text-left font-mono text-xs break-words text-foreground-muted">
            {detail}
          </p>
        )}
        <div className="flex flex-wrap justify-center gap-2">
          <Button className="font-medium" onClick={() => windowActions.reload()}>
            <RotateCw className="size-4" />
            Reload
          </Button>
          {detached ? (
            <Button variant="outline" className="font-medium" onClick={() => windowActions.close()}>
              <X className="size-4" />
              Close window
            </Button>
          ) : (
            <Button
              variant="outline"
              className="font-medium"
              onClick={() => {
                requestStartFresh();
                windowActions.reload();
              }}
            >
              <Sparkles className="size-4" />
              Start fresh
            </Button>
          )}
        </div>
        <p className="text-xs text-foreground-subtle">
          Keeps happening? Write to{' '}
          <button
            type="button"
            onClick={() => window.open(`mailto:${HELP_EMAIL}`)}
            className="text-foreground-muted underline-offset-2 hover:text-foreground hover:underline"
          >
            {HELP_EMAIL}
          </button>
          {detail ? ' with the message above.' : '.'}
        </p>
      </div>
    </div>
  );
}

/** The router's error component: a route that threw while rendering or loading. */
export function RouteErrorScreen({ error }: ErrorComponentProps) {
  // The router catches it before any boundary of ours sees it - report it here.
  useEffect(() => reportRenderError(error, 'route'), [error]);
  return <AppErrorScreen error={error} />;
}

function errorText(error: unknown): string | null {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return null;
}
