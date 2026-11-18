import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CommandId } from '@renderer/lib/settings/keyboard-shortcuts';
import type { CommandRunRequest } from '@renderer/lib/search/run-request';

/** The searchable domains, in their default display order (see use-search). */
export type SearchKind = 'file' | 'project' | 'session' | 'command' | 'setting' | 'action';

/** One file in the cross-project index (shape mirrors src/main/search.ts). */
export type SearchFile = {
  path: string;
  name: string;
  projectId: string;
  projectName: string;
  /** A remote host's file (plan 29 › M5) - null / absent = this computer. */
  hostId?: string | null;
  /** From a host that is unreachable now - its last list. */
  stale?: true;
};

/** The file index and where each host's part of it stands (plan 29 spec › 5.3). */
export type FileIndex = {
  files: SearchFile[];
  /** Hosts walking their projects now ("Indexing build-box…"). */
  pending: string[];
  /** Hosts not connected - their last list is in `files`. */
  unreachable: string[];
};

/**
 * A pre-ranking result row. `title` is the fuzzy-match target; the dispatch
 * payload is whichever id field matches `kind` (the palette switches on `kind`
 * to act). `sectionId` is a loose string to keep this module free of any route
 * import - the palette narrows it back to a settings SectionId.
 */
export interface SearchCandidate {
  /** Unique across all candidates - used as the cmdk item value. */
  id: string;
  kind: SearchKind;
  title: string;
  /** Secondary line (path / detail / description). */
  subtitle?: string;
  /** Right-aligned hint (project name for files, shortcut for actions, …). */
  hint?: string;
  icon: LucideIcon;
  // Dispatch payload - the field for `kind` is set.
  path?: string;
  projectId?: string;
  sessionId?: string;
  sectionId?: string;
  commandId?: CommandId;
  /** Installed-IDE id - opens the active session's folder in that editor. */
  editorId?: string;
  /** A page to open in a browser tab of the active session (a dev server). */
  url?: string;
  /** A device preset for the focused browser tab (null = Responsive). */
  deviceId?: string | null;
  /** A saved or detected command of the active session, run in its dock. */
  run?: CommandRunRequest;
}

/** A candidate after ranking: matched-character highlighting + fuzzy score. */
export interface SearchItem extends SearchCandidate {
  /** Title with matched characters emphasized (plain title when unranked). */
  titleNodes: ReactNode;
  /** fuzzysort score (0..1, higher better); 1 for unranked default items. */
  score: number;
}

export interface SearchGroup {
  kind: SearchKind;
  heading: string;
  items: SearchItem[];
}
