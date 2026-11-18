import { describe, expect, it } from 'vitest';
import { LABEL_MAX, clampLabel } from '@renderer/lib/session/label';

const LONG =
  'PROD-1234 Rate limit the webhook endpoint so that clients cannot overload the ingestion service';

describe('clampLabel', () => {
  it('leaves a name that fits alone, apart from trimming', () => {
    expect(clampLabel('  Fix Login Redirect ')).toBe('Fix Login Redirect');
  });

  it('cuts an over-long name down to the label column', () => {
    const label = clampLabel(LONG);
    expect(label).toBe('PROD-1234 Rate limit the webhook endpoint so that clients cannot');
    expect(label.length).toBe(LABEL_MAX);
  });

  it('drops the space a cut can leave dangling at the end', () => {
    expect(clampLabel(`${'a'.repeat(LABEL_MAX - 1)} b`)).toBe('a'.repeat(LABEL_MAX - 1));
  });

  it('reduces a blank name to the empty string (the caller then auto-names)', () => {
    expect(clampLabel('   ')).toBe('');
  });
});
