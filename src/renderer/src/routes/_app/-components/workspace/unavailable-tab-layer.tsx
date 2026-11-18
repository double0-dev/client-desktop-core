import { memo } from 'react';
import { PackageX } from 'lucide-react';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { allTabs, paneOf, type NodeId, type WorkspaceLayout } from '@renderer/lib/workspace/layout';
import { rendersTabKind } from '@renderer/lib/workspace/tab-kinds';
import type { PaneRect } from '@renderer/lib/workspace/use-pane-rects';

/**
 * Covers a tab whose kind this build does not render (lib/workspace/tab-kinds.ts):
 * a layout written by the official build after a tab kind moved to Pro, or by a
 * newer version. The tab stays in its pane - it can be closed, moved, or opened
 * again by the build that made it - but shows only this note, never a shell.
 * Positioned over the pane's measured rect, like the editor layer.
 */
export const UnavailableTabLayer = memo(function UnavailableTabLayer({
  layout,
  rects,
  onActivatePane,
}: {
  layout: WorkspaceLayout;
  rects: Map<NodeId, PaneRect>;
  /** Changes whenever rects change; presence in props re-renders this layer. */
  version: number;
  onActivatePane: (paneId: NodeId) => void;
}) {
  const unavailable = allTabs(layout).filter((tab) => !rendersTabKind(tab.kind));
  if (unavailable.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0">
      {unavailable.map((tab) => {
        const paneId = paneOf(layout, tab.id);
        const pane = paneId ? layout.nodes[paneId] : undefined;
        const isActiveInPane = !!pane && pane.type === 'pane' && pane.activeTabId === tab.id;
        const rect = paneId ? rects.get(paneId) : undefined;
        if (!rect || !isActiveInPane) return null;
        return (
          <div
            key={tab.id}
            data-testid="unavailable-tab"
            className="pointer-events-auto absolute flex items-center justify-center bg-background"
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 1 }}
            onPointerDown={() => paneId && onActivatePane(paneId)}
          >
            <EmptyState
              icon={PackageX}
              title="Not available in this build"
              description="This tab was opened in another build of double0. You can close it here."
            />
          </div>
        );
      })}
    </div>
  );
});
