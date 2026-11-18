import { useSyncExternalStore } from 'react';

import { isMonacoLoaded } from '@renderer/lib/monaco/monaco-loaded';

/**
 * Renderer store over the language-server registry bridge (`window.api.ls`):
 * per-language install status for Settings → Languages and the editor's
 * install banner, live install progress, and the "don't ask again" prompt
 * dismissals. Mirrors the module-store pattern of editor-settings.ts - one
 * lazily-loaded snapshot, storage-event fan-out for the persisted dismissals
 * so torn-off windows agree.
 */

/** Mirror of main's LanguageServerStatus (see src/main/language-servers.ts). */
export type LanguageServerInfo = {
  id: string;
  name: string;
  extensions: string[];
  status: 'builtin' | 'installed' | 'on-path' | 'installing' | 'available' | 'missing-tool';
  version?: string;
  path?: string;
  updateTo?: string;
  installHint?: string;
  approxMb?: number;
};

export type InstallProgress = { done: number; total: number };

export type LanguageServerState = {
  /** This computer's servers; null until the first `ls:list` answers. */
  languages: LanguageServerInfo[] | null;
  /**
   * Each remote host's servers (plan 29 › M9), asked when something needs
   * them (a host file's banner, Settings › Languages on that machine);
   * absent until asked, null while the first answer is out.
   */
  hosts: Record<string, LanguageServerInfo[] | null>;
  /** Per-language download progress while installing, keyed by `lsKey`. */
  progress: Record<string, InstallProgress>;
  /** Per-language install error (cleared on retry), keyed by `lsKey`. */
  errors: Record<string, string>;
  /** Persisted "don't ask again" prompt dismissals. */
  dismissed: Record<string, true>;
};

export const LS_PROMPTS_STORAGE_KEY = 'double0-language-server-prompts';

/** A language on a machine: its id for this computer, `<hostId>::<id>` for a host. */
export function lsKey(hostId: string | null | undefined, languageId: string): string {
  return hostId ? `${hostId}::${languageId}` : languageId;
}

function loadDismissed(): Record<string, true> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(LS_PROMPTS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, true> = {};
    for (const key of Object.keys(parsed)) out[key] = true;
    return out;
  } catch {
    return {};
  }
}

let state: LanguageServerState = {
  languages: null,
  hosts: {},
  progress: {},
  errors: {},
  dismissed: loadDismissed(),
};
// "Not now" - this window, this session only.
const sessionDismissed = new Set<string>();

const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of listeners) listener();
}
function patch(next: Partial<LanguageServerState>): void {
  state = { ...state, ...next };
  notify();
}

let started = false;
function startStore(): void {
  if (started || typeof window === 'undefined' || !window.api?.ls) return;
  started = true;

  void refreshLanguageServers();

  window.api.ls.onProgress((p) => {
    const hostId = p.hostId ?? null;
    const key = lsKey(hostId, p.languageId);
    if (p.phase === 'download') {
      patch({
        progress: { ...state.progress, [key]: { done: p.done, total: p.total } },
      });
      return;
    }
    const progress = { ...state.progress };
    delete progress[key];
    const errors = { ...state.errors };
    if (p.phase === 'error') errors[key] = p.error ?? 'Install failed';
    else delete errors[key];
    patch({ progress, errors });
    void refreshLanguageServers(hostId);
    // A freshly-installed server should light up already-open editors - but
    // only when the editor stack is actually loaded (never pull the Monaco
    // chunk in from here).
    if (p.phase === 'done' && isMonacoLoaded()) {
      void import('@renderer/lib/monaco/monaco').then((m) =>
        m.retryLanguageClients(p.languageId, hostId),
      );
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key !== LS_PROMPTS_STORAGE_KEY) return;
    patch({ dismissed: loadDismissed() });
  });
}

/** Re-ask one machine's list (this computer by default). */
export async function refreshLanguageServers(hostId: string | null = null): Promise<void> {
  const res = await window.api?.ls.list(hostId);
  if (!res?.languages) return;
  if (hostId) patch({ hosts: { ...state.hosts, [hostId]: res.languages } });
  else patch({ languages: res.languages });
}

/** Ask a host's list once (later changes re-ask it themselves). */
export function ensureHostLanguageServers(hostId: string): void {
  startStore();
  if (hostId in state.hosts) return;
  patch({ hosts: { ...state.hosts, [hostId]: null } });
  void refreshLanguageServers(hostId);
}

function withStatus(
  list: LanguageServerInfo[] | null | undefined,
  languageId: string,
  status: LanguageServerInfo['status'],
): LanguageServerInfo[] | null {
  return list?.map((l) => (l.id === languageId ? { ...l, status } : l)) ?? null;
}

/** Install a language's server on this computer, or on a host (`hostId`). */
export function installLanguageServer(languageId: string, hostId: string | null = null): void {
  const key = lsKey(hostId, languageId);
  const errors = { ...state.errors };
  delete errors[key];
  // Optimistic 'installing' so the UI flips before the first progress event.
  if (hostId) {
    patch({
      errors,
      hosts: {
        ...state.hosts,
        [hostId]: withStatus(state.hosts[hostId], languageId, 'installing'),
      },
    });
  } else {
    patch({ errors, languages: withStatus(state.languages, languageId, 'installing') });
  }
  void window.api?.ls.install(languageId, hostId).then((res) => {
    if (res?.error) {
      patch({ errors: { ...state.errors, [key]: res.error } });
      void refreshLanguageServers(hostId);
    }
  });
}

export function uninstallLanguageServer(languageId: string, hostId: string | null = null): void {
  void window.api?.ls.uninstall(languageId, hostId).then(() => refreshLanguageServers(hostId));
}

export function dismissLanguagePrompt(languageId: string, forever: boolean): void {
  if (forever) {
    const dismissed = { ...state.dismissed, [languageId]: true as const };
    try {
      window.localStorage.setItem(LS_PROMPTS_STORAGE_KEY, JSON.stringify(dismissed));
    } catch {
      // storage failure - still applies for this session
    }
    patch({ dismissed });
  } else {
    sessionDismissed.add(languageId);
    notify();
  }
}

export function resetLanguagePrompts(): void {
  sessionDismissed.clear();
  try {
    window.localStorage.removeItem(LS_PROMPTS_STORAGE_KEY);
  } catch {
    // ignore
  }
  patch({ dismissed: {} });
}

/**
 * The languages whose install prompt the user dismissed for good - for the
 * settings export. Read from storage rather than `state`, so it is correct even
 * before anything subscribed (the store only starts on first subscribe) and
 * after another window wrote the key. Sorted so exports stay diffable.
 */
export function getDismissedLanguagePrompts(): string[] {
  return Object.keys(loadDismissed()).sort();
}

/** Replace the dismissals from a settings import; `[]` means ask again everywhere. */
export function importDismissedLanguagePrompts(ids: string[]): void {
  const dismissed: Record<string, true> = {};
  for (const id of ids) dismissed[id] = true;
  try {
    if (ids.length) window.localStorage.setItem(LS_PROMPTS_STORAGE_KEY, JSON.stringify(dismissed));
    else window.localStorage.removeItem(LS_PROMPTS_STORAGE_KEY);
  } catch {
    // Storage failure - the change still applies for this session.
  }
  // "Not now" dismissals are this-session-only and unrelated to the import;
  // clearing them would re-prompt for files the user just waved off.
  patch({ dismissed });
}

function subscribe(listener: () => void): () => void {
  startStore();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLanguageServers(): LanguageServerState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/**
 * The editor banner's decision for one file: the installable-but-missing
 * server matching its extension, unless the prompt was dismissed. A host's
 * file (`hostId`) reads that HOST's list - never this computer's: an install
 * here does nothing for a file there (plan 29 › M9).
 */
export function bannerInfoFor(
  s: LanguageServerState,
  filePath: string,
  hostId: string | null = null,
): LanguageServerInfo | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filePath.slice(dot + 1).toLowerCase();
  const list = hostId ? s.hosts[hostId] : s.languages;
  const info = list?.find((l) => l.extensions.includes(ext));
  if (!info) return null;
  const relevant = info.status === 'available' || info.status === 'installing';
  if (!relevant) return null;
  if (info.status === 'available' && (s.dismissed[info.id] || sessionDismissed.has(info.id))) {
    return null;
  }
  return info;
}

/** One machine in Settings › Languages' selector (plan 29 › M9). */
export type LanguageMachine = {
  /** null = this computer. */
  id: string | null;
  label: string;
  /** Why it cannot be picked now (not connected, an older runtime); absent = it can. */
  unavailable?: string;
};

/**
 * This computer, then each host - pickable while connected with a daemon
 * that announces `lsp`, else listed with the reason.
 */
export function languageMachines(
  hosts: ReadonlyArray<{ id: string; label: string }>,
  statuses: Record<string, { state: string; caps?: string[] } | undefined>,
): LanguageMachine[] {
  return [
    { id: null, label: 'This computer' },
    ...hosts.map((h): LanguageMachine => {
      const status = statuses[h.id];
      if (status?.state !== 'connected') {
        return { id: h.id, label: h.label, unavailable: `${h.label} is not connected` };
      }
      if (!status.caps?.includes('lsp')) {
        return {
          id: h.id,
          label: h.label,
          unavailable: `Update the runtime on ${h.label} to use language servers there`,
        };
      }
      return { id: h.id, label: h.label };
    }),
  ];
}
