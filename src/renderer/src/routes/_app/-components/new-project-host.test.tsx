import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestNewProject,
  takeNewProjectRequest,
} from '@renderer/lib/projects/new-project-request';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
const createProject = vi.fn<(input: { name: string; ownerId: string }) => string | null>(
  () => 'project-new',
);
vi.mock('@renderer/lib/project-actions', () => ({
  createProject: (input: { name: string; ownerId: string }) => createProject(input),
}));
// The dialog itself has its own test; here only what the host hands it.
vi.mock('@renderer/routes/_app/-components/new-project-dialog', () => ({
  NewProjectDialog: (p: {
    open: boolean;
    initialHostId: string | null;
    onOpenChange: (open: boolean) => void;
    onCreate: (edits: { name: string; description: null; path: string; color: null }) => void;
  }) =>
    p.open ? (
      <div>
        <span data-testid="host">{p.initialHostId ?? 'this computer'}</span>
        <button
          type="button"
          onClick={() =>
            p.onCreate({ name: 'acme', description: null, path: '/Users/emmaw/acme', color: null })
          }
        >
          Create
        </button>
        <button type="button" onClick={() => p.onOpenChange(false)}>
          Cancel
        </button>
      </div>
    ) : null,
}));
import { NewProjectHost } from './new-project-host';

describe('NewProjectHost', () => {
  beforeEach(() => {
    navigate.mockClear();
    createProject.mockClear();
    takeNewProjectRequest();
  });

  it('opens on a request and lands the created project in its session-less workspace', async () => {
    const user = userEvent.setup();
    render(<NewProjectHost ownerId="owner-1" />);
    expect(screen.queryByText('Create')).toBeNull();
    act(() => requestNewProject());
    expect(screen.getByTestId('host')).toHaveTextContent('this computer');
    await user.click(screen.getByText('Create'));
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'acme', ownerId: 'owner-1' }),
    );
    expect(navigate).toHaveBeenCalledWith({
      to: '/workspace/$projectId',
      params: { projectId: 'project-new' },
    });
  });

  it('preselects the host of "Add a project on <host>", and a request made before it mounted waits', async () => {
    const user = userEvent.setup();
    requestNewProject('host-1');
    render(<NewProjectHost ownerId="owner-1" />);
    expect(screen.getByTestId('host')).toHaveTextContent('host-1');
    // A dismissed dialog reopens on the next ask, without the old host.
    await user.click(screen.getByText('Cancel'));
    expect(screen.queryByTestId('host')).toBeNull();
    act(() => requestNewProject());
    expect(screen.getByTestId('host')).toHaveTextContent('this computer');
  });

  it('does not navigate when nothing was created', async () => {
    const user = userEvent.setup();
    createProject.mockReturnValueOnce(null);
    render(<NewProjectHost ownerId="owner-1" />);
    act(() => requestNewProject());
    await user.click(screen.getByText('Create'));
    expect(navigate).not.toHaveBeenCalled();
  });
});
