/**
 * Key grammar shared by core and an extension's view: a terminal tab's own
 * agent CLI shown in the view is keyed `cli:<ptyId>`; a runtime session's
 * agent by its session id.
 */

/** The view key of a terminal tab's agent CLI. */
export function cliViewKey(ptyId: string): string {
  return `cli:${ptyId}`;
}
