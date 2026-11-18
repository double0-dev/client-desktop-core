import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { SETTINGS_APPLIED_EVENT } from '@renderer/lib/settings/settings-events';

// Fired (window-level, detail = the storage key) after an instance writes its
// key. Several instances of one key can be mounted at once - every open session
// keeps a hidden WorkspaceView alive, each with its own chrome - and
// localStorage gives no same-document notification, so without this each
// instance would keep the value it read at its own mount (e.g. the sidebar's
// Archived group appearing to remember open/closed per session).
const PERSISTED_STATE_EVENT = 'double0-persisted-state-written';

/**
 * `useState` persisted to localStorage - replaces the copy-pasted "load function
 * + write effect" pairs the workspace chrome accumulated (dock panels/width,
 * explorer open/width).
 *
 * `decode` maps the raw stored string (null when absent) to a value, and owns
 * validation/clamping - a corrupt or missing entry just yields the default.
 * `encode` serializes for storage. Storage failures (e.g. private mode) are
 * swallowed on both sides: the value works for the session, it just won't
 * persist. Both functions are only read on init/write, so inline literals are
 * fine - they don't need stable identities.
 *
 * A key is ONE setting, not one per hook instance: when any instance writes,
 * every other mounted instance of the same key re-decodes, so they stay in
 * sync within the document.
 */
export function usePersistedState<T>(
  key: string,
  decode: (raw: string | null) => T,
  encode: (value: T) => string,
): [T, Dispatch<SetStateAction<T>>] {
  // The raw string this instance last read or wrote - lets the write effect
  // skip redundant writes and lets listeners ignore echoes of their own value
  // (without it, two instances decoding each other's writes could ping-pong).
  const rawRef = useRef<string | null>(null);
  const [value, setValue] = useState<T>(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      // Unreadable storage - decode the "absent" case (the caller's default).
    }
    rawRef.current = raw;
    return decode(raw);
  });

  useEffect(() => {
    const raw = encode(value);
    if (raw === rawRef.current) return;
    rawRef.current = raw;
    try {
      localStorage.setItem(key, raw);
    } catch {
      // Ignore storage failures - the value just won't persist.
    }
    window.dispatchEvent(new CustomEvent(PERSISTED_STATE_EVENT, { detail: key }));
    // `encode` is deliberately not a dependency: callers pass inline literals,
    // and re-running on their identity churn would write on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value]);

  // External writes update localStorage behind this instance's back and then
  // announce it - another instance of the same key (event above), the JSON
  // settings editor / import (SETTINGS_APPLIED_EVENT, no key filter: any key
  // may have changed), or ANOTHER WINDOW (the browser's `storage` event, which
  // fires in every other document sharing the origin - a project window and
  // the main window share every key that is not namespaced per window, see
  // lib/workspace/project-scope.ts). Re-decode so they apply live; a map or
  // array value is replaced whole, and the next functional update in this
  // window builds on the other window's write instead of its own stale copy.
  // `decode` is read through a ref for the same inline-literal reason.
  const decodeRef = useRef(decode);
  decodeRef.current = decode;
  useEffect(() => {
    const applyStored = (): void => {
      let raw: string | null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        // Unreadable storage - keep the current value.
        return;
      }
      if (raw === rawRef.current) return;
      rawRef.current = raw;
      setValue(decodeRef.current(raw));
    };
    const onWritten = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === key) applyStored();
    };
    const onStorage = (e: StorageEvent): void => {
      // `key === null` is a clear() - every key may have changed.
      if (e.key === key || e.key === null) applyStored();
    };
    window.addEventListener(PERSISTED_STATE_EVENT, onWritten);
    window.addEventListener(SETTINGS_APPLIED_EVENT, applyStored);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PERSISTED_STATE_EVENT, onWritten);
      window.removeEventListener(SETTINGS_APPLIED_EVENT, applyStored);
      window.removeEventListener('storage', onStorage);
    };
  }, [key]);

  return [value, setValue];
}

/**
 * Several on / off flags, each persisted under its own localStorage key ('1'
 * / '0') - `usePersistedState` for a set whose members are only known at run
 * time (an extension's tool windows). The same keys, the same write
 * announcement and the same re-read on another instance's, another window's or
 * the settings editor's write as `usePersistedState`, so a flag read through
 * either stays in step. `keys` must keep its members for the hook's life.
 */
export function usePersistedFlags(
  keys: Readonly<Record<string, string>>,
): [Readonly<Record<string, boolean>>, (id: string, next: SetStateAction<boolean>) => void] {
  const read = (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const [flags, setFlags] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const [id, key] of Object.entries(keys)) out[id] = read(key) === '1';
    return out;
  });

  const set = useRef((id: string, next: SetStateAction<boolean>): void => {
    setFlags((prev) => {
      const key = keysRef.current[id];
      if (!key) return prev;
      const value = typeof next === 'function' ? next(prev[id] === true) : next;
      if (value === (prev[id] === true)) return prev;
      try {
        localStorage.setItem(key, value ? '1' : '0');
      } catch {
        // Ignore storage failures - the value just won't persist.
      }
      // Announced after this update: another instance re-reads the key.
      queueMicrotask(() =>
        window.dispatchEvent(new CustomEvent(PERSISTED_STATE_EVENT, { detail: key })),
      );
      return { ...prev, [id]: value };
    });
  }).current;

  useEffect(() => {
    const reread = (only?: string): void => {
      setFlags((prev) => {
        let next = prev;
        for (const [id, key] of Object.entries(keysRef.current)) {
          if (only !== undefined && key !== only) continue;
          const value = read(key) === '1';
          if (value !== (prev[id] === true)) next = { ...next, [id]: value };
        }
        return next;
      });
    };
    const owns = (key: string | null): boolean =>
      key === null || Object.values(keysRef.current).includes(key);
    const onWritten = (e: Event): void => {
      const key = (e as CustomEvent<string>).detail;
      if (owns(key)) reread(key);
    };
    const onStorage = (e: StorageEvent): void => {
      if (owns(e.key)) reread(e.key ?? undefined);
    };
    const onApplied = (): void => reread();
    window.addEventListener(PERSISTED_STATE_EVENT, onWritten);
    window.addEventListener(SETTINGS_APPLIED_EVENT, onApplied);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PERSISTED_STATE_EVENT, onWritten);
      window.removeEventListener(SETTINGS_APPLIED_EVENT, onApplied);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return [flags, set];
}
