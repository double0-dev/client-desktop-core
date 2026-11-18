import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@renderer/components/ui/button';

const user = userEvent.setup();
/** A disabled button computes `pointer-events: none`, which user-event refuses
 * to click through - this variant asserts the handler stays silent anyway. */
const forceUser = userEvent.setup({ pointerEventsCheck: 0 });

describe('rendering', () => {
  it('renders a real button by default', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('data-slot', 'button');
  });

  it('applies the default variant and size when none are given', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button')).toHaveClass('bg-primary', 'h-9');
  });

  it('applies the destructive variant', () => {
    render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole('button')).toHaveClass('bg-destructive');
  });

  it('applies a size', () => {
    render(<Button size="sm">Save</Button>);
    expect(screen.getByRole('button')).toHaveClass('h-8');
  });

  it('merges a caller class without dropping the variant classes', () => {
    render(<Button className="w-full">Save</Button>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('w-full');
    expect(button).toHaveClass('bg-primary');
  });

  it('lets a caller class win a conflict (tailwind-merge)', () => {
    render(
      <Button size="sm" className="h-12">
        Save
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button).toHaveClass('h-12');
    expect(button).not.toHaveClass('h-8');
  });
});

describe('asChild', () => {
  it('renders the child element instead of a button, keeping the styling', () => {
    render(
      <Button asChild variant="link">
        <a href="https://example.com">Docs</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Docs' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveClass('text-primary');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('behaviour', () => {
  it('calls onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not call onClick when disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    await forceUser.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards arbitrary button props', () => {
    render(
      <Button type="submit" aria-label="Save the session">
        Save
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Save the session' })).toHaveAttribute(
      'type',
      'submit',
    );
  });

  it('is keyboard operable', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
