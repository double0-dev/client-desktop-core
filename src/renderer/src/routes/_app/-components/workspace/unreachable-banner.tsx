import { useMemo, useState } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { ChevronRight, ServerOff, X } from 'lucide-react';
import { agentSessionsCollection, projectsCollection } from '@renderer/lib/collections';
import { hostsEnabled } from '@renderer/lib/hosts/hosts-enabled';
import { useUnreachableTerminals } from '@renderer/lib/session/unreachable';
import { useHosts } from '@renderer/lib/hosts/host-directory';
import { requestOpenSettings } from '@renderer/lib/settings/open-settings';

/**
 * "build-box is unreachable - N sessions keep running there" above the tab
 * strip (a private plan › 9.4), the kept-running
 * banner's shape: one per host with an unreachable terminal in this window.
 * The sessions run on the server whatever the network does; the tabs show
 * their last screen until the bridge reconnects. × hides it until the host
 * drops again.
 */
export function UnreachableBanner() {
  const away = useUnreachableTerminals();
  const hosts = useHosts();
  const { data: projects } = useLiveQuery((q) => q.from({ project: projectsCollection }));
  const { data: sessions } = useLiveQuery((q) => q.from({ session: agentSessionsCollection }));
  const [dismissed, setDismissed] = useState<Record<string, number>>({});

  const rows = useMemo(() => {
    const since = new Map<string, number>();
    for (const u of Object.values(away)) {
      since.set(u.hostId, Math.min(since.get(u.hostId) ?? u.since, u.since));
    }
    return [...since].map(([hostId, at]) => {
      const projectIds = new Set(projects.filter((p) => p.hostId === hostId).map((p) => p.id));
      const count = sessions.filter(
        (s) => s.projectId && projectIds.has(s.projectId) && s.status !== 'archived',
      ).length;
      return {
        hostId,
        since: at,
        count,
        label: hosts.find((h) => h.id === hostId)?.label ?? 'A server',
      };
    });
  }, [away, hosts, projects, sessions]);

  if (!hostsEnabled()) return null;
  const shown = rows.filter((r) => dismissed[r.hostId] !== r.since);
  if (shown.length === 0) return null;

  return (
    <>
      {shown.map((r) => (
        <div
          key={r.hostId}
          role="status"
          data-testid="unreachable-banner"
          className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-warning/[0.08] px-3"
        >
          <ServerOff className="size-3.5 shrink-0 text-warning" />
          <span className="truncate text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold text-foreground">
            {r.label} is unreachable -{' '}
            {r.count === 1 ? '1 session keeps' : `${r.count} sessions keep`} running there
          </span>
          <span className="text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
            ·
          </span>
          <span className="min-w-0 truncate text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-muted">
            Reconnecting
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => requestOpenSettings('hosts')}
            className="flex h-[18px] items-center gap-1 rounded-full bg-primary px-2 text-[length:calc(10px*var(--ui-font-scale,1))] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Hosts settings
            <ChevronRight className="size-[11px]" />
          </button>
          <button
            type="button"
            aria-label="Dismiss unreachable notice"
            onClick={() => setDismissed((d) => ({ ...d, [r.hostId]: r.since }))}
            className="flex size-5 items-center justify-center rounded text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </>
  );
}
