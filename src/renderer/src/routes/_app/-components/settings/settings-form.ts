import { Square } from 'lucide-react';
import { alertDialog, confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { getHostStatus } from '@renderer/lib/hosts/host-status';
import {
  DEFAULT_MONO_CSS,
  appFontSettings,
  resolveSurfaceFontSize,
  resolveUiFontCss,
  type UiFontSettings,
} from '@renderer/lib/settings/ui-font-settings';

export function useResolvedSurfaceFont(
  settings: UiFontSettings,
  builtinSize: number,
): { css: string; size: number } {
  const app = appFontSettings.useValue();
  return {
    css:
      resolveUiFontCss(settings.fontFamily) ?? resolveUiFontCss(app.fontFamily) ?? DEFAULT_MONO_CSS,
    size: resolveSurfaceFontSize(settings, app, builtinSize),
  };
}

export const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * Stop every running shell and agent on ONE machine after a confirm
 * (a private plan › 16): `host` null = this machine,
 * else that remote host - Settings › Sessions and Settings › Hosts share it.
 * Resolves true once stopped, false when cancelled or when the machine
 * could not be reached (a host that is not connected: its sessions keep
 * running, and the user is told so).
 */
/**
 * What another computer attached to the same server means for a stop (M4,
 * a private plan › 14): its tabs show the same shells,
 * so they end there too.
 */
export function sharedHostNote(label: string, peers: number | undefined): string {
  if (!peers) return '';
  return peers === 1
    ? ` Another computer is connected to ${label}: its tabs show these sessions and end too.`
    : ` ${peers} other computers are connected to ${label}: their tabs show these sessions and end too.`;
}

export async function stopAllSessionsOn(
  host: { id: string; label: string } | null,
): Promise<boolean> {
  const peers = host ? getHostStatus(host.id)?.peers : undefined;
  const ok = await confirmDialog(
    host
      ? {
          title: `Stop all sessions on ${host.label}?`,
          description: `Every shell and agent running on ${host.label} ends now. Open tabs stay where they are and show the exit; this machine's sessions keep running.${sharedHostNote(host.label, peers)}`,
          confirmLabel: `Stop all on ${host.label}`,
          destructive: true,
          icon: Square,
        }
      : {
          title: 'Stop all sessions?',
          description:
            'Every running shell and agent ends now. Open tabs stay where they are and show the exit; a session resumes its conversation the next time its tab starts.',
          confirmLabel: 'Stop all sessions',
          destructive: true,
          icon: Square,
        },
  );
  if (!ok) return false;
  const stopped = await window.api?.sessions?.stopAll?.(host?.id ?? null);
  if (stopped === false && host) {
    await alertDialog({
      title: `${host.label} is not connected`,
      description: `Nothing was stopped: the sessions on ${host.label} keep running there. Connect to it, then stop them.`,
    });
    return false;
  }
  return stopped !== false;
}

/**
 * A session daemon's build id as people read it (src/main/daemon/daemon-paths.ts
 * › buildIdFor): a release is its version, a dev build its version plus the
 * day it was built (the id carries the entry's mtime in base 36).
 */
export function daemonBuildLabel(buildId: string): string {
  const dev = /^(.*)-dev-([0-9a-z]+)$/.exec(buildId);
  if (!dev) return buildId;
  const built = new Date(parseInt(dev[2], 36));
  // `x`: the entry's mtime was unknown when the id was made (buildIdFor).
  if (dev[2] === 'x' || Number.isNaN(built.getTime())) return `${dev[1]} (dev build)`;
  const day = built.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = built.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${dev[1]} (dev build, ${day} ${time})`;
}

/** "1 session" / "3 sessions". */
const sessionsCount = (n: number): string => (n === 1 ? '1 session' : `${n} sessions`);

/**
 * Settings › Sessions › Move now: an older daemon's terminals start again on
 * this version. Asks first when that loses anything: sessions working or
 * waiting on you (they restart mid-task), and agents whose conversation a
 * fresh start cannot bring back (Codex, or one typed by hand into a shell).
 * True once moved.
 */
export async function moveOlderSessions(socketPath: string, label: string): Promise<boolean> {
  const sessions = window.api?.sessions;
  if (!sessions?.moveDaemon) return false;
  const first = await sessions.moveDaemon(socketPath);
  if (!first) return false;
  const { busy, unresumable } = first;
  if (busy === 0 && unresumable === 0) return true;
  const lines: string[] = [];
  if (busy > 0)
    lines.push(
      `${sessionsCount(busy)} on ${label} ${busy === 1 ? 'is' : 'are'} working or waiting on you: moving stops what ${busy === 1 ? 'it is' : 'they are'} doing.`,
    );
  if (unresumable > 0)
    lines.push(
      `${unresumable === 1 ? 'One agent' : `${unresumable} agents`} cannot pick ${unresumable === 1 ? 'its' : 'their'} conversation up again here (Codex, or an agent started by hand) - ${unresumable === 1 ? 'it starts' : 'they start'} fresh.`,
    );
  const ok = await confirmDialog({
    title: `Restart ${sessionsCount(busy + unresumable)} on this version?`,
    description: `${lines.join(' ')} Every other agent resumes its conversation.`,
    confirmLabel: 'Move anyway',
    destructive: true,
  });
  if (!ok) return false;
  return (await sessions.moveDaemon(socketPath, true)) !== null;
}
