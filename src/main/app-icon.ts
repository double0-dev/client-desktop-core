import { app } from 'electron';
import {
  isDemoInstance,
  resolveAppEnv,
  resolveDesktopProtocol,
  resolveShownEnv,
  type AppEnv,
} from './app-env';
import { EDITION } from './edition';
import productionIconPath from '../../resources/icon.png?asset';
import localIconPath from '../../resources/icon-dev.png?asset';

/**
 * This instance's environment (app-env.ts has the rule), decided once at
 * load: neither input changes while the app runs. `process.env.VITE_API_URL`
 * is the value scripts/main-env.mjs inlines into the bundle - the same one
 * auth-client.ts talks to, read here directly so the icon modules below don't
 * drag the auth client into every test that loads them.
 */
export const APP_ENV: AppEnv = resolveAppEnv({
  packaged: app.isPackaged,
  apiBaseUrl: process.env.VITE_API_URL,
  edition: EDITION,
});

/**
 * What this instance looks like (app-env.ts › `resolveShownEnv`): `APP_ENV`
 * except for a `DOUBLE0_DEMO=1` dev instance, which shows no dev tells. Only
 * the tells read it - the icon, the title suffix and the DEV badge; userData,
 * the deep-link scheme and crash reporting stay on `APP_ENV`.
 */
/** The seeded marketing instance (app-env.ts › `isDemoInstance`): no traffic lights. */
export const DEMO_INSTANCE: boolean = isDemoInstance({
  packaged: app.isPackaged,
  demo: process.env.DOUBLE0_DEMO,
});

export const SHOWN_ENV: AppEnv = resolveShownEnv({
  env: APP_ENV,
  packaged: app.isPackaged,
  demo: process.env.DOUBLE0_DEMO,
});

/**
 * The deep-link scheme this instance registers (`com.double0.desktop`, or
 * `com.double0.desktop-dev` for local, `-core` in the core build - app-env.ts
 * has the why). The
 * `VITE_DESKTOP_PROTOCOL` override is inlined by scripts/main-env.mjs.
 */
export const DESKTOP_PROTOCOL_SCHEME = resolveDesktopProtocol(
  process.env.VITE_API_URL,
  process.env.VITE_DESKTOP_PROTOCOL,
  EDITION,
  app.isPackaged,
);

/**
 * The launcher icon for this environment: the green "00" for production, the
 * red one (scripts/derive-dev-icon.py) for local, so two instances side by
 * side in a dock or taskbar cannot be mistaken for each other. Used wherever
 * main shows the logo at runtime - the macOS dock (and the status dot badge.ts
 * composites onto it), the Linux window icon, Windows/Linux notification
 * banners. The dev Electron.app bundle itself is stamped red at postinstall
 * (scripts/dev-app-icon.sh); packaged builds get build/icon.png from
 * electron-builder, which is why a local packaged build still shows the red
 * icon in the dock but the green one in Finder.
 */
export const APP_ICON_PATH = SHOWN_ENV === 'local' ? localIconPath : productionIconPath;
