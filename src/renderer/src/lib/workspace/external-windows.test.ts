import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  externalSessionIds,
  inExternalProjectWindow,
  getExternalWindows,
  noteProjectReturned,
  noteSessionReleased,
  noteSessionReturned,
  resetExternalWindows,
  setExternalWindows,
  useExternalWindows,
  useExternalWindowsReady,
} from '@renderer/lib/workspace/external-windows';
import { stubApi } from '@renderer/test-support';

/**
 * The per-window "lives elsewhere" store (a private plan):
 * seeded from main, following its broadcasts, and expanded to sessions by the
 * renderer. The regression it guards: a window mounting (and stealing the
 * shells of) a session whose project is open in another window.
 */

const PIPELINE = 'project-production-pipeline';
const DASHBOARD = 'project-web-dashboard';
const sessions = [
  { id: 's1', projectId: PIPELINE },
  { id: 's2', projectId: PIPELINE },
  { id: 's3', projectId: DASHBOARD },
  { id: 's4', projectId: null },
];

// Unmount BEFORE resetting: a still-mounted hook re-renders on the reset's
// emit and would wire the store again against the previous test's bridge.
afterEach(() => {
  cleanup();
  resetExternalWindows();
});

describe('a project window holding the host projects listed under it', () => {
  const projects = [
    { id: PIPELINE, hostId: null, linkedProjectId: null },
    { id: 'box-pipeline', hostId: 'build-box', linkedProjectId: PIPELINE },
    { id: 'box-tools', hostId: 'build-box', linkedProjectId: null },
  ];
  const withBox = [
    ...sessions,
    { id: 'sBox', projectId: 'box-pipeline' },
    { id: 'sTools', projectId: 'box-tools' },
  ];

  it("counts the linked host sessions as living in their project's window", () => {
    // The main window must not mount them: their shells went to that window.
    const ext = { sessionIds: [], projectIds: [PIPELINE] };
    expect(externalSessionIds(ext, withBox, projects).sort()).toEqual(['s1', 's2', 'sBox']);
    expect(inExternalProjectWindow(ext, 'box-pipeline', projects)).toBe(true);
    expect(inExternalProjectWindow(ext, 'box-tools', projects)).toBe(false);
    expect(inExternalProjectWindow(ext, null, projects)).toBe(false);
    // A host project in a window of its own is that window's, as before.
    const own = { sessionIds: [], projectIds: ['box-tools'] };
    expect(externalSessionIds(own, withBox, projects)).toEqual(['sTools']);
  });
});

describe('externalSessionIds', () => {
  it('expands external projects to their sessions, on top of the torn-off ones', () => {
    expect(
      externalSessionIds({ sessionIds: ['s3'], projectIds: [PIPELINE] }, sessions).sort(),
    ).toEqual(['s1', 's2', 's3']);
  });

  it('lists a session once even when torn off out of an external project', () => {
    expect(externalSessionIds({ sessionIds: ['s1'], projectIds: [PIPELINE] }, sessions)).toEqual([
      's1',
      's2',
    ]);
  });

  it('is empty when nothing lives elsewhere', () => {
    expect(externalSessionIds({ sessionIds: [], projectIds: [] }, sessions)).toEqual([]);
  });
});

describe('the store', () => {
  let onExternalChanged: ((next: { sessionIds: string[]; projectIds: string[] }) => void) | null;
  beforeEach(() => {
    onExternalChanged = null;
    stubApi({
      window: {
        listExternal: vi.fn(async () => ({ sessionIds: ['s3'], projectIds: [] })),
        onExternalChanged: vi.fn((cb: typeof onExternalChanged) => {
          onExternalChanged = cb;
          return () => {};
        }),
      },
    });
  });

  it('seeds from main on first use, then follows its broadcasts', async () => {
    const ready = renderHook(() => useExternalWindowsReady());
    const value = renderHook(() => useExternalWindows());
    expect(ready.result.current).toBe(false);
    await act(async () => {});
    expect(ready.result.current).toBe(true);
    expect(value.result.current).toEqual({ sessionIds: ['s3'], projectIds: [] });
    act(() => onExternalChanged?.({ sessionIds: [], projectIds: [PIPELINE] }));
    expect(value.result.current).toEqual({ sessionIds: [], projectIds: [PIPELINE] });
  });

  it('is ready and empty at once without the bridge', async () => {
    stubApi({ window: {} });
    const ready = renderHook(() => useExternalWindowsReady());
    expect(ready.result.current).toBe(true);
    expect(getExternalWindows()).toEqual({ sessionIds: [], projectIds: [] });
  });

  it('takes the optimistic edges the host applies before the broadcast lands', () => {
    setExternalWindows({ sessionIds: [], projectIds: [PIPELINE] });
    noteSessionReleased('s3');
    noteSessionReleased('s3');
    expect(getExternalWindows()).toEqual({ sessionIds: ['s3'], projectIds: [PIPELINE] });
    noteSessionReturned('s3');
    noteProjectReturned(PIPELINE);
    expect(getExternalWindows()).toEqual({ sessionIds: [], projectIds: [] });
  });

  it('de-duplicates what main sends', () => {
    setExternalWindows({ sessionIds: ['s3', 's3'], projectIds: [PIPELINE, PIPELINE] });
    expect(getExternalWindows()).toEqual({ sessionIds: ['s3'], projectIds: [PIPELINE] });
  });
});
