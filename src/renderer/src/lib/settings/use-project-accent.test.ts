import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROJECTS = [
  { id: 'p1', color: '#2fbfa5' },
  { id: 'p2', color: null },
];
const SESSIONS = [{ id: 's1', projectId: 'p1' }];

const { projectsCollection, agentSessionsCollection } = vi.hoisted(() => ({
  projectsCollection: { name: 'projects' },
  agentSessionsCollection: { name: 'sessions' },
}));
vi.mock('@renderer/lib/collections', () => ({ projectsCollection, agentSessionsCollection }));
// Answer each live query by the collection it reads.
vi.mock('@tanstack/react-db', () => ({
  useLiveQuery: (query: (q: { from: (src: Record<string, unknown>) => unknown }) => unknown) => {
    const src = query({ from: (s) => s }) as Record<string, unknown>;
    return { data: 'project' in src ? PROJECTS : SESSIONS };
  },
}));

const { getEffectiveAccentColor, DEFAULT_ACCENT_COLOR } =
  await import('@renderer/lib/settings/accent-color');
const { useProjectAccent } = await import('./use-project-accent');

describe('useProjectAccent', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("paints the project's color while mounted and clears it on unmount", () => {
    const { unmount } = renderHook(() => useProjectAccent({ projectId: 'p1' }));
    expect(getEffectiveAccentColor()).toBe('#2fbfa5');
    unmount();
    expect(getEffectiveAccentColor()).toBe(DEFAULT_ACCENT_COLOR);
  });

  it("finds a session's project", () => {
    const { unmount } = renderHook(() => useProjectAccent({ sessionId: 's1' }));
    expect(getEffectiveAccentColor()).toBe('#2fbfa5');
    unmount();
  });

  it('follows the route from a colored project to one without and to no project', () => {
    const { rerender, unmount } = renderHook(
      (open: { projectId?: string }) => useProjectAccent(open),
      { initialProps: { projectId: 'p1' } as { projectId?: string } },
    );
    rerender({ projectId: 'p2' });
    expect(getEffectiveAccentColor()).toBe(DEFAULT_ACCENT_COLOR);
    rerender({ projectId: 'p1' });
    expect(getEffectiveAccentColor()).toBe('#2fbfa5');
    rerender({});
    expect(getEffectiveAccentColor()).toBe(DEFAULT_ACCENT_COLOR);
    unmount();
  });
});
