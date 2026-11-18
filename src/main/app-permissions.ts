/**
 * Which permission requests the app's own renderer (the default session) is
 * granted. Nothing in the app uses camera / mic / geolocation / notifications,
 * so everything is denied except a clipboard write: Electron routes
 * `navigator.clipboard.writeText` through the request handler as
 * `clipboard-sanitized-write`, and denying it made every Copy item (the
 * explorer's Copy path, a browser tab's Copy URL) silently copy nothing.
 * Browser tab pages live on their own partition and never reach this.
 */
export function appPermissionGranted(permission: string): boolean {
  return permission === 'clipboard-sanitized-write';
}
