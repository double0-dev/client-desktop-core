import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyThemeClass,
  emitThemeChange,
  resolveStoredTheme,
  ThemeContext,
  THEME_STORAGE_KEY,
} from '@renderer/lib/settings/theme';
import type { Theme } from '@renderer/lib/settings/theme';
import { SETTINGS_APPLIED_EVENT } from '@renderer/lib/settings/settings-events';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(resolveStoredTheme);

  // Keep the <html> class in sync with state. We intentionally do NOT persist
  // here - that would pin the implicit default into storage on first launch,
  // making it impossible to later distinguish "unset" (e.g. to follow the OS
  // colour scheme). Persistence happens only on explicit user action below.
  useEffect(() => {
    applyThemeClass(theme);
    // Keep the native window chrome in sync: the macOS traffic lights and the
    // Windows / Linux controls overlay, which main re-tints from this message.
    window.api?.setNativeTheme?.(theme);
    // Let non-React consumers (the xterm pool's "auto" theme, terminal bg
    // swatches) re-tint immediately instead of waiting for the next render.
    emitThemeChange(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  // The JSON settings editor / import write the theme straight to localStorage
  // and announce it - re-read so it applies without a restart.
  useEffect(() => {
    const onApplied = (): void => setThemeState(resolveStoredTheme());
    window.addEventListener(SETTINGS_APPLIED_EVENT, onApplied);
    return () => window.removeEventListener(SETTINGS_APPLIED_EVENT, onApplied);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
