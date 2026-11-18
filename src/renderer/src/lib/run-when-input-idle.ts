/**
 * Run a long main-thread job (a warmup that blocks for hundreds of ms) only
 * after `delayMs`, once the user has left the keyboard, pointer, wheel and
 * window size alone for `inputIdleMs`, and in an idle callback. A window
 * resize counts: dragging its edge sends no DOM input, and the job landed in
 * the middle of one. An idle callback alone
 * only knows the thread is free right now: a dock opened or a tab switched
 * while the job ran waited for it to finish. `idleTimeoutMs` bounds the wait
 * for the thread, so the job does run eventually. Returns a cancel.
 */
export function runWhenInputIdle(
  run: () => void,
  opts: { delayMs: number; inputIdleMs: number; idleTimeoutMs: number },
): () => void {
  if (typeof window.requestIdleCallback !== 'function') return () => {};
  let lastInput = performance.now();
  const onInput = (): void => {
    lastInput = performance.now();
  };
  const inputs = ['keydown', 'pointerdown', 'wheel', 'resize'] as const;
  for (const type of inputs) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }
  const stopListening = (): void => {
    for (const type of inputs) window.removeEventListener(type, onInput, { capture: true });
  };
  let timer = 0;
  let idle: number | null = null;
  const attempt = (): void => {
    const sinceInput = performance.now() - lastInput;
    if (sinceInput < opts.inputIdleMs) {
      timer = window.setTimeout(attempt, opts.inputIdleMs - sinceInput);
      return;
    }
    idle = window.requestIdleCallback(
      (deadline) => {
        idle = null;
        // The user may have come back while it waited for the thread.
        if (!deadline.didTimeout && performance.now() - lastInput < opts.inputIdleMs) {
          attempt();
          return;
        }
        stopListening();
        run();
      },
      { timeout: opts.idleTimeoutMs },
    );
  };
  timer = window.setTimeout(attempt, opts.delayMs);
  return () => {
    window.clearTimeout(timer);
    if (idle != null) window.cancelIdleCallback(idle);
    stopListening();
  };
}
