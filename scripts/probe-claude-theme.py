#!/usr/bin/env python3
"""
Probe how Claude Code picks its light/dark palette under `"theme": "auto"` -
exactly as the app's pty sees it (main/terminal.ts spawns it, an xterm.js
answers its terminal queries, lib/terminal/restyle.ts rewrites the result).

It spawns the real `claude` under a pty, logs every terminal QUERY it sends
(OSC 10/11 colour queries, DA1/DA2, DECRQM, XTVERSION, the mode-2031
colour-scheme subscription, ...) and answers them the way xterm.js 6 does,
under a chosen scenario. Every output chunk lands in raw.bin; the unique
truecolor SGR values per phase go to palette.log, so the tone Claude Code
paints in is readable off the file (light-only values: fg 51;51;51, diff
220;255;220 / 255;220;220; dark-only: fg 255;255;255, diff 2;40;0 / 61;1;0).

    python3 scripts/probe-claude-theme.py <scenario> [workdir]

    dark     answer the OSC 11 query with a dark background at once
    light    answer it with a light background at once
    none     never answer the colour query (DA1 still answered) - the fallback
    late     answer nothing for 12 s, then dark (a query answered on a replay)
    late-light  the same, answered light - does a late answer still count?
    flip     answer dark, then push CSI ?997;2n (light) at +8 s and ?997;1n at
             +16 s, answering the re-query each push provokes with THAT tone
             (what xterm.js does once its theme has changed)
    requery  answer dark, then resize / focus-out / focus-in - does it re-ask?
    unsolicited  answer dark at once, then at +10 s send an OSC 11 light answer
             + DA1 nobody asked for (a replayed stale query answered by a
             fresh xterm) - ignored, adopted, or typed into the prompt?
    adopt-together  nothing answered at startup, then the late DA1 answer and
             CSI ?997;2n in ONE write (they reach the pty back to back)
    adopt    what an eager pty's first adopt does: nothing answered at startup
             (no xterm yet), then at +12 s the replayed DA1 is answered late and
             CSI ?997;2n is pushed, re-queries answered light
    adopt-push-first  the same with the push BEFORE the late DA1 answer (the
             order main sends them in: push at adopt, DA1 answered by the
             renderer's xterm a round trip later)
    unanswered-flip  answer nothing at startup (no xterm attached), push
             CSI ?997;2n at +12 s and answer the re-query light - is a push
             still honoured after an unanswered startup?
    prompt   answer dark, submit one tiny prompt (the ONLY scenario that
             costs an API call), then push light at +22 s: the transcript is
             re-rendered, so the user-message bar and reply chrome are
             captured in BOTH palettes (bar.log lists every bar sequence with
             the text styling that follows it)

Run it in a trusted repo dir (a fresh folder hits the trust dialog). Nested
Claude: CLAUDECODE is stripped so it runs inside a Claude Code session too.
The shim dir is skipped on PATH so the real binary is probed, without the
app's hooks.
"""
import fcntl, os, pty, re, select, signal, struct, sys, termios, time

SCENARIO = sys.argv[1] if len(sys.argv) > 1 else 'dark'
WORK = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.getcwd())
OUT = os.path.join(os.environ.get('TMPDIR', '/tmp'), f'double0-claude-theme-{SCENARIO}')
os.makedirs(OUT, exist_ok=True)

DARK_BG, DARK_FG = 'rgb:0d0d/0d0d/0d0d', 'rgb:fafa/fafa/fafa'
LIGHT_BG, LIGHT_FG = 'rgb:fafa/fafa/fafa', 'rgb:0a0a/0a0a/0a0a'
ST = '\x1b\\'

# (seconds after start, action) - actions are 'send:<bytes>', 'resize', 'answer:<tone>'
TIMELINE = {
    'dark': [],
    'light': [],
    'none': [],
    'late': [(12, 'answer:dark')],
    'late-light': [(12, 'answer:light')],
    'flip': [(8, 'tone:light'), (8, 'send:\x1b[?997;2n'), (16, 'tone:dark'), (16, 'send:\x1b[?997;1n')],
    'requery': [(8, 'resize'), (12, 'send:\x1b[O'), (14, 'send:\x1b[I')],
    'unanswered-flip': [(12, 'tone:light'), (12, 'send:\x1b[?997;2n')],
    'unsolicited': [(10, 'answer:light')],
    'adopt-together': [(12, 'tone:light'), (12.1, 'send:\x1b[?1;2c\x1b[?997;2n')],
    'adopt': [(12, 'tone:light'), (12.1, 'da1'), (12.4, 'send:\x1b[?997;2n')],
    'adopt-push-first': [(12, 'tone:light'), (12.1, 'send:\x1b[?997;2n'), (12.4, 'da1')],
    'prompt': [(3, 'send:reply with exactly the word ok and nothing else'), (3.5, 'send:\r'),
               (22, 'tone:light'), (22, 'send:\x1b[?997;2n')],
}[SCENARIO]
ANSWER_COLORS = {'dark': (DARK_BG, DARK_FG), 'light': (LIGHT_BG, LIGHT_FG), 'none': None,
                 'late': None, 'late-light': None, 'flip': (DARK_BG, DARK_FG),
                 'requery': (DARK_BG, DARK_FG), 'unanswered-flip': None,
                 'adopt': None, 'adopt-push-first': None, 'adopt-together': None,
                 'unsolicited': (DARK_BG, DARK_FG),
                 'prompt': (DARK_BG, DARK_FG)}[SCENARIO]
TOTAL = 30 if SCENARIO == 'prompt' else 24

real = next(p for p in (os.path.join(d, 'claude') for d in os.environ['PATH'].split(':'))
            if os.access(p, os.X_OK) and 'double0-claude-shim' not in p)
env = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor', TERM_PROGRAM='double0',
           TERM_PROGRAM_VERSION='0.0.0', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT='1')
for k in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'COLORFGBG'):
    env.pop(k, None)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(WORK)
    os.execve(real, [real], env)
ROWS, COLS = 40, 120
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
raw = open(os.path.join(OUT, 'raw.bin'), 'wb')
log = open(os.path.join(OUT, 'events.log'), 'w')
pal = open(os.path.join(OUT, 'palette.log'), 'w')
t0 = time.time()
seen_sgr: set = set()
phase = 'startup'


def note(line):
    line = f'{time.time() - t0:6.2f} {line}'
    log.write(line + '\n'); log.flush(); print(line, flush=True)


def reply(data, why):
    os.write(fd, data.encode()); note(f'REPLY {why}: {data!r}')


# Everything a terminal could be asked, with xterm.js 6's answer where it has one.
QUERIES = [
    (re.compile(r'\x1b\]10;\?(?:\x07|\x1b\\)'), 'osc10-fg-query'),
    (re.compile(r'\x1b\]11;\?(?:\x07|\x1b\\)'), 'osc11-bg-query'),
    (re.compile(r'\x1b\[0?c'), 'da1'),
    (re.compile(r'\x1b\[>0?c'), 'da2'),
    (re.compile(r'\x1b\[>q'), 'xtversion'),
    (re.compile(r'\x1b\[\?(\d+)\$p'), 'decrqm'),
    (re.compile(r'\x1b\[\?u'), 'kitty-kbd-query'),
    (re.compile(r'\x1b\[6n'), 'cpr'),
    (re.compile(r'\x1b\[14t|\x1b\[16t|\x1b\[18t'), 'xtwinops'),
    (re.compile(r'\x1bP\+q[0-9a-fA-F;]*\x1b\\'), 'xtgettcap'),
    (re.compile(r'\x1b_G[^\x1b]*\x1b\\'), 'kitty-graphics'),
    (re.compile(r'\x1b\[\?(2031|2026|1004|2004|1049|1000|1002|1003|1006)([hl])'), 'decset'),
]
pending_osc = []  # unanswered colour queries (for the 'late' scenario)


def answer_osc(code, tone):
    bg, fg = ANSWER_COLORS if tone is None else {'dark': (DARK_BG, DARK_FG), 'light': (LIGHT_BG, LIGHT_FG)}[tone]
    reply(f'\x1b]{code};{bg if code == 11 else fg}{ST}', f'osc{code}')


def handle_queries(text):
    for rx, kind in QUERIES:
        for m in rx.finditer(text):
            note(f'QUERY {kind} {m.group(0)!r}')
            if kind in ('osc10-fg-query', 'osc11-bg-query'):
                code = 10 if kind.startswith('osc10') else 11
                if ANSWER_COLORS is None:
                    pending_osc.append(code)
                else:
                    answer_osc(code, None)
            elif kind == 'da1' and ANSWER_COLORS is not None:
                reply('\x1b[?1;2c', 'da1')
            elif kind == 'da2' and ANSWER_COLORS is not None:
                reply('\x1b[>0;276;0c', 'da2')
            elif kind == 'decrqm':
                reply(f'\x1b[?{m.group(1)};0$y', 'decrqm (not recognised)')


SGR_RX = re.compile(r'\x1b\[([0-9;]*)m')


def record_palette(text):
    for m in SGR_RX.finditer(text):
        parts = m.group(1).split(';')
        i = 0
        while i < len(parts):
            if parts[i] in ('38', '48') and i + 4 < len(parts) and parts[i + 1] == '2':
                key = f'{parts[i]};2;{";".join(parts[i + 2:i + 5])}'
                if (phase, key) not in seen_sgr:
                    seen_sgr.add((phase, key))
                    pal.write(f'{time.time() - t0:6.2f} {phase:10} {key}\n'); pal.flush()
                i += 5
            else:
                i += 1


tail = ''
def pump(until):
    global tail
    while time.time() - t0 < until:
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r:
            continue
        try:
            b = os.read(fd, 65536)
        except OSError:
            return False
        if not b:
            return False
        raw.write(f'\n#### {time.time() - t0:.3f}\n'.encode()); raw.write(b); raw.flush()
        text = tail + b.decode('utf-8', 'replace')
        handle_queries(text[len(tail):] if not tail else text)
        record_palette(text[len(tail):] if not tail else text)
        tail = text[-64:]
    return True


actions = sorted(TIMELINE)
t = 0
alive = True
for at, action in actions + [(TOTAL, 'end')]:
    alive = pump(at)
    if not alive or action == 'end':
        break
    phase = action.replace(':', '-').replace('\x1b', 'ESC')
    if action.startswith('send:'):
        os.write(fd, action[5:].encode()); note(f'SEND {action[5:]!r}')
    elif action == 'resize':
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS - 1, COLS, 0, 0))
        time.sleep(0.1)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
        note('RESIZE rows-1 then back')
    elif action.startswith('answer:'):
        tone = action[7:]
        for code in pending_osc or [11]:
            answer_osc(code, tone)
        reply('\x1b[?1;2c', 'da1 (late)')
        pending_osc.clear()
    elif action == 'da1':
        reply('\x1b[?1;2c', 'da1 (late, as a replay answers it)')
    elif action.startswith('tone:'):
        # The terminal's theme changed: later queries are answered in the new tone.
        ANSWER_COLORS = {'dark': (DARK_BG, DARK_FG), 'light': (LIGHT_BG, LIGHT_FG)}[action[5:]]
        note(f'TONE now {action[5:]}')
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
note('DONE')
raw.close()
# Every user-message bar sequence (both palettes) with the styling that follows
# it: what restyle.ts must key on, and what the message text is painted in.
BAR_RX = re.compile(rb'\x1b\[48;2;(?:55;55;55|70;70;70|240;240;240|252;252;252)m')
with open(os.path.join(OUT, 'bar.log'), 'w') as f:
    data = open(os.path.join(OUT, 'raw.bin'), 'rb').read()
    seen = set()
    for m in BAR_RX.finditer(data):
        ctx = data[m.start():m.start() + 160]
        key = re.sub(rb'[^\x1b\[\]0-9;m]', b'', ctx)[:80]
        if key in seen:
            continue
        seen.add(key)
        f.write(repr(ctx) + '\n')
print(f'\nlogs: {OUT}/events.log palette.log bar.log raw.bin')
