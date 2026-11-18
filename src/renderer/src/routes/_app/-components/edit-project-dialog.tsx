import { useEffect, useState } from 'react';
import type { ProjectEdits } from '@renderer/lib/project-actions';
import { ProjectFormFields } from '@renderer/routes/_app/-components/project-form-fields';
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
import { type Project } from '@renderer/lib/collections';

/**
 * Edits a project's name, destination, description and color - from the
 * Projects panel's project menu.
 */
export function EditProjectDialog({
  open,
  onOpenChange,
  project,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  onSave: (id: string, edits: ProjectEdits) => void;
}) {
  const [name, setName] = useState(project.name);
  const [path, setPath] = useState(project.path ?? '');
  const [description, setDescription] = useState(project.description ?? '');
  const [color, setColor] = useState(project.color);

  useEffect(() => {
    if (open) {
      setName(project.name);
      setPath(project.path ?? '');
      setDescription(project.description ?? '');
      setColor(project.color);
    }
  }, [open, project.name, project.path, project.description, project.color]);

  const canSubmit = name.trim().length > 0 && path.trim().length > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSave(project.id, {
      name: name.trim(),
      description: description.trim() || null,
      path: path.trim(),
      color,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>
              Update the project name, destination, description and color.
            </DialogDescription>
          </DialogHeader>

          <ProjectFormFields
            idPrefix="edit-project"
            name={name}
            onNameChange={setName}
            path={path}
            onPathChange={setPath}
            description={description}
            onDescriptionChange={setDescription}
            color={color}
            onColorChange={setColor}
          />

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!canSubmit}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
