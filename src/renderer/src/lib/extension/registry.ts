import type { RailTabId } from '@renderer/lib/workspace/dock-state';
import type { RailTool, RendererExtension } from './types';

/**
 * The installed renderer extension. `main.tsx` calls
 * `installRendererExtension` once, before `boot()` renders; every reader
 * after that sees the same object for the window's lifetime. Until then (and
 * in tests that never install one) it is the core build's empty extension.
 *
 * Never read it at module load: imports are evaluated before main.tsx's body
 * runs, so a module-level read sees the empty extension.
 */
const CORE_EXTENSION: RendererExtension = { edition: 'core', railTools: [] };

let installed: RendererExtension = CORE_EXTENSION;

export function installRendererExtension(extension: RendererExtension): void {
  installed = extension;
  extension.start?.();
}

/** The installed extension - static after boot, so safe outside React too. */
export function rendererExtension(): RendererExtension {
  return installed;
}

/** The registered rail tool with this id, if Pro registered one. */
export function railTool(id: RailTabId): RailTool | undefined {
  return installed.railTools.find((t) => t.id === id);
}

/** For tests: back to the core build's empty extension. */
export function resetRendererExtensionForTest(): void {
  installed = CORE_EXTENSION;
}
