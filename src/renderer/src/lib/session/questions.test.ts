import { describe, expect, it } from 'vitest';
import { decodeQuestionPayload } from '@renderer/lib/session/questions';

/** Base64 of a JSON value - what the hook script sends over the question marker. */
function encode(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

/** A realistic PreToolUse hook stdin for Claude's AskUserQuestion. */
function hookPayload(questions: unknown): unknown {
  return {
    session_id: 'abc',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions },
  };
}

describe('decodeQuestionPayload', () => {
  it('extracts the first question and its option labels', () => {
    const payload = encode(
      hookPayload([
        {
          question: 'Which auth method should we use?',
          header: 'Auth',
          options: [{ label: 'OAuth' }, { label: 'API key', description: 'simpler' }],
          multiSelect: false,
        },
      ]),
    );
    expect(decodeQuestionPayload(payload)).toEqual({
      question: 'Which auth method should we use?',
      options: ['OAuth', 'API key'],
    });
  });

  it('tolerates plain-string options', () => {
    const payload = encode(hookPayload([{ question: 'Pick one', options: ['a', 'b'] }]));
    expect(decodeQuestionPayload(payload)).toEqual({ question: 'Pick one', options: ['a', 'b'] });
  });

  it('returns an empty options list when options are absent', () => {
    const payload = encode(hookPayload([{ question: 'Free-form?' }]));
    expect(decodeQuestionPayload(payload)).toEqual({ question: 'Free-form?', options: [] });
  });

  it('survives non-ASCII question text (UTF-8 through base64)', () => {
    const payload = encode(hookPayload([{ question: 'Weiter - ja oder nein? 🚀' }]));
    expect(decodeQuestionPayload(payload)?.question).toBe('Weiter - ja oder nein? 🚀');
  });

  it('is null for a payload that is not valid base64/JSON (e.g. truncated)', () => {
    expect(decodeQuestionPayload('not base64!!')).toBeNull();
    expect(decodeQuestionPayload(btoa('{"tool_input":'))).toBeNull();
  });

  it('is null for JSON without a first question (foreign hook shape)', () => {
    expect(decodeQuestionPayload(encode({ hook_event_name: 'PreToolUse' }))).toBeNull();
    expect(decodeQuestionPayload(encode(hookPayload([])))).toBeNull();
    expect(decodeQuestionPayload(encode(hookPayload([{ question: '' }])))).toBeNull();
  });
});
