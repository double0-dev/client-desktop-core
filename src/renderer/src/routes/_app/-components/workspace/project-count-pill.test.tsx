import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectCountPill } from '@renderer/routes/_app/-components/workspace/project-count-pill';

/**
 * The Projects panel's per-row session count. Pins the "nothing ⇒ no pill"
 * rule shared with the rail bubbles: a quiet project ends in its name, not in
 * a placeholder dash.
 */
describe('ProjectCountPill', () => {
  it('shows how many live sessions the project has', () => {
    render(<ProjectCountPill count={3} />);
    expect(screen.getByRole('status')).toHaveTextContent('3');
    expect(screen.getByRole('status')).toHaveAccessibleName('3 sessions');
  });

  it('uses the singular for one session', () => {
    render(<ProjectCountPill count={1} />);
    expect(screen.getByRole('status')).toHaveAccessibleName('1 session');
  });

  it('renders nothing at all for a project with no live sessions', () => {
    const { container } = render(<ProjectCountPill count={0} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
