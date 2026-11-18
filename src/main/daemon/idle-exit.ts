/**
 * When the session daemon may exit (a private plan): no
 * terminals and no clients, and that for a short grace period - a client
 * that disconnects right after closing its last tab, or an app restarting,
 * reconnects within it and finds the daemon still there. Pure.
 */
export type IdleState = { terminals: number; clients: number };

/** Default grace before an empty, unattended daemon exits. */
export const IDLE_EXIT_GRACE_MS = 10_000;

export function isIdle(state: IdleState): boolean {
  return state.terminals === 0 && state.clients === 0;
}

/**
 * Arms the grace timer whenever the state turns idle and cancels it the
 * moment it stops being idle; `onExit` fires once the grace elapsed with the
 * daemon idle throughout.
 */
export class IdleExitWatch {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly graceMs: number,
    private readonly onExit: () => void,
    private readonly timers: {
      set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
      clear: (t: ReturnType<typeof setTimeout>) => void;
    } = { set: setTimeout, clear: clearTimeout },
  ) {}

  update(state: IdleState): void {
    if (isIdle(state)) {
      if (this.timer) return;
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.onExit();
      }, this.graceMs);
    } else if (this.timer) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  /** Whether the grace timer is running (tests, diagnostics). */
  get armed(): boolean {
    return this.timer !== null;
  }

  dispose(): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }
}
