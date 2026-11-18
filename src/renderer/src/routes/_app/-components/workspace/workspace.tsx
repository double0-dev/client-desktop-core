/**
 * Composition root for the session workspace, kept as the import path the rest
 * of the app uses (`routes/_app.tsx` mounts `WorkspaceHost`). The
 * implementation lives in focused modules:
 *
 * - `workspace-host.tsx` - session lifecycle: which views are mounted, the LRU
 *   cap on hidden ones, cross-window release/return, seed-layout bookkeeping.
 * - `workspace-chrome.tsx` - one session's window chrome: top bar, icon rail,
 *   tool dock, session sidebar.
 * - `workspace-surface.tsx` - the content surface inside the layout provider:
 *   file explorer, terminal body, layout persistence, status bar.
 */
export { WorkspaceHost } from '@renderer/routes/_app/-components/workspace/workspace-host';
