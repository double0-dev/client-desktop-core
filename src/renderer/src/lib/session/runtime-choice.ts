import type { ReactNode } from 'react';
import { rendererExtension } from '@renderer/lib/extension/registry';

/**
 * How a new session runs its agent, as the New session dialog sees it. The
 * dialog's own fields start an agent CLI in a terminal (a template, a start
 * command). An extension may offer another runtime - the agent shown in a view
 * of its own - and then supplies the fields that pick it. Without one, every
 * session runs in a terminal (`NO_RUNTIME_CHOICE`).
 */
export type RuntimeChoiceInput = {
  /** The dialog is open: a fresh open resets the choice. */
  open: boolean;
  /** The session being edited: its runtime is fixed, its agent prefilled. */
  edit: { runtime: string | null; agent: string; startCommand: string } | null;
  /** The machine the session runs on (null = this computer) and its name. */
  machineId: string | null;
  machineLabel: string;
  /** The dialog's "also run in new terminals" switch as the user left it. */
  runOnNewTerminal: boolean;
  /** The user switched runtimes: the dialog resets its own command fields. */
  onSwitch: (toExtension: boolean) => void;
};

export type RuntimeChoice = {
  /** The extension's runtime is picked: the dialog hides its template and command fields. */
  active: boolean;
  /** The runtime picker, above the template. */
  row: ReactNode;
  /** In place of the template while `active`. */
  agentFields: ReactNode;
  /** In place of the start command while `active`. */
  commandFields: ReactNode;
  /** The footer's line while `active` and creating. */
  footer: ReactNode;
  /** While `active`: the session's agent label and command. */
  agentLabel: string;
  startCommand: string;
  /** Launch waits (no agent command, or one this machine cannot run). */
  blocked: boolean;
  /** While `active`: what the launch stores. */
  launch: {
    /** The `agent_sessions.runtime` value (null = a terminal session). */
    runtime: string | null;
    /** A terminal session that opens on the extension's view over its agent. */
    openInView: boolean;
    runOnNewTerminal: boolean;
  };
};

/** Every session in a terminal. */
export const NO_RUNTIME_CHOICE: RuntimeChoice = {
  active: false,
  row: null,
  agentFields: null,
  commandFields: null,
  footer: null,
  agentLabel: '',
  startCommand: '',
  blocked: false,
  launch: { runtime: null, openInView: false, runOnNewTerminal: false },
};

function useNoRuntimeChoice(input: RuntimeChoiceInput): RuntimeChoice {
  void input;
  return NO_RUNTIME_CHOICE;
}

/**
 * The runtime-choice hook for this build. The extension is installed before
 * the first render and never changes, so the same hook runs on every render.
 */
export function runtimeChoiceHook(): (input: RuntimeChoiceInput) => RuntimeChoice {
  return rendererExtension().sessionView?.useRuntimeChoice ?? useNoRuntimeChoice;
}
