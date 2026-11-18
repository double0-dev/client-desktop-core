import { describe, expect, it } from 'vitest';
import { daemonBuildLabel } from './settings-form';

describe('daemonBuildLabel', () => {
  it('shows a release as its version', () => {
    expect(daemonBuildLabel('0.7.6')).toBe('0.7.6');
  });

  it('dates a dev build by the stamp its id carries (base 36 mtime)', () => {
    const built = new Date(2026, 10, 3, 12, 50).getTime();
    const label = daemonBuildLabel(`0.7.6-dev-${built.toString(36)}`);
    expect(label).toMatch(/^0\.7\.6 \(dev build, .+\)$/);
    expect(label).toContain(
      new Date(built).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    );
  });

  it('says only dev build when the build had no stamp', () => {
    expect(daemonBuildLabel('0.7.6-dev-x')).toBe('0.7.6 (dev build)');
  });
});
