import { useEffect, useState } from 'react';

import { allTabs, paneOf, type NodeId, type WorkspaceLayout } from '@renderer/lib/workspace/layout';
import { FileEditor } from '@renderer/routes/_app/-components/workspace/file-editor';
import { ImageViewer } from '@renderer/routes/_app/-components/workspace/image-viewer';
import { isImagePath } from '@renderer/lib/image-files';
import { resolveEditorPalette, useEditorSettings } from '@renderer/lib/settings/editor-settings';
import { useAppTheme } from '@renderer/lib/settings/theme';
import type { PaneRect } from '@renderer/lib/workspace/use-pane-rects';
import { defaultPreviewMode, previewKind } from '@renderer/lib/editor/file-preview';
import { runWhenInputIdle } from '@renderer/lib/run-when-input-idle';
import {
  MarkdownPreview,
  PreviewHeader,
  WebFilePreview,
} from '@renderer/routes/_app/-components/workspace/file-preview';

/** How long after a workspace mounts the Monaco warmup may start. */
const MONACO_WARMUP_DELAY_MS = 3000;
/** The latest it then waits for the main thread to go idle. */
const MONACO_WARMUP_IDLE_TIMEOUT_MS = 10000;
/**
 * How long the user must have left the keyboard, pointer and wheel alone
 * before it starts: once begun it is one long task (~400 ms measured), and an
 * idle callback only knows the main thread is free right now - a dock opened
 * or a tab switched in that window froze until the warmup finished.
 */
const MONACO_WARMUP_INPUT_IDLE_MS = 2000;

/**
 * The editor layer: a flat pool of every editor tab's `FileEditor`, each
 * absolutely positioned over its current pane's measured rect - the same pattern
 * as the terminal layer, so a tab's editor (its content, scroll, undo history,
 * and unsaved edits) survives splits, moves, and tab switches without remounting.
 *
 * Sits above the terminal layer but below the geometry/chrome layer; only the
 * active tab in each pane is shown (display:none otherwise) so hidden editors
 * stay mounted but out of layout.
 */
export function EditorLayer({
  layout,
  rects,
  version,
  cwd,
  onActivatePane,
}: {
  layout: WorkspaceLayout;
  rects: Map<NodeId, PaneRect>;
  /** Changes whenever rects change; presence in props re-renders this layer. */
  version: number;
  /** The session's folder - file previews may read under it. */
  cwd?: string | null;
  onActivatePane: (paneId: NodeId) => void;
}) {
  void version;
  const { activePaneId } = layout;
  // Code or Preview per previewable tab (in memory, like the editor's scroll).
  const [modes, setModes] = useState<Record<string, 'code' | 'preview'>>({});
  const [reloads, setReloads] = useState<Record<string, number>>({});

  // Warm the lazy multi-megabyte Monaco stack while the workspace is idle so
  // the FIRST editor tab opens instantly instead of paying chunk-load +
  // service/tokenizer/worker init on click (warmupMonaco spins up and
  // discards a hidden editor). Idempotent - a click racing the warmup just
  // awaits the same underlying init promise. It waits out the launch first:
  // parsing the stack is hundreds of ms on the main thread, and a deadline
  // that forced it in the first seconds landed on top of the terminals
  // attaching and replaying. And then a pause in the user's input: an idle
  // callback alone started it under a dock toggle or a tab switch, which then
  // froze until it finished (runWhenInputIdle).
  useEffect(
    () =>
      runWhenInputIdle(
        () =>
          void import('@renderer/lib/monaco/monaco').then((m) => m.warmupMonaco()).catch(() => {}),
        {
          delayMs: MONACO_WARMUP_DELAY_MS,
          inputIdleMs: MONACO_WARMUP_INPUT_IDLE_MS,
          idleTimeoutMs: MONACO_WARMUP_IDLE_TIMEOUT_MS,
        },
      ),
    [],
  );
  // The wrapper paints the editor theme's background so the area around a short
  // file (and CodeMirror's own padding) matches the themed canvas.
  const editorBg = resolveEditorPalette(useEditorSettings(), useAppTheme()).background;

  return (
    <div className="pointer-events-none absolute inset-0">
      {allTabs(layout)
        .filter((tab) => tab.kind === 'editor' && tab.filePath)
        .map((tab) => {
          const paneId = paneOf(layout, tab.id);
          const pane = paneId ? layout.nodes[paneId] : undefined;
          const isActiveInPane = !!pane && pane.type === 'pane' && pane.activeTabId === tab.id;
          const rect = paneId ? rects.get(paneId) : undefined;
          // left/top, not `transform: translate()` - a fractional translate
          // blurs canvas content (Monaco's minimap; see terminal-layer).
          const style: React.CSSProperties = rect
            ? {
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
                display: isActiveInPane ? 'block' : 'none',
                zIndex: isActiveInPane ? 1 : 0,
                backgroundColor: editorBg,
              }
            : { display: 'none' };
          return (
            <div
              key={tab.id}
              className="pointer-events-auto absolute overflow-hidden"
              style={style}
              // Clicking an editor focuses its pane (matters once panes are split).
              onPointerDown={() => paneId && onActivatePane(paneId)}
            >
              {isImagePath(tab.filePath!) && !tab.hostId ? (
                <ImageViewer filePath={tab.filePath!} className="size-full" />
              ) : (
                (() => {
                  const kind = previewKind(tab.filePath!);
                  const editor = (
                    <FileEditor
                      filePath={tab.filePath!}
                      hostId={tab.hostId ?? null}
                      tabId={tab.id}
                      active={isActiveInPane && paneId === activePaneId}
                      className="size-full"
                    />
                  );
                  if (!kind || tab.hostId) return editor;
                  const mode = modes[tab.id] ?? defaultPreviewMode(kind);
                  const reload = reloads[tab.id] ?? 0;
                  return (
                    <div className="flex size-full flex-col">
                      <PreviewHeader
                        filePath={tab.filePath!}
                        cwd={cwd ?? null}
                        kind={kind}
                        mode={mode}
                        onMode={(m) => {
                          setModes((prev) => ({ ...prev, [tab.id]: m }));
                          // Showing the preview again re-reads what was saved.
                          if (m === 'preview')
                            setReloads((prev) => ({ ...prev, [tab.id]: reload + 1 }));
                        }}
                        onReload={() => setReloads((prev) => ({ ...prev, [tab.id]: reload + 1 }))}
                      />
                      <div className="relative min-h-0 flex-1">
                        {/* The editor stays mounted under a preview: unsaved
                            edits and undo history survive the switch. */}
                        {kind !== 'media' && (
                          <div
                            className="absolute inset-0"
                            style={{ display: mode === 'code' ? 'block' : 'none' }}
                          >
                            {editor}
                          </div>
                        )}
                        {mode === 'preview' && (
                          <div className="absolute inset-0">
                            {kind === 'markdown' ? (
                              <MarkdownPreview filePath={tab.filePath!} reloadToken={reload} />
                            ) : (
                              <WebFilePreview
                                filePath={tab.filePath!}
                                cwd={cwd ?? null}
                                reloadToken={reload}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()
              )}
            </div>
          );
        })}
    </div>
  );
}
