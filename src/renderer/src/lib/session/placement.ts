import type { ReactNode } from 'react';
import { rendererExtension } from '@renderer/lib/extension/registry';

/**
 * Where a new session runs, as the New session dialog sees it. The dialog
 * keeps the fields every session has (template, name, root, worktree); an
 * extension may place the session elsewhere - on another machine, under
 * another project - and adds its own fields for that. Without one, every
 * session runs on this computer, in its own project (`NO_PLACEMENT`).
 */
export type PlacementInput = {
  /** The dialog is open: a fresh open resets the placement. */
  open: boolean;
  /** Editing an existing session: nothing about its placement can change. */
  editing: boolean;
  projectId: string | null;
  projectPath: string | null;
  /** The machine the project lives on (null = this computer). */
  projectHostId: string | null;
  /** The dialog's preselected root (it resets the placement like `open`). */
  initialRoot: string | null;
  /** The root the user picked, and a way to pick one. */
  root: string | null;
  setRoot: (root: string) => void;
  /** The worktree switch as the user left it. */
  worktree: boolean;
  /** Close the dialog (an extension's own dialog may lead elsewhere). */
  close: () => void;
};

/** What a placement adds to the launch. */
export type PlacementLaunch = {
  /**
   * Start under this project instead of the dialog's: its folder, root and
   * worktree setup apply (the dialog's setup command does not).
   */
  underProject?: {
    /** The machine that project lives on. */
    hostId: string;
    projectId: string;
    projectPath: string;
    rootPath: string | null;
  };
  /** Files copied from this computer into the new worktree. Only with a worktree. */
  localSeed?: { sourceRoot: string; paths: string[] };
};

export type Placement = {
  /** The machine the session runs on (null = this computer). */
  machineId: string | null;
  /** That machine's name, for the dialog's own text. */
  machineLabel: string;
  /** No repository there: no root field, no worktree, no root on launch. */
  noRepo: boolean;
  /** Launch waits (a choice still loading, or one over its limits). */
  blocked: boolean;
  /** The project it starts under runs its own worktree setup: no setup command field. */
  ownSetup: boolean;
  /** Fields above the session's runtime. */
  top: ReactNode;
  /** Fields under the worktree switch. */
  worktreeFields: ReactNode;
  /** The extension's own dialogs, mounted beside the dialog. */
  dialogs: ReactNode;
  /** On Launch: what the launch adds, or why it cannot start. Runs only once Launch is allowed. */
  commit: () => { launch: PlacementLaunch } | { error: string };
};

/** Every session on this computer, in its own project. */
export const NO_PLACEMENT: Placement = {
  machineId: null,
  machineLabel: 'the server',
  noRepo: false,
  blocked: false,
  ownSetup: false,
  top: null,
  worktreeFields: null,
  dialogs: null,
  commit: () => ({ launch: {} }),
};

function useNoPlacement(input: PlacementInput): Placement {
  void input;
  return NO_PLACEMENT;
}

/**
 * The placement hook for this build. The extension is installed before the
 * first render and never changes, so the same hook runs on every render.
 */
export function placementHook(): (input: PlacementInput) => Placement {
  return rendererExtension().hosts?.newSession.usePlacement ?? useNoPlacement;
}
