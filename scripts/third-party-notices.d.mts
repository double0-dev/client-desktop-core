// Types for scripts/third-party-notices.mjs so electron.vite.config.ts and
// src/main/third-party-notices-script.test.ts import it under `pnpm typecheck`.
import type { Plugin } from 'vite';

export const NOTICES_FILE: string;

export type NoticesDocument = {
  version: 1;
  packages: {
    name: string;
    version: string;
    license: string | null;
    files: { name: string; text: number }[];
  }[];
  texts: string[];
};

export type NoticesFs = {
  readFile(path: string): string;
  list(dir: string): string[];
  isFile(path: string): boolean;
};

export const ALSO_SHIPPED: string[];
export const STANDARD_TEXT_FILE: string;
export function copyrightOf(pkg: Record<string, unknown> & { name: string }): string[];
export function standardText(
  pkg: Record<string, unknown> & { name: string },
  license: string | null,
  apacheText: string | null,
): string | null;
export function canonicalApache(texts: string[]): string | null;
export function packageDirOf(moduleId: string | null | undefined): string | null;
export function noticeFilesIn(dir: string, list?: (dir: string) => string[]): string[];
export function licenseOf(pkg: Record<string, unknown>): string | null;
export function buildNotices(dirs: Iterable<string>, fs?: NoticesFs): NoticesDocument;
export function thirdPartyNotices(rootDir?: string): {
  recordBundled(target: string): Plugin;
  writeNotices(): Plugin;
};
