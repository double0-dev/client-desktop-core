/**
 * Links on the app's own scheme (`DESKTOP_PROTOCOL_SCHEME`, app-icon.ts),
 * kept pure so it's unit-testable without Electron. Core only finds them and
 * brings the app to the front; what a link means is the extension's
 * (`MainExtension.handleDeepLink`, src/main/extension.ts).
 */

/** The first argv entry on the app's scheme - Windows / Linux deliver links as a launch argument. */
export function findAppLink(argv: readonly string[], scheme: string): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(`${scheme}:`)) return arg;
  }
  return null;
}
