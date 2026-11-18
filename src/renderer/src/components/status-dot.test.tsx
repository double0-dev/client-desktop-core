import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusDot } from '@renderer/components/status-dot';

/** The live class carries the breathing animation (see globals.css). */
const LIVE = 'status-dot-live';

describe('StatusDot', () => {
  it('stays still by default', () => {
    const { container } = render(<StatusDot className="bg-success" />);
    expect(container.firstChild).not.toHaveClass(LIVE);
  });

  it('breathes when live, keeping its colour and size', () => {
    const { container } = render(<StatusDot live className="size-1.5 shrink-0 bg-success" />);
    expect(container.firstChild).toHaveClass(LIVE, 'bg-success', 'size-1.5', 'shrink-0');
  });

  it('is always round', () => {
    const { container } = render(<StatusDot />);
    expect(container.firstChild).toHaveClass('rounded-full');
  });

  it('forwards arbitrary span props', () => {
    const { container } = render(<StatusDot live aria-label="Running" title="Running" />);
    expect(container.firstChild).toHaveAttribute('aria-label', 'Running');
  });
});
