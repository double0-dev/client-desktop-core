import type { RendererExtension } from '../renderer/src/lib/extension/types';

/** The core build's `@pro/renderer`: no Pro surfaces. */
export const proRenderer: RendererExtension = {
  edition: 'core',
  railTools: [],
};
