export const COMPOSITION_ROOTS: Record<string, string>;
export function parseCorePaths(text: string): string[];
export function globToRegExp(glob: string): RegExp;
export function coreMatcher(globs: string[]): (path: string) => boolean;
export function moduleReferences(text: string): { kind: string; specifier: string }[];
export function checkProBoundary(
  root: string,
  corePathsText: string,
): { file: string; specifier: string; kind: string; rule: string }[];
