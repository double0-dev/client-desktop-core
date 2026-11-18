import { useEffect } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { agentSessionsCollection, projectsCollection } from '@renderer/lib/collections';
import { setProjectAccent } from '@renderer/lib/settings/accent-color';

/**
 * Paint this window with the open project's color while it is mounted
 * (a private plan). Pass the project, or a session to find
 * its project by; neither (the no-project workspace) or a project with no color leaves
 * the stored accent. Mount it once per window.
 */
export function useProjectAccent(open: { projectId?: string | null; sessionId?: string | null }) {
  const { data: projects } = useLiveQuery((q) => q.from({ project: projectsCollection }));
  const { data: sessions } = useLiveQuery((q) => q.from({ session: agentSessionsCollection }));
  const projectId =
    open.projectId ??
    (open.sessionId ? (sessions?.find((s) => s.id === open.sessionId)?.projectId ?? null) : null);
  const color = projectId ? (projects?.find((p) => p.id === projectId)?.color ?? null) : null;
  useEffect(() => {
    setProjectAccent(color);
    return () => setProjectAccent(null);
  }, [color]);
}
