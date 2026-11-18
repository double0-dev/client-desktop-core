import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The preload bridge addresses main by string channel name, so nothing -
 * not TypeScript, not the linter - connects the two ends. Rename a channel in
 * main and the preload call still compiles; it just rejects at runtime with
 * "No handler registered for 'x'", usually in a code path nobody clicks until
 * a user does.
 *
 * This walks both sides of the wire and asserts they agree. It is a source
 * scan rather than a runtime check because registering the real handlers means
 * booting Electron.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Pro's half of the wire (a private plan): its bridges in
// the official build, its handlers in the official build. Read when present - the public tree
// has no pro/, and its core channels must still agree on their own.
const PRO = existsSync(join(ROOT, 'pro'));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const matches = (src: string, re: RegExp): string[] => [...src.matchAll(re)].map((m) => m[1]);

// --- the preload side ---------------------------------------------------------

const preload = [
  readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8'),
  ...(PRO ? sourceFiles(join(ROOT, 'pro/preload')).map((f) => readFileSync(f, 'utf8')) : []),
].join('\n');
const invoked = new Set(matches(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g));
const sent = new Set(matches(preload, /ipcRenderer\.send\(\s*'([^']+)'/g));
const listenedFor = new Set(matches(preload, /ipcRenderer\.(?:on|once)\(\s*'([^']+)'/g));

// --- the main side ------------------------------------------------------------

/** Channels registered with a literal name - `ipcMain.handle('git:status', …)`. */
const literallyRegistered = new Set<string>();
/** Channels main pushes to the renderer - `webContents.send('git:changed', …)`. */
const pushedToRenderer = new Set<string>();
/** Per-file `CHANNELS` arrays: each module's declared surface, used for teardown. */
const declared = new Set<string>();
const registries: { file: string; listed: string[]; literal: string[] }[] = [];

for (const file of [
  ...sourceFiles(join(ROOT, 'src/main')),
  ...(PRO ? sourceFiles(join(ROOT, 'pro/main')) : []),
]) {
  const src = readFileSync(file, 'utf8');
  const literal = [
    ...matches(src, /ipcMain\.handle\(\s*'([^']+)'/g),
    ...matches(src, /ipcMain\.on\(\s*'([^']+)'/g),
    // Pro modules register through a feature registrar (pro-ipc.ts).
    ...matches(src, /\bipc\.(?:handle|on)\(\s*'([^']+)'/g),
  ];
  for (const c of literal) literallyRegistered.add(c);
  for (const c of matches(src, /\.send\(\s*'([^']+)'/g)) pushedToRenderer.add(c);

  const block = /const CHANNELS = \[([\s\S]*?)\] as const;/.exec(src);
  const listed = block ? matches(block[1], /'([^']+)'/g) : [];
  for (const c of listed) declared.add(c);
  if (block) registries.push({ file: file.replace(ROOT, ''), listed, literal });
}

/**
 * A channel counts as registered if it is handled with a literal name OR listed
 * in a module's CHANNELS array - a module that registers its channels in a
 * loop over a table is invisible to the literal scan alone.
 */
const registered = new Set([...literallyRegistered, ...declared]);

/**
 * Channels a library in node_modules owns at both ends, so the source scan
 * sees at most one side. Only Pro uses such a library; it lists their
 * prefixes beside its handlers.
 */
const PLUGIN_OWNED_PREFIXES: string[] = PRO
  ? (
      JSON.parse(readFileSync(join(ROOT, 'pro/main/plugin-channels.json'), 'utf8')) as {
        prefixes: string[];
      }
    ).prefixes
  : [];

const missingFrom = (used: Set<string>, known: Set<string>): string[] =>
  [...used]
    .filter((c) => !known.has(c) && !PLUGIN_OWNED_PREFIXES.some((p) => c.startsWith(p)))
    .sort();

// --- self-check ---------------------------------------------------------------

describe('the scan itself', () => {
  // Without this, a change in call style would empty every set and make all the
  // assertions below pass vacuously.
  it('found channels on both sides', () => {
    expect(invoked.size).toBeGreaterThan(50);
    expect(sent.size).toBeGreaterThan(10);
    expect(listenedFor.size).toBeGreaterThan(10);
    expect(registered.size).toBeGreaterThan(50);
    expect(pushedToRenderer.size).toBeGreaterThan(10);
    expect(registries.length).toBeGreaterThanOrEqual(5);
  });

  it('sees the channels we know exist', () => {
    expect(invoked).toContain('git:status');
    expect(registered).toContain('git:status');
    expect(listenedFor).toContain('git:changed');
    expect(pushedToRenderer).toContain('git:changed');
    // One of Pro's modules registers its channels in a loop over a table, so
    // only its CHANNELS array proves they exist: the official tree has
    // channels no literal registration names.
    if (PRO) expect([...declared].some((c) => !literallyRegistered.has(c))).toBe(true);
  });
});

// --- the parity assertions ----------------------------------------------------

describe('every channel the preload calls exists in main', () => {
  it('has a handler for each invoke', () => {
    expect(missingFrom(invoked, registered)).toEqual([]);
  });

  it('has a listener for each send', () => {
    expect(missingFrom(sent, registered)).toEqual([]);
  });
});

describe('every push from main reaches the preload', () => {
  it('has a preload listener for each channel main sends', () => {
    expect(missingFrom(pushedToRenderer, listenedFor)).toEqual([]);
  });

  it('has a sender in main for each channel the preload listens on', () => {
    // A listener for a channel nobody sends is a feature wired to nothing.
    expect(missingFrom(listenedFor, pushedToRenderer)).toEqual([]);
  });
});

describe('no dead channels', () => {
  it('every registered channel is actually reachable from the preload', () => {
    const usedByPreload = new Set([...invoked, ...sent]);
    expect(missingFrom(registered, usedByPreload)).toEqual([]);
  });
});

describe('teardown covers what each module registers', () => {
  // registerXIpc() returns a disposer that calls removeHandler for every entry
  // in its CHANNELS array. A handler missing from that array survives teardown,
  // so re-registering (a second window, a test) throws "second handler".
  it.each(registries.map((r) => [r.file, r] as const))('%s', (_file, registry) => {
    const listed = new Set(registry.listed);
    expect(registry.literal.filter((c) => !listed.has(c))).toEqual([]);
  });
});
