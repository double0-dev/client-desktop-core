import { createContext, useContext, useSyncExternalStore } from 'react';

// Theme model + context, kept out of theme-provider.tsx so that file exports
// only the <ThemeProvider> component (react-refresh needs component-only files
// for reliable hot reloading).

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'double0-theme';

/** Dark-first: anything other than an explicit "light" resolves to dark. */
export function resolveStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
}

/** Apply the theme class synchronously. Call once before render to avoid a flash. */
export function applyThemeClass(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

// Non-React consumers need to react to appearance changes too: the pooled xterm
// instances that follow the "auto" terminal theme, and the terminal background
// swatches. React state lives in <ThemeProvider>, so it broadcasts here on every
// change. A `storage` listener relays changes made in OTHER windows (the main
// window toggling while a torn-off window is open) so their terminals - and that
// window's own chrome, which has no ThemeProvider - follow along.
const themeListeners = new Set<(theme: Theme) => void>();

export function subscribeTheme(listener: (theme: Theme) => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

export function emitThemeChange(theme: Theme): void {
  for (const listener of themeListeners) listener(theme);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    const theme = resolveStoredTheme();
    applyThemeClass(theme);
    emitThemeChange(theme);
  });
}

/** Subscribe a component to the resolved app theme; re-renders live on change. */
export function useAppTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, resolveStoredTheme, () => 'dark');
}

export type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
};

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
