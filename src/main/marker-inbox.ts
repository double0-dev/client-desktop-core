/**
 * The status markers of a Windows terminal (claude-status-hooks.ts ›
 * MARKER_DIR_ENV). A ConPTY has no device the agent's hooks could write the
 * 6790 / 6791 markers to, so each hook invocation leaves its markers in a
 * file of the pty's marker folder and `PtyHost` drains the folder into the
 * terminal's output stream. From there on they are ordinary stream markers:
 * the mode tracker, the Inputs list, the renderer's session status and the
 * screen copy read them as they read a pty's.
 *
 * Two rules keep the splice invisible:
 * - only well-formed 6790 / 6791 OSCs go in (`validMarkers`) - anything else
 *   in the folder would be written to the user's screen;
 * - they go in only where the stream is between sequences
 *   (`TerminalModeTracker.atGround`): ConPTY's output can stop in the
 *   middle of a CSI, and an OSC spliced there would end it early and print
 *   the rest as text.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { INPUT_OSC, STATUS_OSC } from './claude-status-hooks';

/** How often a terminal's marker folder is read. */
export const MARKER_POLL_MS = 150;

/** A hook writes a few KB at most (a question's payload); more is not ours. */
const MAX_MARKER_FILE = 64 * 1024;

/** `<ns stamp>-<pid>.m`, as the hook script names a published file. */
const MARKER_FILE = /^(\d+)-(\d+)\.m$/;

// One or more OSCs of our two codes, BEL-terminated, payloads base64 / verbs.
const MARKERS = new RegExp(`^(?:\\x1b\\](?:${STATUS_OSC}|${INPUT_OSC});[\\w+/=;.-]*\\x07)+$`);

/** The published marker files in the order the hooks wrote them. */
export function markerFileOrder(names: string[]): string[] {
  const files: { name: string; stamp: bigint; pid: number }[] = [];
  for (const name of names) {
    const m = MARKER_FILE.exec(name);
    if (m) files.push({ name, stamp: BigInt(m[1]), pid: Number(m[2]) });
  }
  files.sort((a, b) => (a.stamp === b.stamp ? a.pid - b.pid : a.stamp < b.stamp ? -1 : 1));
  return files.map((f) => f.name);
}

/** The file's text when it holds nothing but our markers, else null. */
export function validMarkers(text: string): string | null {
  return MARKERS.test(text) ? text : null;
}

/** A published file that cannot be claimed this long is given up on. */
const STUCK_MS = 2000;

/** One terminal's marker folder. */
export class MarkerInbox {
  private disposed = false;
  /** The first file that could not be claimed, and since when. */
  private stuck: { name: string; since: number } | null = null;

  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Empty the folder for a NEW shell: a marker an earlier shell under the
   * same id left behind would replay into this one. Never throws.
   */
  reset(): void {
    try {
      rmSync(this.dir, { recursive: true, force: true });
      mkdirSync(this.dir, { recursive: true });
    } catch {
      // A file held open: drained, at worst, into the new shell.
    }
  }

  /**
   * Every marker published since the last drain, in order. Each file is
   * claimed by a rename before it is read, so it is read once: a file
   * Windows will not let go of (a scanner holding it) is never read twice -
   * it waits, with everything after it, until it can be claimed, or is
   * skipped after `STUCK_MS`. A folder that went missing (a temp sweep) is
   * made again so the next hook has somewhere to write. Never throws.
   */
  async drain(): Promise<string> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      if (!this.disposed) await mkdir(this.dir, { recursive: true }).catch(() => undefined);
      return '';
    }
    // A claimed file a failed unlink left behind.
    for (const name of names) {
      if (name.endsWith('.taken')) await unlink(join(this.dir, name)).catch(() => undefined);
    }
    let out = '';
    for (const name of markerFileOrder(names)) {
      if (this.disposed) break;
      const path = join(this.dir, name);
      const taken = `${path}.taken`;
      try {
        await rename(path, taken);
      } catch {
        if (this.stuck?.name !== name) this.stuck = { name, since: this.now() };
        if (this.now() - this.stuck.since < STUCK_MS) break;
        continue;
      }
      if (this.stuck?.name === name) this.stuck = null;
      let text: string;
      try {
        text = await readFile(taken, 'utf8');
      } catch {
        continue;
      } finally {
        await unlink(taken).catch(() => undefined);
      }
      if (text.length > MAX_MARKER_FILE) continue;
      out += validMarkers(text) ?? '';
    }
    return out;
  }

  /** The terminal is gone: its folder with it. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
