import { rendererExtension } from '@renderer/lib/extension/registry';

/**
 * Log a render failure a boundary caught and hand it to the extension's
 * reporter: a caught error never reaches the window's global error handlers,
 * so without this it would only show in the console.
 */
export function reportRenderError(error: unknown, where: string, componentStack?: string): void {
  console.error(`[${where}] failed to render:`, error, componentStack ?? '');
  try {
    rendererExtension().reportError?.(error, where);
  } catch (err) {
    // A reporter that throws must not turn a contained failure into a crash.
    console.error('error reporter failed:', err);
  }
}
