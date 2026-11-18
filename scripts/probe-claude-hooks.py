#!/usr/bin/env python3
"""
Probe which Claude Code hook events fire - and whether a STANDALONE terminal
bell rings - for a scripted interaction, exactly as the app sees them.

Use it to verify the event → verb mapping in src/main/claude-status-hooks.ts
against the real CLI before changing it (hook semantics are not always what
the docs suggest: `/clear` fires SessionEnd, the idle notification rings a raw
BEL under preferredNotifChannel=terminal_bell, ...).

It spawns `claude --settings <probe hooks>` under a pty (like node-pty in the
app), logs every hook event with its JSON to hooks.log, every output chunk to
raw.bin, and classifies each BEL as an OSC terminator or a standalone bell in
events.log. The default script: one tiny prompt, focus-out for 75s (idle
notification), /clear, focus-out again, /exit. Edit `SCRIPT` below for other
scenarios. Costs one small API call.

    python3 scripts/probe-claude-hooks.py [workdir]

Nested Claude: the CLAUDECODE env var is stripped so it runs inside a Claude
Code session too. Send text and the Enter (\\r) as SEPARATE writes - one write
reads as a paste and never submits.
"""
import json, os, pty, select, signal, struct, sys, termios, fcntl, time

WORK = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('TMPDIR', '/tmp'), 'double0-claude-probe'))
os.makedirs(WORK, exist_ok=True)
HOOK = os.path.join(WORK, 'hook.sh')
SETTINGS = os.path.join(WORK, 'hooks.json')
EVENTS = ['SessionStart', 'SessionEnd', 'Notification', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse']

# (bytes to send | None for "just wait", label, seconds to pump output afterwards)
SCRIPT = [
    (None, 'startup', 12),
    (b'reply with exactly the word ok and nothing else', 'prompt', 1),
    (b'\r', 'enter', 20),
    (b'\x1b[O', 'focus-out (idle notification fires ~60s after Stop)', 75),
    (b'\x1b[I', 'focus-in', 2),
    (b'/clear', 'type /clear', 1.5),
    (b'\r', 'enter', 3),
    (b'\x1b[O', 'focus-out again', 75),
    (b'\x1b[I', 'focus-in', 2),
    (b'/exit', 'type /exit', 1),
    (b'\r', 'enter', 4),
]

with open(HOOK, 'w') as f:
    f.write('#!/bin/sh\nexec 2>/dev/null\n'
            "ts=$(perl -MTime::HiRes=time -e 'printf \"%.3f\", time')\n"
            'echo "$ts $1 $(cat | tr -d \'\\n\' | cut -c1-2000)" >> "$PROBE_DIR/hooks.log"\nexit 0\n')
os.chmod(HOOK, 0o755)
json.dump({'hooks': {e: [{'hooks': [{'type': 'command', 'command': f"'{HOOK}' {e}"}]}] for e in EVENTS}},
          open(SETTINGS, 'w'), indent=1)
for name in ('hooks.log', 'events.log', 'raw.bin'):
    try: os.remove(os.path.join(WORK, name))
    except FileNotFoundError: pass

env = dict(os.environ, PROBE_DIR=WORK, TERM='xterm-256color')
env.pop('CLAUDECODE', None); env.pop('CLAUDE_CODE_ENTRYPOINT', None)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(WORK)
    os.execvpe('claude', ['claude', '--settings', SETTINGS], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
raw = open(os.path.join(WORK, 'raw.bin'), 'wb')
ev = open(os.path.join(WORK, 'events.log'), 'w')

def note(line):
    ev.write(line + '\n'); ev.flush(); print(line, flush=True)

def pump(secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if not r: continue
        try: b = os.read(fd, 65536)
        except OSError: return
        if not b: return
        t = time.time()
        raw.write(f'\n#### {t:.3f}\n'.encode()); raw.write(b); raw.flush()
        i = 0
        while (i := b.find(b'\x07', i)) >= 0:
            j = b.rfind(b'\x1b]', 0, i)
            kind = 'osc-terminator' if j >= 0 and b'\x07' not in b[j:i] else 'STANDALONE'
            note(f'{t:.3f} BEL {kind} ctx={b[max(0, i - 40):i + 1]!r}'); i += 1
        if b'6790' in b: note(f'{t:.3f} MARKER {b!r}')

for data, label, wait in SCRIPT:
    if data is not None:
        note(f'{time.time():.3f} SEND {label}'); os.write(fd, data)
    pump(wait)
try: os.kill(pid, signal.SIGTERM)
except ProcessLookupError: pass
note('DONE')
print('\n==== hooks.log (event, then the interesting fields)')
for line in open(os.path.join(WORK, 'hooks.log')):
    ts, event, _, payload = line.split(' ', 3)
    try: d = json.loads(payload)
    except ValueError: d = {}
    keys = {k: d[k] for k in ('reason', 'source', 'notification_type', 'tool_name') if k in d}
    print(ts, event, keys)
print(f'\nfull logs: {WORK}/hooks.log  events.log  raw.bin')
