import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from '@renderer/components/ui/checkbox';

const user = userEvent.setup();
/** A disabled control computes `pointer-events: none`, which user-event refuses
 * to click through - this variant asserts the handler stays silent anyway. */
const forceUser = userEvent.setup({ pointerEventsCheck: 0 });

describe('uncontrolled', () => {
  it('starts unchecked and toggles on click', async () => {
    render(<Checkbox />);
    const box = screen.getByRole('checkbox');
    expect(box).toHaveAttribute('aria-checked', 'false');

    await user.click(box);
    expect(box).toHaveAttribute('aria-checked', 'true');

    await user.click(box);
    expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it('honours defaultChecked', async () => {
    render(<Checkbox defaultChecked />);
    const box = screen.getByRole('checkbox');
    expect(box).toHaveAttribute('aria-checked', 'true');
    await user.click(box);
    expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it('reports the NEXT state to onCheckedChange', async () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole('checkbox'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole('checkbox'));
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });
});

describe('controlled', () => {
  it('does not move on its own - the parent owns the state', async () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox checked={false} onCheckedChange={onCheckedChange} />);
    const box = screen.getByRole('checkbox');

    await user.click(box);

    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it('follows the parent when it updates', async () => {
    function Parent() {
      const [checked, setChecked] = useState(false);
      return <Checkbox checked={checked} onCheckedChange={setChecked} />;
    }
    render(<Parent />);
    const box = screen.getByRole('checkbox');
    await user.click(box);
    expect(box).toHaveAttribute('aria-checked', 'true');
  });

  it('treats checked={false} as controlled, not as "no value"', async () => {
    // `checked === undefined` is the uncontrolled signal; an explicit false
    // must not fall back to internal state.
    render(<Checkbox checked={false} />);
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
  });
});

describe('disabled', () => {
  it('does not fire when disabled', async () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox disabled onCheckedChange={onCheckedChange} />);
    await forceUser.click(screen.getByRole('checkbox'));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe('accessibility', () => {
  it('is a real checkbox to assistive tech and to forms', () => {
    render(<Checkbox aria-label="Remove the worktree" />);
    const box = screen.getByRole('checkbox', { name: 'Remove the worktree' });
    // type="button" keeps it from submitting the surrounding form.
    expect(box).toHaveAttribute('type', 'button');
  });

  it('is reachable and toggleable from the keyboard', async () => {
    render(<Checkbox />);
    await user.tab();
    expect(screen.getByRole('checkbox')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  });
});
