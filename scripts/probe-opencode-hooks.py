#!/usr/bin/env python3
"""
Probe which OpenCode plugin hooks and events fire for a scripted interaction,
exactly as the app's status plugin sees them - the OpenCode twin of
probe-claude-hooks.py, for verifying the event → verb mapping in
src/main/opencode-status-plugin.ts against the real binary rather than its docs.

It spawns the `opencode` TUI under a pty with a logging plugin loaded the
same way the app loads its own (OPENCODE_CONFIG_CONTENT = {"plugin":
["file://…"]}; `plugin` arrays concatenate across config sources, so the
user's config is untouched), with DOUBLE0_TTY pointing at the pty so the
plugin can prove that a marker written there reaches the terminal stream.
Every hook call and bus event goes to events.log, every output chunk to
raw.bin. The default script: one prompt that asks a question (the `question`
tool), runs `ls -la` (the `bash` tool) and replies "done"; the probe answers
the question and any permission prompt with Enter, waits for session.idle,
then `/exit`s. Pass a session id as the second argument to resume it instead
(no prompt is sent - costs nothing).

Findings (1.17.20, 2026-10-03): the plugin runs in the TUI process
(`bun …/tui/worker.js`, env inherited); hooks `chat.message`,
`tool.execute.before` (args = the tool's arguments), `tool.execute.after`,
`dispose` (on /exit) all fire; events `session.created`/`updated` (info
carries `parentID` for a subagent's session and `agent`), `session.status`
busy|idle (busy repeats many times per turn, idle fires with
`session.idle`, both twice at the end), `question.asked` {id, sessionID,
questions:[{question, header, options:[{label, description}]}]} and
`question.replied` {requestID, answers}. Permissions (the work folder gets
an `opencode.json` with `permission.bash: ask`, so the bash tool asks):
`tool.execute.before` fires FIRST, then `permission.asked` {id, sessionID,
permission: "bash", patterns: [...], metadata: {command}, always: [...],
tool: {messageID, callID}} - no title; the dialog is a list (Allow once /
Allow always / Reject; Enter picks the first, Esc rejects);
`permission.replied` is {sessionID, requestID, reply: once|always|reject}
(there is no `permission.updated`); a rejection runs no tool and goes
straight to `session.idle`. A value the plugin puts in `process.env` shows
in `env` run by the bash tool (its children inherit the process env). The
TUI requests SGR mouse (1006) and the alternate screen; Ctrl+End draws
nothing, PgUp moves the message list a couple of rows, a click on row 0
opens the "Message Actions" dialog (so the Inputs list never walks it,
lib/terminal/input-jump.ts). `opencode -s <id>` continues a session; a
stale id exits the TUI with "Session not found".

    python3 scripts/probe-opencode-hooks.py [workdir] [session-id]
    OPENCODE=/path/to/opencode OPENCODE_MODEL=opencode/claude-haiku-4-5 python3 scripts/probe-opencode-hooks.py

Costs one small model call for the default script. Nested: CLAUDECODE and
every DOUBLE0_* / OPENCODE_CONFIG_CONTENT of the shell are stripped (the
app's own tab env would otherwise be inherited - and now mark the probe's
OpenCode as nested, silencing the app's plugin) so it runs inside a double0
tab too. End the TUI with /exit, then SIGTERM - never SIGKILL.
"""
import json, os, pty, re, select, signal, struct, sys, termios, fcntl, time

WORK = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('ses_') else os.path.join(os.environ.get('TMPDIR', '/tmp'), 'double0-opencode-probe'))
RESUME = next((a for a in sys.argv[1:] if a.startswith('ses_')), None)
os.makedirs(os.path.join(WORK, 'work'), exist_ok=True)
OPENCODE = os.environ.get('OPENCODE', 'opencode')
MODEL = os.environ.get('OPENCODE_MODEL')
PLUGIN = os.path.join(WORK, 'probe-plugin.js')
LOG = os.path.join(WORK, 'events.log')

with open(PLUGIN, 'w') as f:
    f.write('''import fs from 'node:fs'
const log = (line) => { try { fs.appendFileSync(process.env.PROBE_LOG, `${(Date.now() / 1000).toFixed(3)} ${line}\\n`) } catch {} }
const tty = () => { try { fs.appendFileSync(process.env.DOUBLE0_TTY, '\\x1b]6790;probe-ping\\x07') } catch (e) { log(`tty write failed ${e}`) } }
process.on('exit', () => log('process exit'))
export const DoubleZeroProbe = async (input) => {
  log(`init pid=${process.pid} directory=${input.directory} tty=${process.env.DOUBLE0_TTY} argv=${process.argv.join(' ')}`)
  tty()
  return {
    event: async ({ event }) => { log(`event ${event.type} ${JSON.stringify(event.properties ?? {}).slice(0, 600)}`) },
    'chat.message': async (inp, out) => { log(`chat.message ${JSON.stringify(inp)} parts=${JSON.stringify(out.parts).slice(0, 300)}`) },
    'tool.execute.before': async (inp, out) => { log(`tool.before ${JSON.stringify(inp)} args=${JSON.stringify(out.args).slice(0, 300)}`) },
    'tool.execute.after': async (inp, out) => { log(`tool.after ${JSON.stringify({ tool: inp.tool, sessionID: inp.sessionID })} title=${JSON.stringify(out.title)}`) },
    'permission.ask': async (inp, out) => { log(`permission.ask ${JSON.stringify(inp).slice(0, 400)} status=${out.status}`) },
    dispose: async () => { log('dispose') },
  }
}
''')
try: os.remove(LOG)
except FileNotFoundError: pass
# The bash tool asks before running: exercises permission.asked / replied.
with open(os.path.join(WORK, 'work', 'opencode.json'), 'w') as f:
    json.dump({'$schema': 'https://opencode.ai/config.json', 'permission': {'bash': 'ask'}}, f)

env = {k: v for k, v in os.environ.items() if not k.startswith('DOUBLE0_')}
env.update(PROBE_LOG=LOG, TERM='xterm-256color',
           OPENCODE_CONFIG_CONTENT=json.dumps({'plugin': [f'file://{PLUGIN}']}))
for k in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'OPENCODE_CONFIG_DIR'): env.pop(k, None)
argv = [OPENCODE] + (['-m', MODEL] if MODEL else []) + (['-s', RESUME] if RESUME else [])
pid, fd = pty.fork()
if pid == 0:
    env['DOUBLE0_TTY'] = os.ttyname(0)
    os.chdir(os.path.join(WORK, 'work'))
    os.execvpe(OPENCODE, argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
raw = open(os.path.join(WORK, 'raw.bin'), 'wb'); screen = b''

def note(s): print(f'{time.time():.3f} {s}', flush=True)
def pump(secs):
    global screen
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if not r: continue
        try: b = os.read(fd, 65536)
        except OSError: return False
        if not b: return False
        raw.write(b); raw.flush(); screen += b
        if b'6790' in b: note(f"MARKER {b[max(0, b.find(b'6790') - 2):b.find(b'6790') + 40]!r}")
    return True
def loglines():
    return open(LOG).read().splitlines() if os.path.exists(LOG) else []

pump(14); note('startup done')
if not RESUME:
    os.write(fd, b'Do three things in order: 1) use the question tool to ask me "Continue?" with the options Yes and No; 2) after my answer run `ls -la` with the bash tool; 3) reply with the single word done.')
    time.sleep(0.6); os.write(fd, b'\r')
t0 = time.time(); answered = set()
while time.time() - t0 < (150 if not RESUME else 12):
    pump(1)
    lines = loglines()
    for key in ('question.asked', 'permission.asked'):
        if key not in answered and any(key in l for l in lines):
            # Enter picks the first entry of either dialog: the first option, Allow once.
            note(f'{key} seen - pressing Enter in 2s'); pump(2); os.write(fd, b'\r'); answered.add(key)
    if not RESUME and any('session.idle' in l for l in lines) and any('tool.after' in l for l in lines) and time.time() - t0 > 8:
        note('session.idle after a tool - done'); pump(3); break
note('sending /exit'); os.write(fd, b'/exit'); time.sleep(0.6)
try: os.write(fd, b'\r')
except OSError: pass
pump(4)
try: os.kill(pid, signal.SIGTERM)
except ProcessLookupError: pass
pump(1)
text = re.sub(rb'\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\x1bP[^\x1b]*\x1b\\', b'', screen).decode('utf8', 'replace')
print('==== last screen lines'); print('\n'.join([l.rstrip() for l in text.splitlines() if l.strip()][-12:]))
print('==== events.log (noise dropped)')
NOISE = ('plugin.added', 'catalog.updated', 'reference.updated', 'integration.updated', 'message.part.delta', 'message.part.updated', 'message.updated', 'session.diff')
print('\n'.join(l[:500] for l in loglines() if not any(n in l for n in NOISE)))
print(f'\nfull logs: {LOG}  {WORK}/raw.bin')
