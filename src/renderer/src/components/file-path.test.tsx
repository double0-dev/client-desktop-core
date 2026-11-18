import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FilePath } from '@renderer/components/file-path';

const parts = (el: HTMLElement) => ({
  dir: el.querySelector<HTMLElement>('[data-part="dir"]'),
  name: el.querySelector<HTMLElement>('[data-part="name"]'),
});

describe('FilePath', () => {
  it('renders a muted directory and an emphasised "/name"', () => {
    const { container } = render(<FilePath path="src/auth/session.ts" />);
    const { dir, name } = parts(container);
    expect(dir?.textContent).toBe('src/auth');
    expect(name?.textContent).toBe('/session.ts');
    expect(dir?.className).toContain('text-foreground-muted');
    expect(name?.className).toContain('text-foreground');
    expect(name?.className).toContain('font-semibold');
    // The full path is still one contiguous run of text for copy / a11y.
    expect(container.textContent).toBe('src/auth/session.ts');
  });

  it('lets only the directory shrink first, and both parts truncate', () => {
    const { container } = render(<FilePath path="src/auth/session.ts" />);
    const { dir, name } = parts(container);
    expect(dir?.className).toContain('shrink-[1000]');
    expect(dir?.className).toContain('truncate');
    expect(name?.className).toContain('truncate');
    expect(name?.className).not.toContain('shrink-0');
  });

  it('shows a root-level file as just the name, without a slash', () => {
    const { container } = render(<FilePath path="README.md" />);
    const { dir, name } = parts(container);
    expect(dir).toBeNull();
    expect(name?.textContent).toBe('README.md');
  });

  it('dims both parts one step when muted (deleted files)', () => {
    const { container } = render(<FilePath path="src/auth/legacy-skew.ts" muted />);
    const { dir, name } = parts(container);
    expect(dir?.className).toContain('text-foreground-subtle');
    expect(name?.className).toContain('text-foreground-muted');
  });
});
