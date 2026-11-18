import { Profiler } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginSessionTurn,
  clearSessionActivity,
  noteToolStart,
} from '@renderer/lib/session/activity';
import { clearSessionQuestion, publishSessionQuestion } from '@renderer/lib/session/questions';
import { SessionRowDetail } from '@renderer/routes/_app/-components/workspace/session-row-detail';

/** base64 of UTF-8 text, the way the hook script builds a payload. */
const b64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const tool = (name: string, arg = ''): string => b64(`${name}\n${arg}`);
const question = (text: string): string =>
  b64(JSON.stringify({ tool_input: { questions: [{ question: text, options: [] }] } }));

const S = 'session-row-1';
const OTHER = 'session-row-2';

afterEach(() => {
  cleanup();
  for (const id of [S, OTHER]) {
    clearSessionActivity(id);
    clearSessionQuestion(id);
  }
});

type Props = Parameters<typeof SessionRowDetail>[0];
const props = (over: Partial<Props> = {}): Props => ({
  sessionId: S,
  status: 'active',
  detail: '',
  updatedAtMs: Date.now(),
  added: null,
  removed: null,
  rootLabel: null,
  rootPath: null,
  ...over,
});

describe('SessionRowDetail', () => {
  it('shows the tool the agent is on and follows the activity store live', () => {
    render(<SessionRowDetail {...props()} />);
    act(() => {
      beginSessionTurn(S);
      noteToolStart(S, tool('Edit', 'src/a.ts'));
    });
    expect(screen.getByText('Editing a.ts')).toBeTruthy();
    act(() => noteToolStart(S, tool('Read', 'src/b.ts')));
    expect(screen.queryByText('Editing a.ts')).toBeNull();
    expect(screen.getByText('Reading b.ts')).toBeTruthy();
  });

  it('shows the pending question while the session waits on the user', () => {
    render(<SessionRowDetail {...props({ status: 'needs-input' })} />);
    act(() => publishSessionQuestion(S, question('Which auth strategy?')));
    expect(screen.getByText('Which auth strategy?')).toBeTruthy();
  });

  it('falls back to the persisted summary when nothing is live', () => {
    render(
      <SessionRowDetail {...props({ status: 'idle', detail: 'Finished - 2 files edited' })} />,
    );
    expect(screen.getByText('Finished - 2 files edited')).toBeTruthy();
  });

  // The chip has its own line now: hiding it during a turn would make the
  // row jump in height every time the agent starts or stops.
  it('keeps the folder chip through a live line and shows the diff stats', () => {
    const idle = props({ status: 'idle', rootLabel: 'packages/web', added: 12, removed: 3 });
    const { rerender } = render(<SessionRowDetail {...idle} />);
    expect(screen.getByText('+12')).toBeTruthy();
    expect(screen.getByText('-3')).toBeTruthy();
    expect(screen.getByText('packages/web')).toBeTruthy();
    // An active session always has a live line ("Working…" at the least).
    rerender(<SessionRowDetail {...idle} status="active" />);
    expect(screen.getByText('Working…')).toBeTruthy();
    expect(screen.getByText('packages/web')).toBeTruthy();
  });

  // The point of the component: another session's agent working must not
  // re-render this row (it used to re-render every mounted session's chrome).
  it("does not re-render for another session's tool calls", () => {
    let renders = 0;
    render(
      <Profiler id="row" onRender={() => renders++}>
        <SessionRowDetail {...props()} />
      </Profiler>,
    );
    const before = renders;
    act(() => {
      beginSessionTurn(OTHER);
      noteToolStart(OTHER, tool('Edit', 'x.ts'));
      publishSessionQuestion(OTHER, question('Proceed?'));
    });
    expect(renders).toBe(before);
    act(() => noteToolStart(S, tool('Edit', 'y.ts')));
    expect(renders).toBeGreaterThan(before);
  });
});
