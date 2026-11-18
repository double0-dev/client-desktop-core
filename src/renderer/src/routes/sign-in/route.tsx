import { createFileRoute, redirect } from '@tanstack/react-router';
import { rendererExtension } from '@renderer/lib/extension/registry';

/**
 * The sign-in route. Login is Pro (a private plan ›
 * decision 15): its screen and its gate come from the renderer extension. The
 * core build has no account at all, so this route only sends you home there;
 * the official build shows Pro's screen while its gate says signed out.
 */
export const Route = createFileRoute('/sign-in')({
  beforeLoad: async () => {
    const auth = rendererExtension().auth;
    if (!auth || (await auth.status()) !== 'signed-out') throw redirect({ to: '/' });
  },
  component: SignInRoute,
});

function SignInRoute() {
  const Screen = rendererExtension().auth?.SignInScreen;
  return Screen ? <Screen /> : null;
}
