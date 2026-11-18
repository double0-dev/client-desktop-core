export const PRO_ENTRIES: readonly string[];
export function proEnabled(env?: NodeJS.ProcessEnv, root?: string): boolean;
export function proAliases(root: string, pro: boolean): Record<string, string>;
export function editionNotice(env?: NodeJS.ProcessEnv, root?: string): string | null;
