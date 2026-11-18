export function exportedFiles(root?: string): string[];
export function parseStripList(text: string): string[];
export function stripDependencies(text: string, names: string[]): string;
export const CORE_LICENSE: string;
export function withLicense(text: string, license?: string): string;
export function exportTree(
  out: string,
  root?: string,
  options?: { stripDeps?: string[] },
): string[];
export function refreshLockfile(out: string): void;
export function tablesDefinedIn(schemaText: string): string[];
export function tablesIn(statement: string): string[];
export const EMPTY_MIGRATION: string;
export function tablesCreatedIn(sql: string): string[];
export function filterMigrationSql(sql: string, drop: Set<string>): string;
export function filterSnapshot(json: string, keep: Set<string>): string;
export function publicMigrationName(folder: string, emptied: boolean): string;
export function indexesOn(sql: string, tables: Set<string>): string[];
export const PRO_PATH_FILES: Set<string>;
export const PRO_PATH: RegExp;
export function neutralizeProPaths(text: string): string;
export function isCommentLine(line: string): boolean;
export function neutralizeProPathComments(text: string): string;
