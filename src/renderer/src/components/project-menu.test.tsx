import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectContextMenu } from '@renderer/components/project-menu';

/**
 * `Menu/Project` speaks the session menu's vocabulary exactly: "Open in
 * separate window" for a project in this window, "Bring to this window" for
 * one living in a window of its own - never both, and each wired to its own
 * action. Right-click anchored, like the session rows' menu.
 */

function renderMenu(external: boolean) {
  const actions = {
    onOpenInWindow: vi.fn(),
    onBringToWindow: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };
  render(<ProjectContextMenu anchor={{ x: 10, y: 10 }} external={external} {...actions} />);
  return actions;
}

describe('ProjectContextMenu', () => {
  it('offers to open a project in a separate window, then edit and delete it', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const actions = renderMenu(false);
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent?.trim());
    expect(items).toEqual(['Open in separate window', 'Edit project', 'Delete project']);
    await user.click(screen.getByRole('menuitem', { name: 'Open in separate window' }));
    expect(actions.onOpenInWindow).toHaveBeenCalledTimes(1);
    expect(actions.onBringToWindow).not.toHaveBeenCalled();
  });

  it('offers to bring a project back while it lives in its own window', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const actions = renderMenu(true);
    expect(screen.queryByRole('menuitem', { name: 'Open in separate window' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Bring to this window' }));
    expect(actions.onBringToWindow).toHaveBeenCalledTimes(1);
    expect(actions.onOpenInWindow).not.toHaveBeenCalled();
  });

  it('wires edit and delete', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const actions = renderMenu(false);
    await user.click(screen.getByRole('menuitem', { name: 'Edit project' }));
    expect(actions.onEdit).toHaveBeenCalledTimes(1);
    render(<ProjectContextMenu anchor={{ x: 10, y: 10 }} external={false} {...actions} />);
    await user.click(screen.getAllByRole('menuitem', { name: 'Delete project' })[0]);
    expect(actions.onDelete).toHaveBeenCalledTimes(1);
  });
});
