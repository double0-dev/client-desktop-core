import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ClassValue } from 'clsx';

export function cn(...inputs: Array<ClassValue>) {
  return twMerge(clsx(inputs));
}

/** Whether a #rrggbb color reads as dark (perceived luma below mid-gray). */
export function isDarkColor(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const luma = 0.299 * ((n >> 16) & 0xff) + 0.587 * ((n >> 8) & 0xff) + 0.114 * (n & 0xff);
  return luma < 140;
}

/** Last path segment of a POSIX or Windows path (the file/folder name). */
export function fileName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Join a directory path with a child name using the parent's separator style. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Whether `path` is `base` itself or nested inside it (separator-agnostic). */
export function isPathInside(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

/** The containing directory of a path (its parent), separator-agnostic. */
export function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx <= 0 ? path : path.slice(0, idx);
}

/**
 * Re-root `path` from under `fromRoot` to under `toRoot` (used to update open
 * editor paths after a file/folder rename). Returns `path` unchanged if it isn't
 * `fromRoot` or inside it.
 */
export function remapPath(path: string, fromRoot: string, toRoot: string): string {
  if (path === fromRoot) return toRoot;
  if (isPathInside(path, fromRoot)) return toRoot + path.slice(fromRoot.length);
  return path;
}
