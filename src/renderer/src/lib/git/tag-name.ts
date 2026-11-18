/**
 * Tag-name validation (a "New tag" dialog, and the ref rules branch names
 * share), kept free of React so the rules are testable on their own.
 *
 * Unlike the branch names the app coins (see branch-name.ts), a tag name is
 * NOT lowercased: tags never become `.worktree/` folder names, so there is no
 * case-insensitive filesystem to collide on, and `v1.4.0-RC1` is a real
 * convention. The name is checked the way git's `check-ref-format` would
 * refuse it, so the dialog can say why before a git process is spawned - git
 * itself is still the last word (the handler surfaces its message verbatim).
 */

/** The seven punctuation marks git forbids in a ref name. */
const FORBIDDEN_PUNCTUATION = /[~^:?*[\\]/;

/** Control characters, space and DEL - git refuses them all. */
function hasControlOrSpace(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Why `trimmed` cannot be a ref name under git's `check-ref-format` rules, or
 * null when it can. `noun` starts the message ("Tag", "Branch"). Shared by
 * the tag and branch validators - the rules are git's, not the dialog's.
 */
export function refNameProblem(trimmed: string, noun: string): string | null {
  if (hasControlOrSpace(trimmed) || FORBIDDEN_PUNCTUATION.test(trimmed)) {
    return `${noun} names can’t contain spaces or ~ ^ : ? * [ \\`;
  }
  if (trimmed.includes('..') || trimmed.includes('@{') || trimmed === '@') {
    return `${noun} names can’t contain “..” or “@{”`;
  }
  // `-` is legal for git but reads as an option on the command line - the
  // handler refuses it too, so say so here instead of failing later.
  if (trimmed.startsWith('-')) return `${noun} names can’t start with “-”`;
  if (trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.includes('//')) {
    return `${noun} names can’t start or end with “/”`;
  }
  if (trimmed.endsWith('.')) return `${noun} names can’t end with “.”`;
  for (const part of trimmed.split('/')) {
    if (part.startsWith('.')) return `${noun} names can’t start with “.”`;
    if (part.endsWith('.lock')) return `${noun} names can’t end in “.lock”`;
  }
  return null;
}

/**
 * Why `name` cannot be a tag, or null when it can. `existing` is the repo's
 * current tag list - an existing name is refused up front rather than letting
 * `git tag` fail with "already exists".
 */
export function validateTagName(name: string, existing: Iterable<string> = []): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a tag name';
  const problem = refNameProblem(trimmed, 'Tag');
  if (problem) return problem;
  for (const taken of existing) {
    if (taken === trimmed) return `A tag named ${trimmed} already exists.`;
  }
  return null;
}
