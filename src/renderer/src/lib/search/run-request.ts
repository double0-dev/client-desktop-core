/**
 * A "run this command" request - what the Search Everywhere palette hands the
 * active session's bottom panel: a saved command (its row id) or a detected
 * one (`auto:<key>`). Core vocabulary (the palette's items carry it); the
 * panel that runs it is the extension's (`RendererExtension.bottomPanel`).
 */
export type CommandRunRequest = {
  id: string;
  name: string;
  command: string;
  openPreview: boolean;
};
