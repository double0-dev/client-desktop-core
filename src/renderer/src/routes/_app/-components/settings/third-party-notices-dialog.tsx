import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { filterNotices, noticeKey } from '@renderer/lib/third-party-notices';
import { cn } from '@renderer/lib/utils';
import type { NoticesAnswer } from '../../../../../../main/third-party-notices';

/**
 * Settings › General › Open-source licences: every package the app bundles or
 * ships with its licence texts (out/third-party-notices.json, written by the
 * build), and links to Electron's and Chromium's own licence files.
 */
export function ThirdPartyNoticesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [answer, setAnswer] = useState<NoticesAnswer | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [platformMissing, setPlatformMissing] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQuery('');
    setPlatformMissing(false);
    void window.api.notices.list().then((a) => {
      if (cancelled) return;
      setAnswer(a ?? { ok: false, code: 'ENOENT' });
      if (a?.ok)
        setSelected((s) => s ?? (a.notices.packages[0] ? noticeKey(a.notices.packages[0]) : null));
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const notices = answer?.ok ? answer.notices : null;
  const shown = useMemo(
    () => (notices ? filterNotices(notices.packages, query) : []),
    [notices, query],
  );
  const current = shown.find((p) => noticeKey(p) === selected) ?? shown[0] ?? null;

  async function openPlatform(which: 'electron' | 'chromium'): Promise<void> {
    const opened = await window.api.notices.openPlatform(which);
    setPlatformMissing(!opened);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(700px,88vh)] max-w-[940px] flex-col gap-0 overflow-hidden p-0"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex flex-col gap-0.5">
            <DialogTitle className="text-[length:calc(15px*var(--ui-font-scale,1))] font-semibold">
              Open-source licences
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              double0 is built with these open-source packages. Each one is listed with its licence
              text.
            </DialogDescription>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="flex size-7 shrink-0 items-center justify-center rounded text-foreground-muted outline-none transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {answer && !answer.ok ? (
          <p className="px-5 py-6 text-[length:calc(13px*var(--ui-font-scale,1))] text-foreground-muted">
            {answer.code === 'ENOENT'
              ? 'This build has no licence list - it is written when the app is built for release.'
              : 'The licence list in this build could not be read.'}
          </p>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-5 py-2">
              <Search className="size-4 shrink-0 text-foreground-muted" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search packages"
                placeholder="Search packages or licences…"
                className="min-w-0 flex-1 bg-transparent text-[length:calc(13px*var(--ui-font-scale,1))] text-foreground outline-none placeholder:text-foreground-muted"
              />
              <span className="shrink-0 tabular-nums text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
                {notices ? `${shown.length} of ${notices.packages.length}` : ''}
              </span>
            </div>
            <div className="flex min-h-0 flex-1">
              <ul
                aria-label="Packages"
                className="w-[300px] shrink-0 overflow-y-auto border-r border-border py-1"
              >
                {shown.map((p) => {
                  const key = noticeKey(p);
                  const active = current !== null && noticeKey(current) === key;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        aria-current={active || undefined}
                        onClick={() => setSelected(key)}
                        className={cn(
                          'flex w-full items-baseline gap-2 px-4 py-1.5 text-left outline-none hover:bg-muted',
                          active && 'bg-muted',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-[length:calc(13px*var(--ui-font-scale,1))] text-foreground">
                          {p.name}
                        </span>
                        <span className="shrink-0 text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
                          {p.license ?? '-'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
                {current && notices && (
                  <div className="flex flex-col gap-4">
                    <p className="text-[length:calc(13px*var(--ui-font-scale,1))] font-semibold text-foreground">
                      {current.name}{' '}
                      <span className="font-normal text-foreground-subtle">
                        {current.version} - {current.license ?? 'licence not stated'}
                      </span>
                    </p>
                    {current.files.map((f) => (
                      <section key={f.name} className="flex flex-col gap-1.5">
                        <h4 className="text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
                          {f.name}
                        </h4>
                        <pre className="overflow-x-auto whitespace-pre font-mono text-[length:calc(11px*var(--ui-font-scale,1))] leading-relaxed text-foreground-muted">
                          {notices.texts[f.text]}
                        </pre>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-5 py-3 text-[length:calc(12px*var(--ui-font-scale,1))]">
          <span className="text-foreground-subtle">Built on Electron and Chromium:</span>
          <button
            type="button"
            onClick={() => void openPlatform('electron')}
            className="text-primary outline-none hover:underline"
          >
            Electron licence
          </button>
          <button
            type="button"
            onClick={() => void openPlatform('chromium')}
            className="text-primary outline-none hover:underline"
          >
            Chromium licences
          </button>
          {platformMissing && (
            <span className="text-foreground-subtle">Not found in this build.</span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
