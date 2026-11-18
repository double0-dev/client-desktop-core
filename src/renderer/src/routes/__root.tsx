import '../assets/globals.css';
import { useEffect } from 'react';
import { createRootRoute, Outlet, useNavigate } from '@tanstack/react-router';
import { ThemeProvider } from '@renderer/routes/-components/theme-provider';

export const Route = createRootRoute({
  component: () => (
    <ThemeProvider>
      <div className="min-h-screen bg-background text-foreground">
        <Outlet />
      </div>
    </ThemeProvider>
  ),
  // A route that no longer exists (a reload on a removed screen's address,
  // e.g. the old dashboard) starts over where the app opens.
  notFoundComponent: StartOver,
});

function StartOver() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: '/', replace: true });
  }, [navigate]);
  return null;
}
