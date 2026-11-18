export type ExportFinding = { path: string; rule: string; line: number; detail: string };
export function normaliseToken(token: string): string;
export function tokenHash(token: string): string;
export function parseDenylist(text: string): {
  literals: string[];
  patterns: RegExp[];
  hashes: Set<string>;
};
export function checkText(
  path: string,
  text: string,
  denylist: ReturnType<typeof parseDenylist> | null,
  identityText?: string,
): Omit<ExportFinding, 'path'>[];
export function checkPath(path: string): string | null;
export function channelsIn(text: string): string[];
export function proChannels(proDir: string): string[];
export function checkExport(
  root: string,
  denylistText?: string | null,
  channels?: string[],
): ExportFinding[];
export function checkStrippedDeps(root: string, names: string[]): ExportFinding[];
export function checkMigrations(root: string): ExportFinding[];
export function checkFeatureWords(root: string, wordsText: string): ExportFinding[];
export function featureWordReport(findings: ExportFinding[]): string;
