import type { Tab, TabKind } from '@renderer/lib/workspace/layout';
import { rendererExtension } from '@renderer/lib/extension/registry';

/**
 * Which tab kinds this build renders. A saved layout can hold a tab of a kind
 * this build does not render - written by a build with an extension, or by a
 * newer version. Such a tab is kept in the layout (dropping it would reset
 * the session's tabs, and the build that wrote it may open the layout again),
 * never spawns a shell, and shows a placeholder.
 *
 * An extension's kinds come back through the renderer extension: a page tab's
 * with `RendererExtension.browser` (`tabKind`), a view's with
 * `RendererExtension.sessionView`.
 */
export const CORE_TAB_KINDS: readonly TabKind[] = ['conversation', 'terminal', 'editor'];

/** Whether this build renders a tab of `kind`. */
export function rendersTabKind(kind: string): kind is TabKind {
  if ((CORE_TAB_KINDS as readonly string[]).includes(kind)) return true;
  const ext = rendererExtension();
  return kind === ext.browser?.tabKind || kind === ext.sessionView?.view;
}

/** Whether `kind` is this build's page tab kind (`BrowserSlot.tabKind`). */
export function isPageTabKind(kind: string): boolean {
  return kind === rendererExtension().browser?.tabKind;
}

/**
 * Whether a shell tab shows in an extension's view over its agent CLI. A tab a
 * build with that view saved so shows its terminal in a build without it -
 * the terminal then takes the keys as usual.
 */
export function showsView(tab: Pick<Tab, 'view'>): boolean {
  const view = rendererExtension().sessionView?.view;
  return view !== undefined && tab.view === view;
}
