import { useEffect, useState } from 'react';
import type { ProjectEdits } from '@renderer/lib/project-actions';
import { Info } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { ProjectFormFields } from '@renderer/routes/_app/-components/project-form-fields';
import { useLiveQuery } from '@tanstack/react-db';
import { projectsCollection } from '@renderer/lib/collections';
import { getHost } from '@renderer/lib/hosts/host-directory';
import { SlotBoundary } from '@renderer/components/slot-boundary';
import { rendererExtension } from '@renderer/lib/extension/registry';
import { folderName } from '@renderer/lib/path-within';
import { projectPathConflict } from '../../../../../main/host-of-path';

export function NewProjectDialog({
  open,
  onOpenChange,
  onCreate,
  initialHostId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (edits: ProjectEdits) => void;
  /** The machine preselected for the project (an extension's "add a project there"). */
  initialHostId?: string | null;
}) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  // The name follows the picked folder until the user types one (a local
  // pick and a host pick alike).
  const [nameFromFolder, setNameFromFolder] = useState(true);
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<string | null>(null);
  // Remote sessions (a private plan): the machine the project
  // lives on, and the host's folder picker while it is open.
  // A project on a host is the remote hosts' (Pro, a private plan › M7).
  const hostFields = rendererExtension().hosts?.newProject;
  const [hostId, setHostId] = useState<string | null>(null);
  const [pickingRemote, setPickingRemote] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const { data: projects } = useLiveQuery((q) => q.from({ project: projectsCollection }));

  useEffect(() => {
    if (!open) {
      setName('');
      setNameFromFolder(true);
      setPath('');
      setDescription('');
      setColor(null);
      setHostId(null);
      setPickingRemote(false);
      setConflict(null);
    } else if (initialHostId) {
      setHostId(initialHostId);
    }
  }, [open, initialHostId]);

  const canSubmit = name.trim().length > 0 && path.trim().length > 0;

  function changeHost(next: string | null) {
    if (next === hostId) return;
    // A path is one machine's: switching machines clears it.
    setHostId(next);
    setPath('');
    if (nameFromFolder) setName('');
    setPickingRemote(false);
    setConflict(null);
  }

  function pickPath(picked: string) {
    setPath(picked);
    if (nameFromFolder || !name.trim()) {
      setName(picked ? folderName(picked) : '');
      setNameFromFolder(true);
    }
  }

  function changeName(next: string) {
    setName(next);
    setNameFromFolder(next.trim() === '');
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const why = projectPathConflict(
      path.trim(),
      hostId,
      projects,
      (id) => getHost(id)?.label ?? 'another server',
    );
    if (why) {
      setConflict(why);
      return;
    }
    onCreate({
      name: name.trim(),
      description: description.trim() || null,
      path: path.trim(),
      color,
      ...(hostId ? { hostId } : {}),
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A workspace for agents to talk, coordinate, and ship work together.
            </DialogDescription>
          </DialogHeader>

          {hostFields && (
            <SlotBoundary name="machine-picker">
              <hostFields.MachinePicker value={hostId} onChange={changeHost} />
            </SlotBoundary>
          )}

          <ProjectFormFields
            idPrefix="project"
            name={name}
            onNameChange={changeName}
            path={path}
            onPathChange={pickPath}
            description={description}
            onDescriptionChange={setDescription}
            color={color}
            onColorChange={setColor}
            nameHint="Lowercase, dashes only. This becomes the project ID."
            {...(hostId
              ? {
                  onBrowse: () => setPickingRemote(true),
                  pathPlaceholder: `~/acme on ${getHost(hostId)?.label ?? 'the server'}`,
                  pathHelp: 'A folder on the server - clone the repo there in a terminal first.',
                }
              : {})}
          />
          {hostId && pickingRemote && hostFields && (
            <SlotBoundary name="remote-folder-picker">
              <hostFields.RemoteFolderPicker
                hostId={hostId}
                onCancel={() => setPickingRemote(false)}
                onPick={(picked) => {
                  pickPath(picked);
                  setPickingRemote(false);
                  setConflict(null);
                }}
              />
            </SlotBoundary>
          )}
          {conflict && (
            <p
              role="alert"
              className="text-[length:calc(11px*var(--ui-font-scale,1))] text-destructive"
            >
              {conflict}
            </p>
          )}

          <DialogFooter className="justify-between">
            <div className="flex items-center gap-1.5 text-[length:calc(11px*var(--ui-font-scale,1))] text-foreground-muted">
              <Info className="size-3 text-foreground-subtle" />
              You can edit these later
            </div>
            <div className="flex items-center gap-2">
              <DialogClose asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!canSubmit}>
                Create project
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
