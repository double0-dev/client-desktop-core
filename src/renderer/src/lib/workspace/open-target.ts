import type { UseNavigateResult } from '@tanstack/react-router';
import type { OpenTarget } from '@renderer/lib/startup-target';

/**
 * Navigates to a `startupTarget` / `projectOpenTarget` answer - the union
 * narrowed per route, so every caller opens projects the same way.
 */
export function goToTarget(
  navigate: UseNavigateResult<string>,
  target: OpenTarget,
  options: { replace?: boolean } = {},
): void {
  if (target.to === '/sessions/$sessionId') {
    void navigate({ to: target.to, params: target.params, ...options });
  } else if (target.to === '/workspace/$projectId') {
    void navigate({ to: target.to, params: target.params, ...options });
  } else {
    void navigate({ to: target.to, ...options });
  }
}
