import { createContext, useContext } from 'react';
import type { WorkspaceLayout } from '@renderer/lib/workspace/layout';

/**
 * Which session a diff's comments belong to. Provided around the drawer and
 * the tools of a session view (main window and a torn-off session's window); absent (a project with
 * no session, a torn-off tab's window) = diffs offer no comments, since there
 * is no agent to send them to.
 */
export type ReviewScope = {
  sessionId: string;
  /** The session's own folder - where its agent runs, what prompt paths are relative to. */
  agentCwd: string | null;
  /** The session's live layout - which tab a send goes to is read at send time. */
  getLayout: () => WorkspaceLayout | null;
};

export const ReviewScopeContext = createContext<ReviewScope | null>(null);

export function useReviewScope(): ReviewScope | null {
  return useContext(ReviewScopeContext);
}
