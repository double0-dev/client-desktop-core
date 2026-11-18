import { SNAPSHOT_BEHIND_BYTES } from './protocol';

/**
 * Per-client flow control for a daemon several apps share
 * (a private plan › 14, "A slow client"). Pure -
 * daemon-server.ts asks it per output chunk and per pause / resume.
 *
 * With one client the old rule stands: its `pause` stops the pty, its
 * `resume` lets it flow. With several, one slow laptop must never stall the
 * terminal for the others: the pty stops only while EVERY attached client
 * paused it. Meanwhile a client that paused still gets the output, counted
 * as unread; past `limit` bytes the rest of the stream is dropped for that
 * client alone and it is told once (`snapshot-needed`), so it re-adopts and
 * catches up from the snapshot. Its next `adopt` of the terminal starts it
 * afresh.
 */
export type ChunkVerdict = 'send' | 'drop' | 'notify';

type State = { behind: number; dropped: boolean };

export class FlowAccounting {
  /** connection → terminal → what it has not read since its pause. */
  private readonly paused = new Map<number, Map<string, State>>();

  constructor(private readonly limit: number = SNAPSHOT_BEHIND_BYTES) {}

  private of(conn: number): Map<string, State> {
    let m = this.paused.get(conn);
    if (!m) {
      m = new Map();
      this.paused.set(conn, m);
    }
    return m;
  }

  isPaused(conn: number, id: string): boolean {
    return this.paused.get(conn)?.has(id) ?? false;
  }

  pause(conn: number, id: string): void {
    const m = this.of(conn);
    if (!m.has(id)) m.set(id, { behind: 0, dropped: false });
  }

  /**
   * The client reads again. A client whose stream was already dropped stays
   * dropped until it re-adopts: what it would get now has a hole before it.
   */
  resume(conn: number, id: string): void {
    const m = this.paused.get(conn);
    const s = m?.get(id);
    if (!m || !s || s.dropped) return;
    m.delete(id);
  }

  /** What to do with `bytes` of terminal `id`'s output for client `conn`. */
  chunk(conn: number, id: string, bytes: number): ChunkVerdict {
    const s = this.paused.get(conn)?.get(id);
    if (!s) return 'send';
    if (s.dropped) return 'drop';
    s.behind += bytes;
    if (s.behind <= this.limit) return 'send';
    s.dropped = true;
    return 'notify';
  }

  /** The client took a fresh snapshot of `id` (adopt): nothing is owed any more. */
  adopted(conn: number, id: string): void {
    this.paused.get(conn)?.delete(id);
  }

  /** Whether every one of `conns` paused `id` - only then does the pty stop. */
  allPaused(id: string, conns: Iterable<number>): boolean {
    let any = false;
    for (const conn of conns) {
      any = true;
      if (!this.isPaused(conn, id)) return false;
    }
    return any;
  }

  forget(id: string): void {
    for (const m of this.paused.values()) m.delete(id);
  }

  connectionGone(conn: number): void {
    this.paused.delete(conn);
  }
}
