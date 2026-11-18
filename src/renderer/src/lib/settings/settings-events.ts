// Fired (window-level) after settings are written to localStorage from OUTSIDE
// their owning stores - the JSON settings editor and the import flow. Stores
// that read localStorage once at init (usePersistedState, ThemeProvider)
// subscribe and re-decode so external writes apply live, without a restart.
export const SETTINGS_APPLIED_EVENT = 'double0-settings-applied';

export function emitSettingsApplied(): void {
  window.dispatchEvent(new Event(SETTINGS_APPLIED_EVENT));
}
