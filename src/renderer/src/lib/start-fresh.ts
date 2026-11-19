/**
 * A way out of a window that crashes as it opens. A reload restores the view
 * the window showed - the address it was on, the project and session it
 * remembers (lib/last-project-session.ts, lib/startup-target.ts) - and when
 * that view is what fails to render, a plain reload only fails again. "Start
 * fresh" reloads onto a project's session list instead, with nothing
 * reopened; nothing is deleted (projects, sessions, their layouts and the
 * settings all stay), only this one boot skips the restore.
 *
 * The same happens by itself when the window lands on the error screen
 * again within `CRASH_LOOP_MS` of a reload that followed one: whoever keeps
 * pressing Reload gets out without having to know which button helps.
 *
 * Window memory (sessionStorage): it survives the window's reload, and every
 * window - a torn-off one too - has its own.
 */

const START_FRESH_KEY = 'double0-start-fresh';
const CRASH_AT_KEY = 'double0-crash-at';

/** A crash this soon after a boot that followed a crash is a loop. */
export const CRASH_LOOP_MS = 15_000;

let bootAt = 0;
let startingFresh = false;
let crashedThisBoot: boolean | null = null;
let forgetTimer: ReturnType<typeof setTimeout> | null = null;

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // No storage: the buttons still reload, only the next boot cannot be steered.
  }
}

/**
 * Called once as the window boots, before anything routes: reads (and clears)
 * a start-fresh request, so it applies to exactly this boot. Returns whether
 * this boot starts fresh.
 */
export function beginBoot(now: number = Date.now()): boolean {
  bootAt = now;
  crashedThisBoot = null;
  startingFresh = read(START_FRESH_KEY) === '1';
  write(START_FRESH_KEY, null);
  // A boot that ran this long without a crash is no loop: forget the last one,
  // or a crash much later (after a reload for any reason) would read as one.
  if (forgetTimer) clearTimeout(forgetTimer);
  forgetTimer = setTimeout(() => {
    forgetTimer = null;
    // Only a boot with no crash at all: `false` is a crash that was no loop,
    // and its mark must outlive however long the screen is read.
    if (crashedThisBoot === null) write(CRASH_AT_KEY, null);
  }, CRASH_LOOP_MS);
  return startingFresh;
}

/** Whether this boot skips restoring the last view (until the user opens a session). */
export function isStartingFresh(): boolean {
  return startingFresh;
}

/** The user opened something: from here on the window behaves as usual. */
export function endStartFresh(): void {
  startingFresh = false;
}

/** Ask the NEXT boot of this window to start fresh. */
export function requestStartFresh(): void {
  write(START_FRESH_KEY, '1');
}

/** Whether the next boot will start fresh (the error screen says so). */
export function startFreshRequested(): boolean {
  return read(START_FRESH_KEY) === '1';
}

/**
 * The window landed on the error screen. Returns true when this is a crash
 * loop - a crash within `CRASH_LOOP_MS` of a boot that itself followed a
 * crash - in which case the next boot starts fresh by itself. Counted once
 * per boot, however often the screen renders.
 */
export function noteCrashScreen(now: number = Date.now()): boolean {
  if (crashedThisBoot !== null) return crashedThisBoot;
  const previous = read(CRASH_AT_KEY);
  write(CRASH_AT_KEY, String(now));
  crashedThisBoot = previous !== null && now - bootAt <= CRASH_LOOP_MS;
  if (crashedThisBoot) requestStartFresh();
  return crashedThisBoot;
}

/** Tests: forget this window's boot. */
export function resetStartFreshForTest(): void {
  if (forgetTimer) clearTimeout(forgetTimer);
  forgetTimer = null;
  bootAt = 0;
  startingFresh = false;
  crashedThisBoot = null;
}

/** What the error screen's buttons do to the window (a seam: jsdom cannot reload). */
export const windowActions = {
  reload: (): void => window.location.reload(),
  close: (): void => window.close(),
};
