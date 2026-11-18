/**
 * The app's two-pass quit, kept free of Electron so its ordering can be tested.
 *
 * Pass one (the first `will-quit`): hold the quit, tear down IPC + terminals,
 * close the embedded DB (capped, so a hung close never blocks quitting), then
 * ask Electron to quit again. Pass two (the `will-quit` that follows): let it
 * through.
 *
 * The re-issued quit MUST land on a later macrotask (`defer`, setImmediate by
 * default). Electron clears its internal "quitting" flag only after the
 * `will-quit` listener has returned, and it drains microtasks at the end of the
 * outermost native-to-JS callback. A quit that starts natively - the Dock's
 * Quit, any quit Apple event, logout - emits `will-quit` as that outermost
 * callback, so a continuation that calls `app.quit()` straight from the DB
 * close promise (PGlite closes without ever leaving the microtask queue) runs
 * while the flag is still set and Electron drops it. The process then lives on
 * with no windows and no IPC: the Dock dot stays, and a relaunch reopens THAT
 * process onto a dashboard stuck on "Loading..." (2026-09-16). Cmd+Q never
 * showed it because a menu click is itself a callback, so the drain waits for
 * it and the flag is already clear.
 */
export interface QuitSequenceOptions {
  /**
   * Teardown (IPC handlers, terminals). A throw here must not stall the quit. A
   * returned promise (the killed shells reporting their exit) is awaited with the
   * DB close, under the same cap.
   */
  dispose: () => void | Promise<unknown>;
  /** Closes the embedded DB; raced (with `dispose`'s promise) against `closeTimeoutMs`. */
  closeDb: () => Promise<void>;
  /** Asks Electron to quit again (`app.quit`). */
  requestQuit: () => void;
  /** Schedules the re-issued quit on a later macrotask. Default: `setImmediate`. */
  defer?: (fn: () => void) => void;
  /** Cap on the DB close and the dispose wait, in ms. Default 2000. */
  closeTimeoutMs?: number;
  /** Reports a failed disposer or DB close. Default: `console.error`. */
  onError?: (err: unknown) => void;
}

/** Where the sequence stands: the first `will-quit` moves it to `closing`, the DB close to `closed`. */
export type QuitPhase = 'running' | 'closing' | 'closed';

export interface WillQuitHandler {
  (event: { preventDefault(): void }): void;
  /** Current phase, for diagnostics and tests. */
  readonly phase: QuitPhase;
}

export function createWillQuitHandler(opts: QuitSequenceOptions): WillQuitHandler {
  const defer = opts.defer ?? ((fn: () => void): void => void setImmediate(fn));
  const closeTimeoutMs = opts.closeTimeoutMs ?? 2000;
  const onError =
    opts.onError ?? ((err: unknown): void => console.error('quit: teardown failed:', err));
  let phase: QuitPhase = 'running';

  const handler = (event: { preventDefault(): void }): void => {
    // Pass two: the quit we re-issued ourselves - let Electron finish.
    if (phase === 'closed') return;
    event.preventDefault();
    // Already closing: hold this one too, but never tear down twice.
    if (phase === 'closing') return;
    phase = 'closing';

    let disposed: Promise<unknown> = Promise.resolve();
    try {
      disposed = Promise.resolve(opts.dispose()).then(undefined, onError);
    } catch (err) {
      onError(err);
    }

    let cap: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<void>((resolve) => {
      cap = setTimeout(resolve, closeTimeoutMs);
    });
    let closed: Promise<void>;
    try {
      closed = opts.closeDb().then(undefined, onError);
    } catch (err) {
      // A close that throws before returning its promise.
      onError(err);
      closed = Promise.resolve();
    }
    void Promise.race([Promise.all([disposed, closed]), capped]).then(() => {
      clearTimeout(cap);
      phase = 'closed';
      // Not `requestQuit()` here: this runs in the microtask drain of the
      // `will-quit` emit when the quit started natively - see the module doc.
      defer(opts.requestQuit);
    });
  };

  return Object.defineProperty(handler, 'phase', { get: () => phase }) as WillQuitHandler;
}
