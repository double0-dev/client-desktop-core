import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { ChevronDown, TriangleAlert, Trash2 } from 'lucide-react';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { agentSessionsCollection, type AgentSession } from '@renderer/lib/collections';
import { newlyExpiredSessions } from '@renderer/lib/session/auto-archive';
import {
  updateSessionDaemonSettings,
  useSessionDaemonSettings,
} from '@renderer/lib/settings/session-daemon-settings';
import {
  DURATION_MAX,
  DURATION_MIN,
  DURATION_UNITS,
  durationMs,
  formatDuration,
  getSessionCleanupSettings,
  updateSessionCleanupSettings,
  useSessionCleanupSettings,
  type DurationUnit,
  type SessionCleanupSettings,
  type SessionDuration,
} from '@renderer/lib/settings/session-cleanup-settings';
import { cn } from '@renderer/lib/utils';
import {
  SettingActionRow,
  SettingToggleRow,
} from '@renderer/routes/_app/-components/settings/settings-controls';
import {
  daemonBuildLabel,
  moveOlderSessions,
  stopAllSessionsOn,
} from '@renderer/routes/_app/-components/settings/settings-form';
import type { SessionDaemonRow } from '../../../../../../preload/index';
import { hostsEnabled } from '@renderer/lib/hosts/hosts-enabled';
import { useHosts } from '@renderer/lib/hosts/host-directory';
import { useHostStatuses } from '@renderer/lib/hosts/host-status';

/**
 * Settings → Sessions (design: `Screen/Settings - Sessions` + the
 * `Label/Settings · Sessions` states board): what happens to running sessions
 * when the app quits (a private plan - the AFTER QUIT rows
 * still need their design pass), when quiet sessions are archived and when
 * archived ones are deleted. The sweeps run in workspace-host.tsx.
 */
export function SessionsSettingsSection() {
  const settings = useSessionCleanupSettings();
  const daemon = useSessionDaemonSettings();
  const { data: sessions } = useLiveQuery((q) => q.from({ session: agentSessionsCollection }));

  // Stop all is per machine (plan 28 › spec 16): this one, then each server.
  const hosts = useHosts();
  const remoteHosts = hostsEnabled() ? hosts : [];
  const hostStatuses = useHostStatuses();

  /** Apply a change to the delete rule, confirming first when it would delete
   * archived sessions at once (turning it on, or shortening its time). */
  async function changeDeleteRule(patch: Partial<SessionCleanupSettings>): Promise<void> {
    const current = getSessionCleanupSettings();
    const next = { ...current, ...patch };
    const doomed = newlyExpiredSessions(
      sessions,
      Date.now(),
      { autoDelete: current.autoDelete, deleteAfterMs: durationMs(current.deleteAfter) },
      { autoDelete: next.autoDelete, deleteAfterMs: durationMs(next.deleteAfter) },
    );
    if (doomed.length > 0) {
      const ok = await confirmDialog(deleteNowCopy(doomed, next.deleteAfter, !current.autoDelete));
      if (!ok) return;
    }
    updateSessionCleanupSettings(patch);
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <section className="flex flex-col gap-3">
        <SectionLabel>AFTER QUIT</SectionLabel>
        <SettingToggleRow
          title="Keep sessions running after quit"
          description="Shells and agents keep working while double0 is closed; every tab picks its terminal up again on the next launch. When off, quitting ends them."
          checked={daemon.keepRunning}
          onChange={(keepRunning) => updateSessionDaemonSettings({ keepRunning })}
        />
        <SettingActionRow
          title={remoteHosts.length > 0 ? 'Stop all on this machine' : 'Stop all sessions'}
          description={
            remoteHosts.length > 0
              ? "End every shell and agent running on this computer now. Servers' sessions keep running."
              : 'End every running shell and agent now. Tabs stay open and show the exit.'
          }
          buttonLabel="Stop all"
          destructive
          onClick={() => void stopAllSessionsOn(null)}
        />
        {remoteHosts.map((host) => (
          <SettingActionRow
            key={host.id}
            title={`Stop all on ${host.label}`}
            description={`End every shell and agent running on ${host.label} now. Tabs stay open and show the exit.`}
            buttonLabel="Stop all"
            destructive
            // An unreachable host's sessions cannot be stopped from here.
            disabled={hostStatuses[host.id]?.state !== 'connected'}
            onClick={() => void stopAllSessionsOn(host)}
          />
        ))}
      </section>

      <OlderVersionSessions />

      <div className="h-px w-full bg-border" />

      <section className="flex flex-col gap-3">
        <SectionLabel>AUTO-ARCHIVE</SectionLabel>
        <SettingToggleRow
          title="Archive inactive sessions"
          description="Move a session to Archived once nothing has happened in it for a while. Opening it again brings it back."
          checked={settings.autoArchive}
          onChange={(autoArchive) => updateSessionCleanupSettings({ autoArchive })}
        />
        <DurationRow
          title="Archive after"
          description="Counted from the session’s last activity. A session that is working or waiting on you is never archived."
          value={settings.archiveAfter}
          disabled={!settings.autoArchive}
          onChange={(archiveAfter) => updateSessionCleanupSettings({ archiveAfter })}
        />
      </section>

      <div className="h-px w-full bg-border" />

      <section className="flex flex-col gap-3">
        <SectionLabel>DELETE ARCHIVED SESSIONS</SectionLabel>
        <SettingToggleRow
          title="Delete archived sessions"
          description="Remove a session for good once it has sat in the archive this long - archived by hand or automatically."
          checked={settings.autoDelete}
          onChange={(autoDelete) => void changeDeleteRule({ autoDelete })}
        />
        <DurationRow
          title="Delete after"
          description="Counted from the day the session was archived."
          value={settings.deleteAfter}
          disabled={!settings.autoDelete}
          onChange={(deleteAfter) => changeDeleteRule({ deleteAfter })}
        />
        <SettingToggleRow
          title="Remove its worktree too"
          description="Only a worktree with no uncommitted changes is removed. Its branch is always kept."
          checked={settings.removeWorktree}
          disabled={!settings.autoDelete}
          onChange={(removeWorktree) => updateSessionCleanupSettings({ removeWorktree })}
        />
        {settings.autoDelete && (
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-foreground-muted" />
            <p className="text-xs leading-relaxed text-foreground-subtle">
              A deleted session can’t be restored. The check runs every hour while double0 is open.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

/** The confirm copy for a delete rule that would delete `doomed` at once. */
function deleteNowCopy(
  doomed: AgentSession[],
  after: SessionDuration,
  turningOn: boolean,
): Parameters<typeof confirmDialog>[0] {
  const n = doomed.length;
  const names = doomed.slice(0, 2).map((s) => `“${s.label}”`);
  const rest = n - names.length;
  const list = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(' and ');
  return {
    title: `Delete ${n} archived session${n === 1 ? '' : 's'} now?`,
    description: `${list} ${n === 1 ? 'has' : 'have'} been in the archive longer than ${formatDuration(after)}. ${
      turningOn ? 'Turning this on' : 'This change'
    } deletes ${n === 1 ? 'it' : 'them'} right away and can’t be undone.`,
    confirmLabel: turningOn ? 'Turn on and delete' : 'Change and delete',
    destructive: true,
    icon: Trash2,
  };
}

/** How often the older-version list re-reads main while Settings is open. */
const DAEMONS_POLL_MS = 15_000;

/**
 * Sessions still running in an older version's session daemon (after an
 * update, or every dev rebuild - src/main/daemon-migrate.ts). Shown only while
 * there are any. Idle agents move by themselves; Move now takes them all.
 */
function OlderVersionSessions() {
  const [rows, setRows] = useState<SessionDaemonRow[]>([]);
  const reload = useCallback(async () => {
    const next = await window.api?.sessions?.daemons?.();
    if (next) setRows(next);
  }, []);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), DAEMONS_POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const older = rows.filter((r) => !r.current && r.terminals > 0);
  if (older.length === 0) return null;
  return (
    <>
      <div className="h-px w-full bg-border" />
      <section className="flex flex-col gap-3">
        <SectionLabel>OLDER VERSIONS</SectionLabel>
        {older.map((row) => {
          const label = daemonBuildLabel(row.buildId);
          const count = row.terminals === 1 ? '1 terminal' : `${row.terminals} terminals`;
          return (
            <SettingActionRow
              key={row.socketPath}
              title={`Still running on ${label}`}
              description={`${count} kept running through an update${row.busy > 0 ? ` - ${row.busy} working now` : ''}. An agent that can resume its conversation moves to this version by itself once it has sat idle for 10 minutes in a session you have not opened; everything else stays until its tab closes, or you move it now.`}
              buttonLabel="Move now"
              onClick={() => void moveOlderSessions(row.socketPath, label).then(reload)}
            />
          );
        })}
      </section>
    </>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <h3 className="text-[length:calc(11px*var(--ui-font-scale,1))] font-semibold tracking-[0.8px] text-foreground-subtle">
      {children}
    </h3>
  );
}

/** Title + description with an amount field and a unit select on the right. */
function DurationRow({
  title,
  description,
  value,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  value: SessionDuration;
  disabled: boolean;
  /** May ask first (the delete rule's confirm) and settle without a change. */
  onChange: (value: SessionDuration) => void | Promise<void>;
}) {
  // The amount commits on blur / Enter, never per keystroke: typing "30" over
  // "7" passes through "3", and a delete rule must not act on the interim value.
  const [draft, setDraft] = useState(String(value.amount));
  useEffect(() => setDraft(String(value.amount)), [value.amount]);
  const valueRef = useRef(value);
  valueRef.current = value;

  function commit(): void {
    const n = Number.parseInt(draft, 10);
    if (!Number.isFinite(n)) {
      setDraft(String(value.amount));
      return;
    }
    const amount = Math.min(DURATION_MAX, Math.max(DURATION_MIN, n));
    setDraft(String(amount));
    if (amount === value.amount) return;
    // A cancelled confirm leaves the setting where it was - and with it no
    // prop change to reset the field, so re-read it once the change settles.
    void Promise.resolve(onChange({ ...value, amount })).then(() =>
      setDraft(String(valueRef.current.amount)),
    );
  }

  return (
    <div className={cn('flex items-center gap-4', disabled && 'opacity-60')}>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <p className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground">
          {title}
        </p>
        <p className="text-xs leading-relaxed text-foreground-subtle">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          type="text"
          inputMode="numeric"
          aria-label={`${title} amount`}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              // Keep the settings dialog open; drop the edit instead.
              e.stopPropagation();
              setDraft(String(value.amount));
            }
          }}
          className="h-8 w-14 rounded-md border border-border bg-input px-2.5 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-default"
        />
        <div className="relative w-24">
          <select
            value={value.unit}
            aria-label={`${title} unit`}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, unit: e.target.value as DurationUnit })}
            className="h-8 w-full appearance-none rounded-md border border-border bg-input pl-2.5 pr-8 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-default"
          >
            {DURATION_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-muted" />
        </div>
      </div>
    </div>
  );
}
