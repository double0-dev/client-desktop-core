import type { DesktopApi } from './index';

declare global {
  interface Window {
    // `electron` (raw @electron-toolkit/preload surface) is intentionally not
    // exposed - only the curated `api`. See src/preload/index.ts.
    api: DesktopApi;
  }
}

export {};
