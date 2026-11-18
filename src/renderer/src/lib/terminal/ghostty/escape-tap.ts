/**
 * The escape sequences the app reads out of a terminal's stream, found
 * without a terminal parser of our own.
 *
 * xterm.js lets us hook its parser (`term.parser.registerOscHandler` /
 * `registerCsiHandler`): our OSC 6790 / 6791 marks and the DECSET watch in
 * inputs.ts run at the exact point of the stream where the sequence ends, so
 * a handler that reads the cursor sees it where the mark was printed. The
 * Ghostty engine has no such hook. This tap scans the text on its way in and
 * cuts it right after each sequence someone asked for, so the caller writes
 * the piece, then runs the handler - the same moment xterm would have.
 *
 * A sequence may arrive split across chunks; the tap keeps its state between
 * `feed` calls and the terminal behind it gets every byte in order either way.
 */

export type TapEvent =
  | { kind: 'osc'; id: number; data: string }
  | { kind: 'csi'; prefix: string; final: string; params: number[] };

/** Write `text`, then handle `event` (when there is one). */
export type TapPiece = { text: string; event?: TapEvent };

export type TapInterest = {
  osc: (id: number) => boolean;
  csi: (prefix: string, final: string) => boolean;
};

/** A payload past this is no mark of ours: it is passed through, never collected. */
const MAX_OSC_DATA = 1 << 20;
/** CSI parameters past this are garbage. */
const MAX_CSI_PARAMS = 256;

const ESC = '\x1b';
const BEL = '\x07';
const CAN = '\x18';
const SUB = '\x1a';

type State =
  | { kind: 'ground' }
  | { kind: 'esc' }
  | { kind: 'osc-id'; id: string }
  | { kind: 'osc-data'; id: number; data: string; wanted: boolean; overflow: boolean }
  | { kind: 'osc-esc'; id: number; data: string; wanted: boolean; overflow: boolean }
  | { kind: 'csi'; params: string; intermediates: string };

export class EscapeTap {
  private state: State = { kind: 'ground' };

  constructor(private readonly interest: TapInterest) {}

  feed(chunk: string): TapPiece[] {
    const pieces: TapPiece[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const event = this.step(chunk[i]);
      if (event) {
        pieces.push({ text: chunk.slice(start, i + 1), event });
        start = i + 1;
      }
    }
    if (start < chunk.length) pieces.push({ text: chunk.slice(start) });
    return pieces;
  }

  /** Advance by one character; returns the event a finished sequence makes. */
  private step(ch: string): TapEvent | null {
    const s = this.state;
    switch (s.kind) {
      case 'ground':
        if (ch === ESC) this.state = { kind: 'esc' };
        return null;
      case 'esc':
        if (ch === ']') this.state = { kind: 'osc-id', id: '' };
        else if (ch === '[') this.state = { kind: 'csi', params: '', intermediates: '' };
        else this.state = ch === ESC ? { kind: 'esc' } : { kind: 'ground' };
        return null;
      case 'osc-id': {
        if (ch >= '0' && ch <= '9' && s.id.length < 8) {
          s.id += ch;
          return null;
        }
        const id = s.id === '' ? -1 : Number(s.id);
        const wanted = id >= 0 && this.interest.osc(id);
        if (ch === ';') {
          this.state = { kind: 'osc-data', id, data: '', wanted, overflow: false };
          return null;
        }
        // Terminated (or broken) before any payload.
        this.state = { kind: 'osc-data', id, data: '', wanted, overflow: false };
        return this.step(ch);
      }
      case 'osc-data':
        if (ch === BEL) return this.endOsc(s);
        if (ch === ESC) {
          this.state = { ...s, kind: 'osc-esc' };
          return null;
        }
        if (ch === CAN || ch === SUB) {
          this.state = { kind: 'ground' };
          return null;
        }
        if (s.wanted && !s.overflow) {
          if (s.data.length >= MAX_OSC_DATA) {
            s.overflow = true;
            s.data = '';
          } else s.data += ch;
        }
        return null;
      case 'osc-esc':
        // ST is ESC \; any other ESC aborts the string and starts a new escape.
        if (ch === '\\') return this.endOsc(s);
        this.state = { kind: 'esc' };
        return this.step(ch);
      case 'csi': {
        const code = ch.charCodeAt(0);
        if (code >= 0x30 && code <= 0x3f) {
          if (s.params.length < MAX_CSI_PARAMS) s.params += ch;
          return null;
        }
        if (code >= 0x20 && code <= 0x2f) {
          s.intermediates += ch;
          return null;
        }
        this.state = ch === ESC ? { kind: 'esc' } : { kind: 'ground' };
        if (code < 0x40 || code > 0x7e) return null; // broken sequence
        if (s.intermediates) return null;
        const prefix = /^[<=>?]/.test(s.params) ? s.params[0] : '';
        if (!this.interest.csi(prefix, ch)) return null;
        return {
          kind: 'csi',
          prefix,
          final: ch,
          params: parseParams(s.params.slice(prefix.length)),
        };
      }
    }
  }

  private endOsc(s: {
    id: number;
    data: string;
    wanted: boolean;
    overflow: boolean;
  }): TapEvent | null {
    this.state = { kind: 'ground' };
    if (!s.wanted || s.overflow) return null;
    return { kind: 'osc', id: s.id, data: s.data };
  }
}

/** `1;1006` → [1, 1006]; sub-parameters (`4:3`) keep their head; an empty one is 0. */
function parseParams(raw: string): number[] {
  if (raw === '') return [];
  return raw.split(';').map((part) => {
    const head = part.split(':')[0];
    const n = Number.parseInt(head, 10);
    return Number.isFinite(n) ? n : 0;
  });
}
