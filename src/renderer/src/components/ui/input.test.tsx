import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Input } from '@renderer/components/ui/input';

const user = userEvent.setup();

describe('plain field', () => {
  it('renders a bare input with no shell', () => {
    render(<Input placeholder="Session name" />);
    const input = screen.getByPlaceholderText('Session name');
    expect(input).toHaveAttribute('data-slot', 'input');
    expect(document.querySelector('[data-slot="input-shell"]')).toBeNull();
  });

  it('types and reports changes', async () => {
    const onChange = vi.fn();
    render(<Input onChange={onChange} />);
    await user.type(screen.getByRole('textbox'), 'fix-flaky-tests');
    expect(screen.getByRole('textbox')).toHaveValue('fix-flaky-tests');
    expect(onChange).toHaveBeenCalled();
  });

  it('forwards the type', () => {
    render(<Input type="password" aria-label="Token" />);
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
  });

  it('does not accept input when disabled', async () => {
    render(<Input disabled />);
    const input = screen.getByRole('textbox');
    await user.type(input, 'nope');
    expect(input).toHaveValue('');
  });

  it('merges a caller class', () => {
    render(<Input className="font-mono" />);
    expect(screen.getByRole('textbox')).toHaveClass('font-mono');
  });
});

describe('with adornments', () => {
  it('wraps the field in a shell and renders a start icon', () => {
    render(<Input startIcon={<span data-testid="search-icon" />} />);
    expect(screen.getByTestId('search-icon')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="input-shell"]')).not.toBeNull();
  });

  it('renders an end adornment', () => {
    render(<Input endIcon={<button type="button">Show</button>} />);
    expect(screen.getByRole('button', { name: 'Show' })).toBeInTheDocument();
  });

  it('renders both adornments around the field', () => {
    render(<Input startIcon={<span data-testid="start" />} endIcon={<span data-testid="end" />} />);
    expect(screen.getByTestId('start')).toBeInTheDocument();
    expect(screen.getByTestId('end')).toBeInTheDocument();
  });

  it('still types normally inside the shell', async () => {
    render(<Input startIcon={<span />} placeholder="Search" />);
    await user.type(screen.getByPlaceholderText('Search'), 'git');
    expect(screen.getByPlaceholderText('Search')).toHaveValue('git');
  });

  it('puts the caller class on the field and shellClassName on the shell', () => {
    render(<Input startIcon={<span />} className="font-mono" shellClassName="h-8" />);
    expect(screen.getByRole('textbox')).toHaveClass('font-mono');
    expect(document.querySelector('[data-slot="input-shell"]')).toHaveClass('h-8');
  });
});
