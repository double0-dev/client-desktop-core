import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getHost,
  registerHostSource,
  resetHostSourceForTest,
  useHosts,
  type HostEntry,
} from './host-directory';

afterEach(() => resetHostSourceForTest());

describe('the host directory', () => {
  it('knows no host in the core build - nothing registers a source', () => {
    const { result } = renderHook(() => useHosts());
    expect(result.current).toEqual([]);
    expect(getHost('build-box')).toBeNull();
  });

  it('reads and follows the registered store', () => {
    let hosts: HostEntry[] = [{ id: 'build-box', label: 'Build box' }];
    const listeners = new Set<() => void>();
    registerHostSource({
      list: () => hosts,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    });
    const { result } = renderHook(() => useHosts());
    expect(result.current).toEqual([{ id: 'build-box', label: 'Build box' }]);
    expect(getHost('build-box')?.label).toBe('Build box');
    act(() => {
      hosts = [{ id: 'build-box', label: 'Renamed' }];
      for (const l of listeners) l();
    });
    expect(result.current[0].label).toBe('Renamed');
  });
});
