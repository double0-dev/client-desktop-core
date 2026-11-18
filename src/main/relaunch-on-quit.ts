/**
 * A restart an extension asked for (`MainContext.restartStoppingSessions`),
 * held until the quit can no longer be called off. A window that refuses to
 * unload (unsaved editor edits) stops a quit after the user agreed to it -
 * Electron cannot take back an `app.relaunch()`, and whatever the restart
 * was for must not happen at some later, unrelated quit. So nothing runs
 * when the restart is agreed: `commit` runs it from `will-quit` (every
 * window is gone by then), `abort` drops it when the quit is called off.
 */
export type PendingRelaunch = {
  /** Runs right before the relaunch is armed, once the quit is certain. */
  beforeRelaunch: () => void;
  /** The quit was called off: nothing ran. */
  onAborted?: () => void;
};

export type RelaunchOnQuit = {
  /** Hold a restart for this quit; false when one is already held. */
  arm(pending: PendingRelaunch): boolean;
  held(): boolean;
  /** The quit was called off: drop the restart and say so. */
  abort(): void;
  /**
   * The quit goes through: run `beforeRelaunch`, then relaunch. A throw in
   * `beforeRelaunch` drops the relaunch - the app quits and stays quit
   * rather than restarting half-prepared. Returns whether it relaunches.
   */
  commit(): boolean;
};

export function createRelaunchOnQuit(relaunch: () => void): RelaunchOnQuit {
  let pending: PendingRelaunch | null = null;
  return {
    arm(next) {
      if (pending) return false;
      pending = next;
      return true;
    },
    held: () => pending !== null,
    abort() {
      const dropped = pending;
      pending = null;
      try {
        dropped?.onAborted?.();
      } catch (err) {
        console.error('restart: onAborted failed:', err);
      }
    },
    commit() {
      const run = pending;
      pending = null;
      if (!run) return false;
      try {
        run.beforeRelaunch();
      } catch (err) {
        console.error('restart: dropped, its preparation failed:', err);
        return false;
      }
      relaunch();
      return true;
    },
  };
}
