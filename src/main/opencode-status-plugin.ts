import { OPENCODE_SESSION_RECORD_ENV, shellQuote } from './agent-resume';
import {
  INPUT_OSC,
  PROMPT_PAYLOAD_BYTES,
  STATUS_OSC,
  STATUS_OWNER_ENV,
} from './claude-status-hooks';

/**
 * OpenCode status wiring - the PURE part of the OpenCode agent adapter: the
 * plugin OpenCode loads into its server, which turns its event bus into the
 * same 6790 marker grammar the Claude Code hooks emit (claude-status-hooks.ts),
 * and the launch-line pieces that get it loaded. No Electron / fs imports;
 * launch-materialize.ts writes the plugin to disk and claude-shim.ts puts the env on the
 * launch line. a private plan has the whole story.
 *
 * How it gets in: OpenCode merges the JSON in `OPENCODE_CONFIG_CONTENT` over
 * its config files (runtime overrides tier) and CONCATENATES `plugin` arrays
 * across sources, and a `file://` plugin spec is imported as is - so one env
 * var adds our plugin without touching the user's `opencode.json` or their own
 * plugins (verified on 1.17.20: the plugin loaded, every hook below fired).
 * The variable is exported only when the user has none of their own
 * (`opencodeConfigExport`): a JSON merge in sh is not worth the risk, and a
 * user who sets it keeps their config and loses only our status.
 *
 * Where the markers go: the plugin runs inside the `opencode` process (its
 * TUI worker, same env), so it writes straight to the pty device the launch
 * shell captured in DOUBLE0_TTY - what the hook script does from a child
 * process for Claude. xterm drops the unknown OSC; main and the renderer read
 * it (terminal-modes.ts, lib/session/status.ts).
 *
 * Event → verb (OpenCode 1.17.20, read off a live probe -
 * scripts/probe-opencode-hooks.py):
 *   plugin loaded                       → ready (marker mode armed at once)
 *   chat.message (a prompt sent)        → running + the 6791 prompt mark for
 *                                         the Inputs list (`program` names
 *                                         the agent - terminal-inputs.ts)
 *   session.status busy, from idle      → running (a turn no chat.message
 *                                         opened - a resumed session)
 *   tool.execute.before / after         → tool-start / tool-done with the
 *                                         tool's name + headline argument;
 *                                         a child session's (the task tool's
 *                                         subagent) carry its agent as the
 *                                         third line, like Claude's
 *   permission.asked                    → needs-input, once per request id,
 *                                         with `Permission for <permission>:
 *                                         <patterns>` as the message (the
 *                                         request carries no title; the row
 *                                         names the pending tool anyway -
 *                                         tool.execute.before fires FIRST,
 *                                         the ask comes from inside the
 *                                         tool); permission.replied (any
 *                                         reply: once / always / reject) →
 *                                         question-done (the wait is over,
 *                                         same turn - `running` would open a
 *                                         new one). A rejection runs no tool
 *                                         and ends in session.idle →
 *                                         finished.
 *   question.asked                      → question with the questions in the
 *                                         Claude AskUserQuestion shape the
 *                                         renderer decodes; replied/rejected
 *                                         → question-done
 *   session.idle / session.status idle  → finished (once per turn)
 *   dispose (the TUI exiting)           → ended
 * Child sessions never open or close the tab's turn: the parent's own idle
 * does. `session.created`/`updated` also keep the tab's record of its live
 * session (DOUBLE0_OPENCODE_SESSION_FILE, agent-resume.ts) so a relaunch
 * continues it (`opencode -s <id>`, through the shim).
 *
 * The permission flow was driven live on 1.17.20 with `permission.bash: ask`
 * (2026-10-03, approve with Enter = Allow once, reject with Esc):
 * `permission.asked` is `{id, sessionID, permission, patterns, metadata,
 * always, tool}` and `permission.replied` is `{sessionID, requestID, reply}` -
 * the first version read a `title` and a `permissionID` that do not exist,
 * so no reply ever lifted the wait (only the tool-done heal did), and the
 * `permission.updated` event it also listened for is not in the binary.
 *
 * Nesting: an `opencode` that an agent runs INSIDE its tool (Claude's Bash,
 * OpenCode's own bash) inherits the inline config and the pty device, so
 * this plugin loads there too - and would write `ready` / `ended` into the
 * PARENT tab's pty. The reporting agent's env marks every descendant
 * (DOUBLE0_STATUS_OWNER, claude-status-hooks.ts): set at load, the plugin
 * installs no hooks and writes nothing; unset, it sets the variable in its
 * own `process.env` first - the bash tool's children inherit it (verified
 * live on 1.17.20: a value set here showed in `env` run by the tool).
 *
 * Rules: never throw (a plugin error is OpenCode's to log, never the user's
 * to see mid-session), never print, every write wrapped. ESM without
 * dependencies: it runs under Bun inside OpenCode and under Node in the test.
 */

/** Folder under the OS temp dir holding the plugin file. */
export const OPENCODE_PLUGIN_DIR_NAME = 'double0-opencode';
/** The plugin file's name (the `file://` spec names it). */
export const OPENCODE_PLUGIN_FILE_NAME = 'double0-status.js';
/** The env var OpenCode reads inline config overrides from. */
export const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT';

/**
 * OpenCode's subcommands that are no interactive session (1.17.20's
 * `opencode --help`): the shim passes them through untouched, and the plugin
 * - still loaded by them through the exported config - stays silent
 * (review, 2026-10-06).
 */
export const OPENCODE_SUBCOMMANDS = [
  'completion',
  'acp',
  'mcp',
  'attach',
  'run',
  'debug',
  'providers',
  'auth',
  'agent',
  'upgrade',
  'uninstall',
  'serve',
  'web',
  'models',
  'stats',
  'export',
  'import',
  'github',
  'pr',
  'session',
  'plugin',
  'plug',
  'db',
];

/** Argument keys a tool call's headline is read from, in order of preference. */
const ARG_KEYS = [
  'filePath',
  'file_path',
  'path',
  'command',
  'pattern',
  'description',
  'url',
  'query',
  'name',
  'skill',
];

/** Cap on a question payload's base64 - the renderer's carry buffer (CARRY_MAX). */
const QUESTION_PAYLOAD_MAX = 6000;

// The `${''}` before the plugin's own import keeps that line from starting with
// `import`: electron-vite puts main's ESM `__dirname` shim after the LAST
// line-start `import … from '…'` it finds, and one inside this string pulled the
// shim into the template - every main bundle died on `__dirname is not defined`.
export const OPENCODE_STATUS_PLUGIN = String.raw`// double0: OpenCode session status plugin - generated by src/main/opencode-status-plugin.ts.
// Reports the agent's lifecycle as the private 6790 status markers double0
// reads off the tab's pty (DOUBLE0_TTY), in the grammar its Claude Code hooks
// use. Never throws, never prints.
${''}import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs'

const STATUS = '\x1b]${STATUS_OSC};'
const INPUT = '\x1b]${INPUT_OSC};'
const BEL = '\x07'
const LINE_MAX = 300
const PROMPT_BYTES = ${PROMPT_PAYLOAD_BYTES}
const QUESTION_MAX = ${QUESTION_PAYLOAD_MAX}
const ARG_KEYS = ${JSON.stringify(ARG_KEYS)}
const OWNER = '${STATUS_OWNER_ENV}'
const SUBCOMMANDS = ${JSON.stringify(OPENCODE_SUBCOMMANDS)}
const tty = process.env.DOUBLE0_TTY || ''
const record = process.env.${OPENCODE_SESSION_RECORD_ENV} || ''

// Child sessions (the task tool's subagents) by id, with their agent name.
const children = new Map()
// Each top-level session's turn: 'idle' | 'running' | 'waiting'.
const status = new Map()
// Permission / question ids the user has not answered yet.
const pending = new Set()
let recorded = ''
let ended = false

function write(text) {
  if (!tty) return
  try {
    appendFileSync(tty, text)
  } catch {}
}
function marker(verb, payload) {
  return STATUS + verb + (payload ? ';' + payload : '') + BEL
}
function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}
// One payload line: newlines escaped the way a hook's JSON carries them, capped.
function line(value) {
  return String(value == null ? '' : value).replace(/\r?\n/g, '\\n').slice(0, LINE_MAX)
}
function headline(args) {
  if (!args || typeof args !== 'object') return ''
  for (const key of ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}
function remember(info) {
  if (!info || typeof info.id !== 'string') return
  if (info.parentID) {
    children.set(info.id, typeof info.agent === 'string' && info.agent ? info.agent : 'agent')
    return
  }
  children.delete(info.id)
  if (!record || info.id === recorded) return
  recorded = info.id
  try {
    writeFileSync(record, info.id)
  } catch {}
}
function forget(id) {
  status.delete(id)
  children.delete(id)
  if (!record || id !== recorded) return
  recorded = ''
  try {
    unlinkSync(record)
  } catch {}
}
function isChild(id) {
  return children.has(id)
}
function state(id) {
  return status.get(id) || 'idle'
}
function toolPayload(tool, args, sessionID) {
  const agent = children.get(sessionID)
  return b64(line(tool) + '\n' + line(headline(args)) + '\n' + (agent ? line(agent) + '\n' : ''))
}
// What a permission request asks for: its kind and the patterns it covers.
function permissionTitle(p) {
  if (typeof p.permission !== 'string' || !p.permission) return undefined
  const patterns = Array.isArray(p.patterns)
    ? p.patterns.filter((x) => typeof x === 'string' && x).join(', ')
    : ''
  return b64(line('Permission for ' + p.permission + (patterns ? ': ' + patterns : '')))
}
function running(id, prompt) {
  status.set(id, 'running')
  if (typeof prompt !== 'string') {
    write(marker('running'))
    return
  }
  const head = Buffer.from(JSON.stringify({ program: 'opencode', prompt }), 'utf8')
    .subarray(0, PROMPT_BYTES)
    .toString('base64')
  write(marker('running') + INPUT + 'prompt;' + head + BEL)
}
function finished(id) {
  if (state(id) === 'idle') return
  status.set(id, 'idle')
  write(marker('finished'))
}
function waiting(id, verb, payload) {
  status.set(id, 'waiting')
  write(marker(verb, payload))
}
function answered(id) {
  if (state(id) === 'waiting') status.set(id, 'running')
  write(marker('question-done'))
}
function end() {
  if (ended) return
  ended = true
  write(marker('ended'))
}

export const DoubleZeroStatus = async () => {
  // Nested under the tab's reporting agent (its tool ran this OpenCode): say
  // nothing, keep nothing - the parent's status is the parent's.
  if (process.env[OWNER]) return {}
  // A non-interactive run (\`opencode run …\`, \`serve\`) in a tab whose shell
  // still exports the config: no session of the tab's to report.
  if (SUBCOMMANDS.includes(process.argv[2])) return {}
  // Mark this process's children: an agent this one runs stays silent.
  process.env[OWNER] = 'opencode'
  process.on('exit', end)
  write(marker('ready'))
  return {
    event: async ({ event }) => {
      const p = (event && event.properties) || {}
      switch (event && event.type) {
        case 'session.created':
        case 'session.updated':
          remember(p.info)
          break
        case 'session.deleted':
          forget(p.info && p.info.id)
          break
        case 'session.status': {
          if (isChild(p.sessionID)) break
          const type = p.status && p.status.type
          if (type === 'busy' && state(p.sessionID) === 'idle') running(p.sessionID)
          else if (type === 'idle') finished(p.sessionID)
          break
        }
        case 'session.idle':
          if (!isChild(p.sessionID)) finished(p.sessionID)
          break
        case 'permission.asked': {
          if (typeof p.id !== 'string' || pending.has(p.id)) break
          pending.add(p.id)
          waiting(p.sessionID, 'needs-input', permissionTitle(p))
          break
        }
        case 'permission.replied':
          if (pending.delete(p.requestID)) answered(p.sessionID)
          break
        case 'question.asked': {
          if (typeof p.id !== 'string' || pending.has(p.id)) break
          pending.add(p.id)
          const payload = b64(
            JSON.stringify({ tool_name: 'question', tool_input: { questions: p.questions } }),
          )
          if (payload.length <= QUESTION_MAX) waiting(p.sessionID, 'question', payload)
          else waiting(p.sessionID, 'needs-input')
          break
        }
        case 'question.replied':
        case 'question.rejected':
          if (pending.delete(p.requestID)) answered(p.sessionID)
          break
        default:
          break
      }
    },
    'chat.message': async (input, output) => {
      if (!input || isChild(input.sessionID)) return
      const parts = (output && output.parts) || []
      const text = parts
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
      running(input.sessionID, text)
    },
    'tool.execute.before': async (input, output) => {
      if (!input) return
      if (!isChild(input.sessionID)) status.set(input.sessionID, 'running')
      write(marker('tool-start', toolPayload(input.tool, output && output.args, input.sessionID)))
    },
    'tool.execute.after': async (input) => {
      if (!input) return
      write(marker('tool-done', toolPayload(input.tool, input.args, input.sessionID)))
    },
    dispose: async () => {
      end()
    },
  }
}
`;

/** The inline config that loads the plugin at `pluginPath` - OpenCode's `plugin` spec takes a `file://` URL as is. */
export function opencodeConfigContent(pluginPath: string): string {
  return JSON.stringify({ plugin: [`file://${pluginPath}`] });
}

/**
 * The launch-line fragment that exports the inline config - unless the user
 * already has runtime overrides of their own, which stay untouched (theirs
 * wins over our status). POSIX sh.
 */
export function opencodeConfigExport(pluginPath: string): string {
  return `[ -n "\${${OPENCODE_CONFIG_ENV}:-}" ] || export ${OPENCODE_CONFIG_ENV}=${shellQuote(opencodeConfigContent(pluginPath))}`;
}
