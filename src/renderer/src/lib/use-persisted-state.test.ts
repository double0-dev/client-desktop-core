import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { emitSettingsApplied } from '@renderer/lib/settings/settings-events';
import { usePersistedFlags, usePersistedState } from '@renderer/lib/use-persisted-state';

// Mirrors the sidebar's Archived-group flag (default open, '0' = closed).
const decode = (raw: string | null): boolean => raw !== '0';
const encode = (open: boolean): string => (open ? '1' : '0');

function mount(key: string) {
  return renderHook(() => usePersistedState<boolean>(key, decode, encode));
}

describe('usePersistedState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('decodes the stored value at mount and the default when absent', () => {
    expect(mount('k').result.current[0]).toBe(true);
    localStorage.setItem('k2', '0');
    expect(mount('k2').result.current[0]).toBe(false);
  });

  it('persists updates (functional form included) to localStorage', () => {
    const { result } = mount('k');
    act(() => result.current[1]((open) => !open));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem('k')).toBe('0');
  });

  // The bug this hook must not regress into: every open session keeps a hidden
  // workspace chrome mounted, each holding this hook for the SAME key. Without
  // cross-instance sync, toggling the Archived group in one session left the
  // others on whatever they read at their own mount - open/closed looked
  // per-session even though the key is one global setting.
  it('updates every mounted instance of the same key, not just the writer', () => {
    const a = mount('k');
    const b = mount('k');
    act(() => a.result.current[1](false));
    expect(a.result.current[0]).toBe(false);
    expect(b.result.current[0]).toBe(false);
    act(() => b.result.current[1](true));
    expect(a.result.current[0]).toBe(true);
    expect(b.result.current[0]).toBe(true);
  });

  it('does not leak writes across different keys', () => {
    const a = mount('k');
    const other = mount('unrelated');
    act(() => a.result.current[1](false));
    expect(other.result.current[0]).toBe(true);
    expect(localStorage.getItem('unrelated')).not.toBe('0');
  });

  // A project window and the main window share the key: a write in one
  // document reaches the other through the browser's `storage` event (which
  // never fires in the writing document). Without this the two windows
  // diverged and the last to write won on disk.
  it('re-decodes when another window writes the key', () => {
    const a = mount('k');
    act(() => {
      localStorage.setItem('k', '0');
      window.dispatchEvent(new StorageEvent('storage', { key: 'k', newValue: '0' }));
    });
    expect(a.result.current[0]).toBe(false);
    // A clear() in the other window arrives with a null key.
    act(() => {
      localStorage.removeItem('k');
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(a.result.current[0]).toBe(true);
  });

  it('ignores another window writing a different key', () => {
    const a = mount('k');
    act(() => a.result.current[1](false));
    act(() => {
      localStorage.setItem('other', '1');
      window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: '1' }));
    });
    expect(a.result.current[0]).toBe(false);
  });

  // The map-valued keys (explorer-open per session, repo choice per folder):
  // after the other window's write lands, a functional update here builds on
  // it rather than on this window's stale copy - no lost entries.
  it('merges a functional update onto what another window wrote', () => {
    const list = renderHook(() =>
      usePersistedState<string[]>(
        'list',
        (raw) => (raw ? (JSON.parse(raw) as string[]) : []),
        (v) => JSON.stringify(v),
      ),
    );
    act(() => list.result.current[1]((prev) => [...prev, 'a']));
    act(() => {
      localStorage.setItem('list', JSON.stringify(['a', 'b']));
      window.dispatchEvent(new StorageEvent('storage', { key: 'list' }));
    });
    act(() => list.result.current[1]((prev) => [...prev, 'c']));
    expect(list.result.current[0]).toEqual(['a', 'b', 'c']);
    expect(JSON.parse(localStorage.getItem('list')!)).toEqual(['a', 'b', 'c']);
  });

  // The settings editor / import writes localStorage directly, then announces
  // it - every instance must re-decode without a restart.
  it('re-decodes when settings are applied externally', () => {
    const a = mount('k');
    const b = mount('k');
    act(() => {
      localStorage.setItem('k', '0');
      emitSettingsApplied();
    });
    expect(a.result.current[0]).toBe(false);
    expect(b.result.current[0]).toBe(false);
  });
});

// An extension's tool windows: one flag per tool, each under its own key,
// read and written like `usePersistedState` so either hook sees the other's.
describe('usePersistedFlags', () => {
  const KEYS = { gadget: 'double0-test-flag-gadget', widget: 'double0-test-flag-widget' };

  it('reads each flag from its own key, on only for the exact stored value', () => {
    window.localStorage.setItem(KEYS.gadget, '1');
    window.localStorage.setItem(KEYS.widget, 'true');
    const { result } = renderHook(() => usePersistedFlags(KEYS));
    expect(result.current[0]).toEqual({ gadget: true, widget: false });
  });

  it("writes one flag's key, functional updates included, and leaves the others", () => {
    const { result } = renderHook(() => usePersistedFlags(KEYS));
    act(() => result.current[1]('gadget', true));
    expect(window.localStorage.getItem(KEYS.gadget)).toBe('1');
    expect(window.localStorage.getItem(KEYS.widget)).toBeNull();
    act(() => result.current[1]('gadget', (v) => !v));
    expect(result.current[0].gadget).toBe(false);
    expect(window.localStorage.getItem(KEYS.gadget)).toBe('0');
    // An id it has no key for is ignored.
    act(() => result.current[1]('nope', true));
    expect(result.current[0]).toEqual({ gadget: false, widget: false });
  });

  it('follows another instance, a usePersistedState of the same key and another window', async () => {
    const a = renderHook(() => usePersistedFlags(KEYS));
    const b = renderHook(() => usePersistedFlags(KEYS));
    const single = renderHook(() =>
      usePersistedState(
        KEYS.widget,
        (raw) => raw === '1',
        (v) => (v ? '1' : '0'),
      ),
    );
    await act(async () => {
      a.result.current[1]('gadget', true);
      await Promise.resolve();
    });
    expect(b.result.current[0].gadget).toBe(true);
    // The single-key hook's write reaches the flags.
    act(() => single.result.current[1](true));
    expect(a.result.current[0].widget).toBe(true);
    // Another window wrote (the browser's storage event).
    window.localStorage.setItem(KEYS.gadget, '0');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEYS.gadget }));
    });
    expect(a.result.current[0].gadget).toBe(false);
    // The settings editor applied a document: every key is read again.
    window.localStorage.setItem(KEYS.widget, '0');
    act(() => emitSettingsApplied());
    expect(b.result.current[0].widget).toBe(false);
  });
});
