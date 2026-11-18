/**
 * The name the session daemon gives itself through `process.title`, or null
 * where it must not.
 *
 * On macOS Node's title setter is libuv's darwin-proctitle.c: it checks the
 * process in with LaunchServices (`LSApplicationCheckIn` with the main
 * bundle's Info.plist) so the new name shows in Activity Monitor. Under
 * ELECTRON_RUN_AS_NODE the main bundle is the app's own, an ordinary
 * `APPL` with neither `LSUIElement` nor `LSBackgroundOnly`, so the check-in
 * registers the headless daemon as a Foreground APPLICATION: the Dock
 * inserts a tile for it (`-[DockBar _handleLaunchNotification:]`, logged
 * within 10 ms of the check-in) and the app switcher lists it, for as long
 * as it lives - and a daemon is spawned at every session launch that finds
 * none of this build running (a rebuild, an idle exit). A plain `node` is
 * registered as BackgroundOnly by the same call (no Info.plist), which is
 * why it never shows. Verified 2026-10-15 with an NSWorkspace observer: the
 * same binary run as node with no title never registers.
 *
 * So the title is set everywhere but macOS, where a daemon is found by its
 * argv instead (`pgrep -fl 'out/main/daemon.js'`).
 */
export const DAEMON_PROCESS_TITLE = 'double0-session-daemon';

export function daemonProcessTitle(platform: NodeJS.Platform): string | null {
  return platform === 'darwin' ? null : DAEMON_PROCESS_TITLE;
}
