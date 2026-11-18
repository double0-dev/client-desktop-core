import { rendererExtension } from '@renderer/lib/extension/registry';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useNavigate } from '@tanstack/react-router';
import { eq, useLiveQuery } from '@tanstack/react-db';
import {
  Command as CommandIcon,
  File as FileIcon,
  FolderGit2,
  Monitor,
  Radio,
  Smartphone,
  SquareCode,
  SquareTerminal,
} from 'lucide-react';
import { addressParts } from '@renderer/lib/url';

import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@renderer/components/ui/command';
import { agentSessionsCollection, projectsCollection } from '@renderer/lib/collections';
import { isListedProject, listedProjectId } from '@renderer/lib/projects/linked';
import {
  commands as allCommands,
  comboTokens,
  isCommandListed,
  useKeymap,
} from '@renderer/lib/settings/keyboard-shortcuts';
import { SettingsDialog } from '@renderer/routes/_app/-components/settings/settings-dialog';
import { registerSettingsOpener } from '@renderer/lib/settings/open-settings';
import {
  settingsSections,
  type SectionId,
} from '@renderer/routes/_app/-components/settings/settings-sections';
import {
  activeCommandScope,
  withActiveWorkspace,
  type CommandScope,
} from '@renderer/lib/search/search-workspace-bridge';
import { inProjectScope, scopedSessions } from '@renderer/lib/workspace/project-scope';
import {
  getExternalWindows,
  inExternalProjectWindow,
} from '@renderer/lib/workspace/external-windows';
import { projectOpenTarget } from '@renderer/lib/startup-target';
import { lastProjectSession } from '@renderer/lib/last-project-session';
import { goToTarget } from '@renderer/lib/workspace/open-target';
import { requestNewProject } from '@renderer/lib/projects/new-project-request';
import { useInstalledEditors } from '@renderer/lib/editors';
import { useDoubleShift } from '@renderer/lib/use-double-shift';
import { useAppShortcuts } from '@renderer/lib/use-app-shortcuts';
import { registerSearchOpener } from '@renderer/lib/search/open-search';
import { useFileIndex, useSearchResults } from '@renderer/lib/search/use-search';
import type { SearchCandidate, SearchItem, SearchKind } from '@renderer/lib/search/types';
import { HostIndexNotes } from '@renderer/routes/_app/-components/search-everywhere/host-index-notes';
import { useHosts } from '@renderer/lib/hosts/host-directory';
import { cn } from '@renderer/lib/utils';

type ScopeTab = { id: string; label: string; kinds: SearchKind[] | null };

/** The scope tabs across the top - `kinds: null` is "All". Tab/Shift+Tab cycles. */
const TABS: ScopeTab[] = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'files', label: 'Files', kinds: ['file'] },
  { id: 'projects', label: 'Projects', kinds: ['project'] },
  { id: 'sessions', label: 'Sessions', kinds: ['session'] },
  { id: 'actions', label: 'Actions', kinds: ['setting', 'action'] },
];
/** Shown only while the active session has commands to run - last, so the
 * other tabs keep their places when it appears once a folder scan answers. */
const COMMANDS_TAB: ScopeTab = { id: 'commands', label: 'Commands', kinds: ['command'] };

/** No bottom panel: no commands to offer. */
const noCommands = (): SearchCandidate[] => [];

/**
 * Search Everywhere - a global command palette opened with a
 * double-Shift. Searches files (across every project), projects, sessions,
 * settings pages and runnable actions; ranking + highlighting is fuzzysort, the
 * shell is cmdk inside a Radix Dialog. Mounted once app-level (so it opens from
 * anywhere, including the no-project workspace); file/action dispatch routes through the
 * active session via `search-workspace-bridge`.
 */
const NO_URLS: string[] = [];
const noServerUrls = (): string[] => NO_URLS;

export function SearchEverywhere({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId>('general');
  // The active session's commands are listed: read where they come from when
  // the palette opens (null = no session in front).
  const [commandScope, setCommandScope] = useState<CommandScope | null>(null);
  // A command run hands focus to its terminal in the dock - the dialog must
  // not take it back to where it was opened from as it closes.
  const keepFocusOnClose = useRef(false);
  const navigate = useNavigate();

  const openPalette = useCallback((scope: ScopeTab['id'] = 'all') => {
    setQuery('');
    setTab(
      Math.max(
        0,
        TABS.findIndex((t) => t.id === scope),
      ),
    );
    setCommandScope(activeCommandScope());
    setOpen(true);
  }, []);
  useDoubleShift(openPalette);
  // ⌘, / ⇧⌘P / ⌘P (Settings › Keyboard shortcuts): this host is on every route.
  useAppShortcuts((id) => {
    if (id === 'open-settings') {
      setSettingsSection('general');
      setSettingsOpen(true);
    } else openPalette(id === 'go-to-file' ? 'files' : 'all');
  });
  // Also openable imperatively (e.g. clicking the top bar's search box).
  useEffect(() => registerSearchOpener(() => openPalette()), [openPalette]);
  // This host is mounted on every route, so it is also the app's "open Settings
  // → section" opener: the workspace update banner and main's clicked-update-
  // notification push land here.
  useEffect(() => {
    const unregister = registerSettingsOpener((section) => {
      setSettingsSection(section);
      setSettingsOpen(true);
    });
    const unsubscribe = rendererExtension().updates?.onOpenSettings(() => {
      setSettingsSection('general');
      setSettingsOpen(true);
    });
    return () => {
      unregister();
      unsubscribe?.();
    };
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  }, []);

  // Sources. Files load (TTL-cached in main) when the palette opens; projects and
  // sessions come live from the local DB; settings/actions are static.
  const fileIndex = useFileIndex(open);
  const files = fileIndex.files;
  const hostList = useHosts();
  const hostLabel = useCallback(
    (id: string): string => hostList.find((h) => h.id === id)?.label ?? 'a server',
    [hostList],
  );
  const keymap = useKeymap();
  const editors = useInstalledEditors();
  // Dev servers this window's terminals announced, one per origin - the
  // browser's (Pro, a private plan › M5); none in the core build. The slot is
  // fixed for the window's life, so the same hook runs on every render.
  const browser = rendererExtension().browser;
  const useServerUrls = browser?.useServerUrls ?? noServerUrls;
  const serverUrls = useServerUrls();
  // The active session's saved and detected commands - the bottom panel's, if
  // any. The registry is fixed after boot, so the same hook runs on every render.
  const usePaletteCommands = rendererExtension().bottomPanel?.usePaletteCommands ?? noCommands;
  const commandCandidates = usePaletteCommands(commandScope, open);
  const tabs = useMemo(
    () => (commandCandidates.length > 0 ? [...TABS, COMMANDS_TAB] : TABS),
    [commandCandidates.length],
  );
  // Device actions only make sense with a browser tab in front - read when the
  // palette opens.
  const browserFocused = open && !!browser && browser.focusedTab() !== null;
  const { data: projects } = useLiveQuery((q) =>
    q.from({ project: projectsCollection }).where(({ project }) => eq(project.ownerId, userId)),
  );
  const { data: sessions } = useLiveQuery((q) =>
    q
      .from({ session: agentSessionsCollection })
      .where(({ session }) => eq(session.ownerId, userId)),
  );

  // A project window (lib/workspace/project-scope.ts) searches its project
  // only: its files, itself, its sessions. The file list (up to 20k entries)
  // is built on its own, so the session-row writes agents make all the time
  // don't rebuild it.
  const fileCandidates = useMemo(
    () =>
      files
        .filter((f) => inProjectScope(f.projectId, undefined, projects ?? []))
        .map((f) => ({
          id: `file:${f.path}`,
          kind: 'file' as const,
          title: f.name,
          subtitle: f.path,
          // A host's file says which machine (its path alone may match a
          // local one) - opened with that host's authority by its path.
          hint: f.hostId ? `${f.projectName} · ${hostLabel(f.hostId)}` : f.projectName,
          icon: FileIcon,
          path: f.path,
        })),
    [files, hostLabel, projects],
  );

  const candidatesByKind = useMemo(() => {
    return {
      file: fileCandidates,
      project: (projects ?? [])
        // A host project listed under a project of this machine is found as that one.
        .filter(
          (p) =>
            inProjectScope(p.id, undefined, projects ?? []) && isListedProject(p, projects ?? []),
        )
        .map((p) => ({
          id: `project:${p.id}`,
          kind: 'project' as const,
          title: p.name,
          subtitle: p.path ?? p.description ?? undefined,
          icon: FolderGit2,
          projectId: p.id,
        })),
      command: commandCandidates,
      session: scopedSessions(sessions ?? [], undefined, projects ?? []).map((s) => ({
        id: `session:${s.id}`,
        kind: 'session' as const,
        title: s.label,
        subtitle: s.detail || s.agent || undefined,
        hint: s.status,
        icon: SquareTerminal,
        sessionId: s.id,
      })),
      setting: settingsSections().map((sec) => ({
        id: `setting:${sec.id}`,
        kind: 'setting' as const,
        title: sec.label,
        subtitle: sec.description,
        icon: sec.icon,
        sectionId: sec.id,
      })),
      action: [
        ...allCommands()
          .filter(isCommandListed)
          .map((c) => ({
            id: `action:${c.id}`,
            kind: 'action' as const,
            title: c.label,
            hint: comboTokens(keymap[c.id]).join(' ') || undefined,
            icon: CommandIcon,
            commandId: c.id,
          })),
        // Dev servers: open the page in a browser tab of the active session.
        ...serverUrls.map((url) => ({
          id: `url:${url}`,
          kind: 'action' as const,
          title: `Open ${addressParts(url).origin}`,
          hint: 'preview',
          icon: Radio,
          url,
        })),
        ...(browserFocused
          ? [
              {
                id: 'device:responsive',
                kind: 'action' as const,
                title: 'Device: Responsive',
                hint: 'browser',
                icon: Monitor,
                deviceId: null,
              },
              ...(browser?.devices ?? []).map((d) => ({
                id: `device:${d.id}`,
                kind: 'action' as const,
                title: `Device: ${d.label}`,
                subtitle: `${d.width} × ${d.height}`,
                hint: 'browser',
                icon: d.mobile ? Smartphone : Monitor,
                deviceId: d.id,
              })),
            ]
          : []),
        // Installed IDEs: open the active session's folder in the chosen editor.
        ...editors.map((e) => ({
          id: `editor:${e.id}`,
          kind: 'action' as const,
          title: `Open in ${e.name}`,
          hint: 'IDE',
          icon: SquareCode,
          editorId: e.id,
        })),
      ],
    } satisfies Record<SearchKind, SearchCandidate[]>;
  }, [
    browser,
    fileCandidates,
    commandCandidates,
    projects,
    sessions,
    keymap,
    editors,
    serverUrls,
    browserFocused,
  ]);

  const scopeKinds = tabs[tab]?.kinds ?? null;
  const groups = useSearchResults(query, scopeKinds, candidatesByKind);

  // Open one of the user's sessions so a workspace registers (and any op queued
  // on the bridge flushes there) - used when a file/action is picked with no
  // session active, e.g. from a project's session-less view.
  const openSomeSession = useCallback(() => {
    const sid = scopedSessions(sessions ?? [], undefined, projects ?? [])[0]?.id;
    if (sid) void navigate({ to: '/sessions/$sessionId', params: { sessionId: sid } });
  }, [navigate, sessions, projects]);

  const runItem = useCallback(
    (item: SearchItem) => {
      // "Open in <IDE>": route through the active session so it opens that
      // session's folder; with no session active, open one first (then flush).
      if (item.url || item.deviceId !== undefined) {
        const url = item.url;
        const ran = url
          ? withActiveWorkspace((a) => a.openUrl(url))
          : withActiveWorkspace((a) => a.browserDevice(item.deviceId ?? null));
        if (!ran) openSomeSession();
        setOpen(false);
        setQuery('');
        return;
      }
      if (item.run) {
        const req = item.run;
        keepFocusOnClose.current = true;
        if (!withActiveWorkspace((a) => a.runShellCommand(req))) openSomeSession();
        setOpen(false);
        setQuery('');
        return;
      }
      if (item.editorId) {
        if (!withActiveWorkspace((a) => a.openInEditor(item.editorId as string))) {
          openSomeSession();
        }
        setOpen(false);
        setQuery('');
        return;
      }
      switch (item.kind) {
        case 'file':
          if (item.path && !withActiveWorkspace((a) => a.openFile(item.path as string))) {
            openSomeSession();
          }
          break;
        case 'project':
          // Opens like a click in the Projects panel: its last-viewed session,
          // else its session-less view - or raises its own window.
          if (item.projectId) {
            const ext = getExternalWindows();
            const listed = projects ?? [];
            if (inExternalProjectWindow(ext, item.projectId, listed)) {
              window.api?.project?.focusWindow(
                ext.projectIds.includes(item.projectId)
                  ? item.projectId
                  : (listedProjectId(
                      listed.find((p) => p.id === item.projectId),
                      listed,
                    ) ?? item.projectId),
              );
            } else {
              goToTarget(
                navigate,
                projectOpenTarget(item.projectId, listed, sessions ?? [], lastProjectSession),
              );
            }
          }
          break;
        case 'session':
          if (item.sessionId) {
            void navigate({ to: '/sessions/$sessionId', params: { sessionId: item.sessionId } });
          }
          break;
        case 'setting':
          setSettingsSection((item.sectionId as SectionId) ?? 'general');
          setSettingsOpen(true);
          break;
        case 'action':
          // New project needs no workspace - the no-project view has none.
          if (item.commandId === 'new-project') {
            requestNewProject();
            break;
          }
          // The app's own commands need no workspace either.
          if (item.commandId === 'open-settings') {
            setSettingsSection('general');
            setSettingsOpen(true);
            break;
          }
          if (item.commandId === 'search-everywhere' || item.commandId === 'go-to-file') {
            // Already here: Go to file narrows to the Files tab, the palette stays.
            const scope = item.commandId === 'go-to-file' ? 'files' : 'all';
            setTab(
              Math.max(
                0,
                TABS.findIndex((t) => t.id === scope),
              ),
            );
            setQuery('');
            return;
          }
          if (item.commandId && !withActiveWorkspace((a) => a.runCommand(item.commandId!))) {
            openSomeSession();
          }
          break;
      }
      setOpen(false);
      setQuery('');
    },
    [navigate, openSomeSession, projects, sessions],
  );

  const tabCount = tabs.length;
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      // Tab cycles scopes (cmdk owns Up/Down; Radix owns Escape).
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        setTab((t) => (e.shiftKey ? (t - 1 + tabCount) % tabCount : (t + 1) % tabCount));
        return;
      }
      // ←/→ also cycle scopes, but only at the query's edges so in-field cursor
      // movement and text editing keep working. (A collapsed caret at position 0
      // goes back a tab; at the end, forward.)
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const el = e.target;
        if (!(el instanceof HTMLInputElement) || el.selectionStart !== el.selectionEnd) return;
        if (e.key === 'ArrowLeft' && el.selectionStart === 0) {
          e.preventDefault();
          setTab((t) => (t - 1 + tabCount) % tabCount);
        } else if (e.key === 'ArrowRight' && el.selectionStart === el.value.length) {
          e.preventDefault();
          setTab((t) => (t + 1) % tabCount);
        }
      }
    },
    [tabCount],
  );

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            if (!keepFocusOnClose.current) return;
            keepFocusOnClose.current = false;
            e.preventDefault();
          }}
          className="top-[12vh] max-w-[640px] translate-y-0 gap-0 overflow-hidden rounded-xl p-0"
        >
          <DialogTitle className="sr-only">Search everywhere</DialogTitle>
          <Command shouldFilter={false} loop onKeyDown={onKeyDown}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search files, projects, sessions, commands, settings…"
            />
            <div className="flex items-center gap-1 border-b border-border px-2.5 py-1.5">
              {tabs.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(i)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[length:calc(12px*var(--ui-font-scale,1))] transition-colors',
                    i === tab
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-foreground-muted hover:text-foreground',
                  )}
                >
                  {t.label}
                </button>
              ))}
              <span className="ml-auto pr-1 text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-subtle">
                Tab or ← → to switch
              </span>
            </div>
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              {groups.map((g) => (
                <CommandGroup key={g.kind} heading={g.heading}>
                  {g.items.map((item) => (
                    <CommandItem key={item.id} value={item.id} onSelect={() => runItem(item)}>
                      <ResultRow item={item} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              {(!tabs[tab]?.kinds || tabs[tab]?.kinds?.includes('file')) && (
                <HostIndexNotes index={fileIndex} label={hostLabel} />
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      {/* The palette's own settings host, so "open settings → section" works
          wherever the top bar's gear isn't mounted. */}
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialSection={settingsSection}
      />
    </>
  );
}

function ResultRow({ item }: { item: SearchItem }) {
  const Icon = item.icon;
  return (
    <>
      <Icon className="size-[15px] shrink-0 text-foreground-muted" />
      <span className="max-w-[60%] shrink-0 truncate">{item.titleNodes}</span>
      {item.subtitle && (
        <span className="min-w-0 flex-1 truncate text-[length:calc(12px*var(--ui-font-scale,1))] text-foreground-subtle">
          {item.subtitle}
        </span>
      )}
      {item.hint && (
        <span className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-muted">
          {item.hint}
        </span>
      )}
    </>
  );
}
