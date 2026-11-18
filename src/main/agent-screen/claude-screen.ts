/**
 * Reading Claude Code's TUI off a screen: the permission mode its footer names and the
 * options of its plan dialog. Some things the CLI takes only as key presses -
 * Shift+Tab cycles the mode, and a hook's answer to ExitPlanMode is ignored
 * (2.1.289) - so a view's watcher reads the tab's screen (screen-mirror.ts)
 * and presses keys. Pure: lines in, answers out.
 *
 * The footer under the prompt names the mode ("⏵⏵ accept edits on",
 * "⏸ plan mode on", "⏸ manual mode on" - read off CLI 2.1.289); which modes
 * the Shift+Tab cycle holds depends on the user's settings.
 */
export type CliMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

export const CLI_MODE_NAMES: Record<CliMode, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Bypass permissions',
};

/** The modes always in Claude's cycle; the others show once seen. */
export const BASE_CLI_MODES: CliMode[] = ['default', 'acceptEdits', 'plan'];

const PATTERNS: Array<[RegExp, CliMode]> = [
  [/accept edits on/i, 'acceptEdits'],
  [/plan mode on/i, 'plan'],
  [/bypass permissions on/i, 'bypassPermissions'],
  [/auto(?:-accept)? mode on/i, 'auto'],
  [/manual mode on/i, 'default'],
];

/**
 * The mode the footer names, from the screen's last lines (bottom first).
 * A Claude prompt with no indicator is in the default mode (older CLIs show
 * none there); null when the screen shows no Claude prompt at all.
 */
/** The screen's rows down to its last one written: an inline TUI leaves blank rows below. */
function written(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end -= 1;
  return lines.slice(0, end);
}

export function parseCliMode(lines: string[]): CliMode | null {
  const tail = written(lines).slice(-12);
  // A dialog (a permission, the plan) hides the footer, and its `❯ 1. Yes`
  // row is no prompt box: no mode can be read then.
  if (tail.some((l) => DIALOG_OPTION.test(l))) return null;
  for (let i = tail.length - 1; i >= 0; i--) {
    for (const [re, mode] of PATTERNS) if (re.test(tail[i])) return mode;
  }
  return tail.some((l) => /^\s*[>❯](?:\s|$)/.test(l)) ? 'default' : null;
}

/** A selected option row of a Claude dialog: `❯ 1. Yes`. */
const DIALOG_OPTION = /^\s*❯\s*\d+\.\s/;

/** The plan card's choices (main's PLAN_* option ids). */
export type PlanChoice = 'plan-accept-edits' | 'plan-ask' | 'plan-keep';

const PLAN_OPTION: Record<Exclude<PlanChoice, 'plan-keep'>, RegExp> = {
  'plan-accept-edits': /auto-accept edits/i,
  'plan-ask': /manually approve|ask each time|switch to default/i,
};

/**
 * The key that picks `choice` in Claude's "ready to code?" dialog on this
 * screen: the option's number, Esc to keep planning, null when the dialog's
 * options are not on screen. Pure, for tests.
 */
export function planDialogKey(lines: string[], choice: PlanChoice): string | null {
  // The options block: the contiguous numbered rows around the selected one
  // (`❯ 1. …`), read bottom-up - never a numbered line of the plan above it.
  const rows = written(lines).slice(-30);
  const selected = rows.findLastIndex((l) => DIALOG_OPTION.test(l));
  if (selected === -1) return null;
  const option = /^\s*(?:❯\s*)?(\d+)\.\s+(.+)$/;
  let from = selected;
  while (from > 0 && option.test(rows[from - 1])) from -= 1;
  let to = selected;
  while (to < rows.length - 1 && option.test(rows[to + 1])) to += 1;
  const options = rows.slice(from, to + 1).flatMap((l) => {
    const m = option.exec(l);
    return m ? [{ key: m[1], label: m[2] }] : [];
  });
  if (!options.some((o) => PLAN_OPTION['plan-accept-edits'].test(o.label))) return null;
  if (choice === 'plan-keep') return '\u001b';
  return options.find((o) => PLAN_OPTION[choice].test(o.label))?.key ?? null;
}

/** A numbered choice of a dialog: its digit picks it. */
export type ScreenDialogChoice = { id: string; label: string; selected: boolean };

/** A key a dialog takes, read off its hint row (or one every dialog takes: arrows, Enter, Esc). */
export type ScreenDialogKey = { id: string; label: string };

/**
 * A dialog of Claude's own on the tab's screen, one no hook reports. A
 * `{ any: true }` read adds what a view needs to drive it: its numbered
 * choices and the keys it takes (`dialogKeyInput` turns one into bytes).
 */
export type ScreenDialog = {
  title: string;
  lines: string[];
  choices?: ScreenDialogChoice[];
  keys?: ScreenDialogKey[];
  /**
   * Drawn under the `▔` rule a slash command's picker opens with: no hook
   * will report it, so a view can show it at once - a permission dialog
   * (no such rule) may still get its hook's request a moment later.
   */
  picker?: boolean;
};

/**
 * The key hint row under a Claude dialog ("Enter to confirm · Esc to cancel",
 * "Space to select · Esc to reject all" - the MCP servers dialog, 2.1.x).
 */
const DIALOG_HINT =
  /\b(?:enter to (?:confirm|select|continue|submit)|esc to (?:cancel|exit|reject|go back|skip)|space to (?:select|toggle))\b/i;
/**
 * Any picker's hint row - the strict one above, plus the slash commands'
 * pickers (`/model`: "Enter to set as default · s to use this session only ·
 * Esc to cancel", `/resume`, `/mcp`, `/config`: "Esc to close" / "Esc to
 * clear"; read off CLI 2.1.319).
 */
const ANY_DIALOG_HINT =
  /\b(?:esc to (?:cancel|exit|reject|go back|skip|close|clear)|enter(?:\/\S+)? to \w+|space to \w+|↑\/↓ to navigate)\b/i;
/** A dialog's highlighted choice: `❯ 1. Yes` or a checklist's `❯ [✔] name`. */
const DIALOG_CHOICE = /^\s*❯\s*(?:\d+\.|\[[^\]]{0,2}\])\s/;
/** A rule drawn across the screen (the top edge of a dialog). */
const RULE = /^\s*[─━═╌┄▔-]{8,}\s*$/;
/** A dialog's box sides, dropped from the text a view shows. */
const BOX = /^\s*[│╭╰┃]\s?|\s?[│╮╯┃]\s*$/g;
const DIALOG_MAX_ROWS = 30;

/**
 * A dialog Claude's TUI shows that no hook tells a view about - the
 * startup ones above all (new MCP servers in the project, the folder's
 * trust): its title and its rows as drawn, null when the screen shows none.
 * Read by its key hint as the last row and a highlighted choice above it;
 * a prompt box shows neither. A permission or plan dialog matches too - the
 * caller asks only while no hook request is open. Pure, for tests.
 */
export function parseScreenDialog(
  lines: string[],
  { any = false }: { any?: boolean } = {},
): ScreenDialog | null {
  // Box sides off first: a boxed dialog's choice row starts with `│`.
  const rows = written(lines).map((l) => l.replace(BOX, '').trimEnd());
  // The hint is the dialog's bottom row (a line or two of slack for a
  // wrapped hint).
  let hint = -1;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 3); i--) {
    if ((any ? ANY_DIALOG_HINT : DIALOG_HINT).test(rows[i])) {
      hint = i;
      break;
    }
  }
  if (hint === -1) return null;
  // A hint wrapped onto two rows (`/resume`'s): it starts on the one above.
  if (any && hint > 0 && rows[hint - 1].includes('·') && / to /.test(rows[hint - 1])) hint -= 1;
  if (any) return anyDialog(rows, hint);
  let choice = -1;
  // A box's bottom edge may sit between the choices and the hint.
  let from = hint - 1;
  while (from >= 0 && (RULE.test(rows[from]) || !rows[from].trim())) from -= 1;
  for (let i = from; i >= Math.max(0, hint - DIALOG_MAX_ROWS); i--) {
    if (RULE.test(rows[i])) break;
    if (DIALOG_CHOICE.test(rows[i])) {
      choice = i;
      break;
    }
  }
  if (choice === -1) return null;
  // Up to the rule above it (or as far as a dialog reaches).
  let top = choice;
  while (top > 0 && hint - top < DIALOG_MAX_ROWS && !RULE.test(rows[top - 1])) top -= 1;
  const body = rows.slice(top, hint + 1).filter((l) => !RULE.test(l));
  // Blank rows at the edges go; inner ones keep the dialog's spacing.
  while (body.length > 0 && !body[0].trim()) body.shift();
  while (body.length > 0 && !body[body.length - 1].trim()) body.pop();
  const title = body[0]?.trim();
  if (!title) return null;
  // Common indent off, so the rows read as drawn.
  const indent = Math.min(
    ...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  );
  return { title, lines: body.slice(1).map((l) => l.slice(indent)) };
}

/** Rows above the hint a picker's view shows at most (`/resume` lists far more). */
const ANY_DIALOG_MAX_ROWS = 24;
/** The rule over a slash command's picker (its right end may carry the effort: `▔▔▔ ● high · /effort ▔`). */
const PICKER_RULE = /^\s*▔{8,}/;
/** How far above its hint a picker's top rule may sit. */
const ANY_DIALOG_REACH = 60;

/**
 * Any picker: its title (the first row under the rule it opens with), its
 * last rows, its numbered choices and its keys. A hint row with no rule
 * above it is a picker only when it is a strict dialog hint: a stray
 * "Enter to …" line in the output is no dialog.
 */
function anyDialog(rows: string[], hint: number): ScreenDialog | null {
  // The rule a slash command's picker opens with (`▔▔▔`, 2.1.319) - never a
  // search box's edge inside it; else the nearest rule.
  const reach = rows.slice(Math.max(0, hint - ANY_DIALOG_REACH), hint);
  const base = hint - reach.length;
  const top = reach.findLastIndex((l) => PICKER_RULE.test(l));
  const near = reach.findLastIndex((l) => RULE.test(l));
  const rule = top !== -1 ? base + top : near !== -1 ? base + near : -1;
  const hintText = rows.slice(hint).join(' ').trim();
  if (rule === -1 && !DIALOG_HINT.test(hintText)) return null;
  const opened = rows.slice(rule + 1, hint);
  const titleAt = opened.findIndex((l) => l.trim());
  if (titleAt === -1) return null;
  const title = opened[titleAt].trim();
  const body = opened.slice(Math.max(titleAt + 1, opened.length - ANY_DIALOG_MAX_ROWS));
  while (body.length > 0 && !body[0].trim()) body.shift();
  while (body.length > 0 && !body[body.length - 1].trim()) body.pop();
  const indent = Math.min(
    ...opened.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  );
  return {
    title,
    lines: [...body.map((l) => l.slice(indent)), ...(body.length > 0 ? [''] : []), hintText],
    choices: dialogChoices(opened),
    keys: dialogKeys(hintText),
    picker: top !== -1,
  };
}

const CHOICE_ROW = /^\s*(❯)?\s*(?:[↑↓]\s*)?(\d{1,2})\.\s+(.+?)\s*$/;

/**
 * The numbered choices around the highlighted one (`❯ 2.  Opus 5.5 ✔`): a
 * list without a highlighted number has none to pick by digit (the
 * permission rules' list takes its digits as search text).
 */
export function dialogChoices(body: string[]): ScreenDialogChoice[] {
  const selected = body.findIndex((l) => /^\s*❯\s*\d{1,2}\.\s/.test(l));
  if (selected === -1) return [];
  let from = selected;
  while (from > 0 && CHOICE_ROW.test(body[from - 1])) from -= 1;
  let to = selected;
  while (to < body.length - 1 && CHOICE_ROW.test(body[to + 1])) to += 1;
  const out: ScreenDialogChoice[] = [];
  for (let i = from; i <= to; i++) {
    const m = CHOICE_ROW.exec(body[i]);
    if (!m || Number(m[2]) > 9) continue;
    const label = m[3]
      .replace(/\s{2,}/g, ' · ')
      .replace(/\s*✔/g, '')
      .trim();
    out.push({ id: `choice:${m[2]}`, label, selected: m[1] === '❯' });
  }
  return out;
}

/** Keys every picker takes: move, pick, back out. */
const BASE_KEYS: ScreenDialogKey[] = [
  { id: 'up', label: '↑' },
  { id: 'down', label: '↓' },
  { id: 'enter', label: 'Enter' },
  { id: 'esc', label: 'Esc' },
];

const KEY_NAMES: Record<string, string> = {
  enter: 'enter',
  esc: 'esc',
  space: 'space',
  tab: 'tab',
  '↑': 'up',
  '↓': 'down',
  '←': 'left',
  '→': 'right',
};

/**
 * The keys a hint row names ("Enter to set as default · s to use this
 * session only · Esc to cancel"): each labelled with what it does there, the
 * base keys first. Pure, for tests.
 */
export function dialogKeys(hint: string): ScreenDialogKey[] {
  const keys = new Map(BASE_KEYS.map((k) => [k.id, { ...k }]));
  for (const segment of hint.split('·')) {
    const m = /^\s*(.+?) to (.+?)\s*$/.exec(segment);
    if (!m) continue;
    const action = m[2].trim();
    for (const raw of m[1].split('/')) {
      const name = raw.trim();
      const id =
        KEY_NAMES[name.toLowerCase()] ??
        (/^ctrl\+[a-z]$/i.test(name)
          ? name.toLowerCase()
          : /^[a-z/?]$/.test(name)
            ? `char:${name}`
            : null);
      if (!id) continue;
      const label = `${action.charAt(0).toUpperCase()}${action.slice(1)} (${name})`;
      keys.set(id, { id, label });
    }
  }
  return [...keys.values()];
}

/**
 * The bytes a key of `dialog` sends, null for one it does not offer - a view
 * only presses what the dialog on screen takes. Pure, for tests.
 */
export function dialogKeyInput(dialog: ScreenDialog, id: string): string | null {
  if (id.startsWith('choice:')) {
    return dialog.choices?.some((c) => c.id === id) ? id.slice('choice:'.length) : null;
  }
  if (!dialog.keys?.some((k) => k.id === id)) return null;
  const fixed: Record<string, string> = {
    up: '\u001b[A',
    down: '\u001b[B',
    right: '\u001b[C',
    left: '\u001b[D',
    enter: '\r',
    esc: '\u001b',
    space: ' ',
    tab: '\t',
  };
  if (fixed[id]) return fixed[id];
  if (/^ctrl\+[a-z]$/.test(id)) return String.fromCharCode(id.charCodeAt(5) - 96);
  if (id.startsWith('char:')) return id.slice('char:'.length);
  return null;
}

/** Claude's placeholder in an empty prompt box while prompts wait in its queue (2.1.319). */
const QUEUE_HINT = /press up to edit queued messages/i;
/** The rules above and below the prompt box. */
const BOX_RULE = /^\s*─{8,}\s*$/;

/**
 * Claude's prompt box at the bottom of the screen: its rows (the `❯ ` and
 * the 2-space indent off), whether it is empty, and whether it shows the
 * "Press up to edit queued messages" placeholder; null when no prompt box
 * shows (a dialog, a screen not yet painted). Pure, for tests.
 */
export function promptBox(
  lines: string[],
): { rows: string[]; empty: boolean; queueHint: boolean } | null {
  const rows = written(lines);
  for (let i = rows.length - 1; i >= Math.max(1, rows.length - 30); i--) {
    if (!/^\s*❯(?:\s|$)/.test(rows[i]) || !BOX_RULE.test(rows[i - 1])) continue;
    const box: string[] = [rows[i].replace(/^\s*❯\s?/, '')];
    for (let j = i + 1; j < rows.length && !BOX_RULE.test(rows[j]); j++) {
      box.push(rows[j].replace(/^ {2}/, ''));
    }
    const text = box.join('\n');
    const queueHint = QUEUE_HINT.test(text);
    return { rows: box, empty: queueHint || !text.trim(), queueHint };
  }
  return null;
}
