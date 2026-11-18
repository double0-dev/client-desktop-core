// Types for scripts/check-app-asar.mjs so the official build
// imports its helpers under `pnpm typecheck`.
export function packagesInListing(entries: string[]): Set<string>;
export function runtimeClosure(
  rootDir: string,
  readJson?: (path: string) => { dependencies?: Record<string, string> },
): { packages: Map<string, string[]>; unresolved: string[]; dirs: Map<string, string> };
export function missingPackages(
  closure: Map<string, string[]> | Set<string>,
  inArchive: Set<string>,
): string[];
export function unpackedRemoteDir(archive: string): string;
export function isMacArchive(archive: string): boolean;
export function resetsCrashPorts(bytes: Buffer): boolean;
export function appPtyBinaries(unpackedDir: string): string[];
export function repoOnlyEntries(entries: string[]): string[];
export const LEFT_OUT: string[];
export function shippedLeftOut(inArchive: Set<string>, leftOut?: string[]): string[];
export const NOTICES_ENTRY: string;
export function noticesProblems(
  raw: string,
  inArchive: Set<string>,
  aliases?: Map<string, string[]>,
): string[];
export function platformLicenseDirs(archive: string): string[];
export function main(argv?: string[], rootDir?: string): number;
