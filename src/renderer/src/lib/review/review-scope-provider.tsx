import { useMemo, useRef, type ReactNode } from 'react';
import { ReviewScopeContext, type ReviewScope } from '@renderer/lib/review/review-scope';
import { useWorkspaceLayout } from '@renderer/lib/workspace/layout-context';

/** Scope the subtree's diffs to a session. Must sit inside its WorkspaceLayoutProvider. */
export function ReviewScopeProvider({
  sessionId,
  agentCwd,
  children,
}: {
  sessionId: string;
  agentCwd: string | null;
  children: ReactNode;
}) {
  const { layout } = useWorkspaceLayout();
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const scope = useMemo<ReviewScope>(
    () => ({ sessionId, agentCwd, getLayout: () => layoutRef.current }),
    [sessionId, agentCwd],
  );
  return <ReviewScopeContext.Provider value={scope}>{children}</ReviewScopeContext.Provider>;
}
