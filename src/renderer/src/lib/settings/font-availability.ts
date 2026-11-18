/**
 * Which font choices this machine can actually render. Most of the offered
 * families are local fonts (SF Mono / Menlo / Monaco ship with macOS only,
 * Consolas / Cascadia with Windows, DejaVu / Ubuntu Mono with most Linux
 * distributions, JetBrains Mono / Fira Code only when the user installed them);
 * a missing one falls through its stack to the same fallback as its
 * neighbours, so picking it changes nothing on screen. On Windows and Linux
 * the pickers list a probed family only when its font is installed; macOS
 * keeps the list it always had.
 */

export type ProbedFontFamily = {
  id: string;
  /** Local font name the choice depends on; none = always renders (a stack or a bundled face). */
  probe?: string;
  /** Offered on Windows and Linux only. */
  notOnMac?: boolean;
};

/**
 * The choices to list. On Windows and Linux: every family whose font is
 * installed, plus the selected one even when it is not (a setting imported
 * from another machine stays visible instead of the select silently showing
 * its first option). On macOS: every family that is not `notOnMac`, unprobed -
 * a stock Mac reaches SF Mono only through `ui-monospace`, so its probe fails.
 */
export function offeredFontFamilies<T extends ProbedFontFamily>(
  families: readonly T[],
  selected: string,
  isInstalled: (font: string) => boolean,
  mac: boolean,
): T[] {
  if (mac) return families.filter((f) => !f.notOnMac || f.id === selected);
  return families.filter((f) => !f.probe || f.id === selected || isInstalled(f.probe));
}

// Each generic draws the sample at a different width, so a font whose metrics
// happen to match one of them (Consolas is Chromium's `monospace` on Windows,
// DejaVu Sans Mono on most Linux systems) still differs from another.
const BASE_FAMILIES = ['monospace', 'sans-serif', 'serif'];
const SAMPLE = 'mmmmmmmmmmlli10OWQ@#';

const installed = new Map<string, boolean>();

function canvasContext(): CanvasRenderingContext2D | null {
  try {
    return document.createElement('canvas').getContext('2d');
  } catch {
    return null;
  }
}

/**
 * Whether a local font is installed: the sample is measured in `"<font>",
 * <generic>` against the bare generic - a missing font measures exactly as its
 * fallback for every generic. Unmeasurable (no canvas, as under jsdom) counts
 * as installed, so nothing is hidden on a guess.
 */
export function isFontInstalled(font: string): boolean {
  const cached = installed.get(font);
  if (cached !== undefined) return cached;
  const ctx = canvasContext();
  if (!ctx) return true;
  const width = (family: string): number => {
    ctx.font = `72px ${family}`;
    return ctx.measureText(SAMPLE).width;
  };
  const result = BASE_FAMILIES.some((base) => width(`"${font}", ${base}`) !== width(base));
  installed.set(font, result);
  return result;
}
