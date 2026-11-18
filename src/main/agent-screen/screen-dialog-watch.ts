/**
 * The session status of a Claude that waits on a dialog no hook reports
 * (new MCP servers in the project, the folder's trust - claude-screen.ts ›
 * parseScreenDialog): the markers say idle, the TUI waits on the user. This
 * reads each mirrored terminal's screen (screen-mirror.ts) after its output
 * settles and puts the missing markers into the stream the window gets:
 * `needs-input` (with the dialog's title, the alert's body) once such a
 * dialog has stood for a moment, then `ready` - idle, quietly - when it goes;
 * `ended` instead when Claude never came up (a trust dialog answered "No,
 * exit"), so a plain shell goes back to the fallback rules.
 *
 * Only while the agent's own status is idle or unknown: a permission, a
 * question or the plan dialog carries its own `needs-input`. Pure node.
 */
import type { AgentStatus } from '../terminal-modes';
import { STATUS_OSC } from '../claude-status-hooks';
import { parseScreenDialog } from './claude-screen';

export type ScreenDialogWatchDeps = {
  /** The terminal's screen copy; null when it is not mirrored. */
  lines(id: string): string[] | null;
  /** The agent status the markers left (null = no marker / Claude ended). */
  status(id: string): Promise<AgentStatus | null>;
  /**
   * Hand `data` to the window showing the terminal, as if the pty wrote it;
   * false when no window takes it now (none, or one mid-adopt).
   */
  inject(id: string, data: string): boolean;
  /** How long a dialog stands before it counts (a hook's own dialog draws first). */
  settleMs?: number;
  /** Quiet after output before the screen is read. */
  checkMs?: number;
  now?: () => number;
};

type Watch = {
  timer: ReturnType<typeof setTimeout> | null;
  /** Since when a dialog has been on screen (0 = none). */
  since: number;
  /** The `needs-input` went out; the next clear screen sends the way back. */
  shown: boolean;
  checking: boolean;
};

export const SCREEN_DIALOG_SETTLE_MS = 900;
const CHECK_MS = 200;

export function statusMarker(verb: string, payload?: string): string {
  return `\u001b]${STATUS_OSC};${verb}${payload ? `;${payload}` : ''}\u0007`;
}

export class ScreenDialogWatch {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly deps: ScreenDialogWatchDeps) {}

  /** The terminal wrote output: read its screen once it is quiet. */
  data(id: string): void {
    // At most one read per window: a TUI that keeps repainting must not
    // push the read off for good.
    if (this.watch(id).timer) return;
    this.schedule(id, this.deps.checkMs ?? CHECK_MS);
  }

  forget(id: string): void {
    const w = this.watches.get(id);
    if (w?.timer) clearTimeout(w.timer);
    this.watches.delete(id);
  }

  dispose(): void {
    for (const id of [...this.watches.keys()]) this.forget(id);
  }

  private watch(id: string): Watch {
    let w = this.watches.get(id);
    if (!w) {
      w = { timer: null, since: 0, shown: false, checking: false };
      this.watches.set(id, w);
    }
    return w;
  }

  private schedule(id: string, ms: number): void {
    const w = this.watch(id);
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.timer = null;
      void this.check(id);
    }, ms);
  }

  /** One read of the screen. */
  private async check(id: string): Promise<void> {
    const w = this.watches.get(id);
    if (!w || w.checking) return;
    const lines = this.deps.lines(id);
    // Not mirrored (a plain shell, never a marker): nothing to say.
    if (!lines) return;
    const dialog = parseScreenDialog(lines);
    const now = (this.deps.now ?? Date.now)();
    if (!dialog) {
      w.since = 0;
      if (!w.shown) return;
      w.shown = false;
      w.checking = true;
      try {
        const status = await this.deps.status(id).catch(() => null);
        if (this.watches.get(id) !== w) return;
        this.deps.inject(id, statusMarker(status === null ? 'ended' : 'ready'));
      } finally {
        w.checking = false;
      }
      return;
    }
    if (w.shown) return;
    const settle = this.deps.settleMs ?? SCREEN_DIALOG_SETTLE_MS;
    if (w.since === 0) w.since = now;
    if (now - w.since < settle) {
      this.schedule(id, settle - (now - w.since));
      return;
    }
    w.checking = true;
    try {
      const status = await this.deps.status(id).catch(() => null);
      // A hook's own dialog (a permission, a question, the plan) or a turn
      // in flight: its markers speak for it.
      if (status !== null && status !== 'idle') return;
      if (this.watches.get(id) !== w) return;
      // Still up after the round trip.
      const again = this.deps.lines(id);
      if (!again || !parseScreenDialog(again)) return;
      // Not taken (no window now): the next output or read tries again.
      w.shown = this.deps.inject(
        id,
        statusMarker('needs-input', Buffer.from(dialog.title, 'utf8').toString('base64')),
      );
    } finally {
      w.checking = false;
    }
  }
}
