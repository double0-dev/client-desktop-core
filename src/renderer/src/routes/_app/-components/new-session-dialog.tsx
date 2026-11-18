import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Info, Terminal, X } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { SessionRootField } from '@renderer/components/session-root-field';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  BUILTIN_TEMPLATES,
  CUSTOM_AGENT_LABEL,
  DEFAULT_TEMPLATE_ID,
  addUserTemplate,
  builtinAgentForCommand,
  isTemplateDeletable,
  removeTemplate,
  useSessionTemplates,
  type SessionTemplate,
} from '@renderer/lib/session/templates';
import { cn } from '@renderer/lib/utils';
import { placementHook, type PlacementLaunch } from '@renderer/lib/session/placement';
import { runtimeChoiceHook } from '@renderer/lib/session/runtime-choice';
import {
  EMPTY_SETUP,
  describeWorktreePrefill,
  setupCommandOf,
  type WorktreeSetup,
} from '@renderer/lib/worktrees/setup';

const DEFAULT_TEMPLATE =
  BUILTIN_TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID) ?? BUILTIN_TEMPLATES[0];

export type NewSessionLaunch = {
  name: string;
  /** An extension's runtime (lib/session/runtime-choice.ts); null = a terminal session. */
  runtime: string | null;
  /** Command the primary terminal runs (e.g. `claude`); '' = plain shell. */
  startCommand: string;
  /** Display label for the session's `agent` field (template name / 'Custom'). */
  agentLabel: string;
  /** Whether new "+" terminals also auto-run `startCommand`. */
  runOnNewTerminal: boolean;
  /** A terminal session that opens on an extension's view over its agent. Only with `runtime` null. */
  openInView: boolean;
  worktree: boolean;
  setupCommand: string;
  rootPath: string | null;
} & PlacementLaunch;

/** The changes an edit saves - the subset of a session that stays editable. */
export type SessionEdits = {
  name: string;
  startCommand: string;
  agentLabel: string;
  runOnNewTerminal: boolean;
};

/** The existing session an edit seeds from (structural subset of AgentSession). */
export type EditableSession = {
  label: string;
  agent: string;
  startCommand?: string | null;
  runOnNewTerminal?: boolean | null;
  worktreePath?: string | null;
  /** Shown locked while editing - the folder is fixed once the session exists. */
  rootPath?: string | null;
  /** An extension's runtime - fixed once the session exists. */
  runtime?: string | null;
};

/**
 * Launch-a-session dialog (design: `Screen/New Session Dialog`, node `g6pPg`) -
 * doubling as the edit dialog (design: `Screen/Edit Session Dialog`) when
 * `editSession` is given. Pick a template chip (or type a start command), name
 * it, optionally save the command as a reusable template, then `onLaunch`
 * creates the session (or `onSave` applies the changes). Shared by the project
 * screen and the workspace sidebar's "+" so both behave identically.
 *
 * Editing keeps the same fields except the worktree: that's created at launch,
 * so its toggle only displays the state, locked, and the setup command (a
 * one-time creation step) is hidden.
 */
export function NewSessionDialog({
  open,
  onOpenChange,
  onLaunch,
  editSession = null,
  onSave,
  rootPath = null,
  projectPath = null,
  worktreeSetup = null,
  hostId = null,
  projectId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Creates the session on submit; required unless `editSession` is given. */
  onLaunch?: (launch: NewSessionLaunch) => void;
  /** When given, the dialog edits this session instead of creating one. */
  editSession?: EditableSession | null;
  /** Applies the edits on submit; required when `editSession` is given. */
  onSave?: (edits: SessionEdits) => void;
  /** Pre-selected session root ("New session here" on an explorer folder). */
  rootPath?: string | null;
  /** The project's folder - used to display `rootPath` relative to it. */
  projectPath?: string | null;
  /**
   * The project's worktree setup (Settings → Worktrees): its name, what it
   * copies into a new worktree and the setup command it runs. Seeds the setup
   * command field and explains itself under the worktree toggle; null/absent =
   * the project isn't set up.
   */
  worktreeSetup?: { projectName: string; setup: WorktreeSetup } | null;
  /**
   * The machine the project lives on (null = this computer): a session runs on
   * its project's machine unless its placement says otherwise.
   */
  hostId?: string | null;
  /** The project's id - a placement may remember its choices per project. */
  projectId?: string | null;
}) {
  const editing = editSession != null;
  const [launchError, setLaunchError] = useState<string | null>(null);
  const templates = useSessionTemplates();
  const [name, setName] = useState('');
  const [startCommand, setStartCommand] = useState(DEFAULT_TEMPLATE.startCommand);
  const [selectedId, setSelectedId] = useState<string | null>(DEFAULT_TEMPLATE.id);
  const [runOnNewTerminal, setRunOnNewTerminal] = useState(true);
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [setupCommand, setSetupCommand] = useState('');
  const [root, setRoot] = useState<string | null>(null);
  // Where the session runs - this computer unless an extension places it
  // elsewhere, with its own fields for that (lib/session/placement.ts).
  const usePlacement = placementHook();
  const placement = usePlacement({
    open,
    editing,
    projectId,
    projectPath,
    projectHostId: hostId,
    initialRoot: rootPath,
    root,
    setRoot,
    worktree,
    close: () => onOpenChange(false),
  });
  // How the agent runs - a terminal unless an extension offers a runtime of
  // its own, with its own fields for that (lib/session/runtime-choice.ts).
  const useRuntimeChoice = runtimeChoiceHook();
  const choice = useRuntimeChoice({
    open,
    edit: editSession
      ? {
          runtime: editSession.runtime ?? null,
          agent: editSession.agent,
          startCommand: editSession.startCommand ?? '',
        }
      : null,
    machineId: placement.machineId,
    machineLabel: placement.machineLabel,
    runOnNewTerminal,
    onSwitch: (toExtension) => {
      setSaveAsTemplate(false);
      // Each runtime starts from its first preset.
      if (!toExtension) pickTemplate(DEFAULT_TEMPLATE.id, DEFAULT_TEMPLATE.startCommand);
    },
  });
  const extensionRuntime = choice.active;

  // Read through a ref in the reset effect so deleting a template chip mid-edit
  // (which changes `templates`) can't re-run it and wipe the user's input.
  const templatesRef = useRef(templates);
  templatesRef.current = templates;
  // Same reason: the parent rebuilds the setup object on every render.
  const worktreeSetupRef = useRef(worktreeSetup);
  worktreeSetupRef.current = worktreeSetup;

  useEffect(() => {
    if (!open) return;
    if (editSession) {
      const command = editSession.startCommand ?? '';
      setName(editSession.label);
      setStartCommand(command);
      setSelectedId(templatesRef.current.find((t) => t.startCommand === command)?.id ?? null);
      // With no start command the run-on-new-terminal feature is off regardless
      // of the stored flag (a commandless save stores false) - seed true so
      // adding a command starts from the default-on behaviour.
      setRunOnNewTerminal(command ? (editSession.runOnNewTerminal ?? true) : true);
      setSaveAsTemplate(false);
      setTemplateName('');
      setWorktree(editSession.worktreePath != null);
      setSetupCommand('');
      setRoot(null);
    } else {
      setName('');
      setStartCommand(DEFAULT_TEMPLATE.startCommand);
      setSelectedId(DEFAULT_TEMPLATE.id);
      setRunOnNewTerminal(true);
      setSaveAsTemplate(false);
      setTemplateName('');
      setWorktree(false);
      // Prefilled from the project's worktree setup; the user's edit here wins
      // for this launch only (Settings keeps the project's command).
      setSetupCommand(setupCommandOf(worktreeSetupRef.current?.setup ?? EMPTY_SETUP));
      setRoot(rootPath);
      setLaunchError(null);
    }
  }, [open, rootPath, editSession]);

  // Picking a chip fills the command; typing re-highlights the chip whose command
  // now matches (or clears it for a custom command).
  function pickTemplate(id: string, command: string) {
    setSelectedId(id);
    setStartCommand(command);
  }
  function editStartCommand(value: string) {
    setStartCommand(value);
    setSelectedId(templates.find((t) => t.startCommand === value)?.id ?? null);
  }
  function deleteTemplate(t: SessionTemplate) {
    removeTemplate(t);
    setSelectedId((cur) => (cur === t.id ? null : cur));
  }

  const selected = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId],
  );

  // Stored on the session's `agent` field (label + tab icon). Capped to the
  // column width; a command with no matching template reads as the built-in
  // agent it launches (`claude-personal` → Claude Code), else as "Custom".
  const agentLabel = (
    extensionRuntime
      ? choice.agentLabel
      : saveAsTemplate && templateName.trim()
        ? templateName.trim()
        : (selected?.name ??
          builtinAgentForCommand(startCommand) ??
          (startCommand.trim() ? CUSTOM_AGENT_LABEL : 'Terminal'))
  ).slice(0, 32);

  // Creating allows an empty name - the session then auto-names itself from its
  // terminal's title reports (see session/auto-name.ts). Editing still requires
  // one: an existing session always has a label to keep showing.
  // No repository where the session runs: no worktree either.
  const useWorktree = worktree && !placement.noRepo;
  const canSubmit =
    !placement.blocked &&
    (!editing || name.trim().length > 0) &&
    (!saveAsTemplate || templateName.trim().length > 0) &&
    !(extensionRuntime && choice.blocked);

  // "Run on new terminals" only means something once there IS a start command:
  // without one the checkbox is off and inert (a plain shell either way), and a
  // save stores false rather than a dangling true.
  const hasCommand = startCommand.trim().length > 0;
  const effectiveRunOnNewTerminal = extensionRuntime
    ? choice.launch.runOnNewTerminal
    : hasCommand && runOnNewTerminal;

  // What the project's worktree setup does before the agent starts (design:
  // the `toggleSetup` line under the worktree toggle); null = not set up.
  const setupNote = worktreeSetup
    ? describeWorktreePrefill(worktreeSetup.projectName, worktreeSetup.setup)
    : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const command = (extensionRuntime ? choice.startCommand : startCommand).trim();
    if (!extensionRuntime && saveAsTemplate && templateName.trim()) {
      addUserTemplate({ name: templateName.trim(), startCommand: command });
    }
    if (editSession) {
      // Keep the stored agent label unless the command actually changed - a
      // plain rename shouldn't turn e.g. a deleted template's label into
      // "Custom" just because no chip matches its command anymore. A stored
      // "Custom" carries no name worth keeping, so it re-resolves (a session
      // created before `claude-personal` read as Claude Code picks it up).
      const commandChanged = command !== (editSession.startCommand ?? '').trim();
      const relabel = commandChanged || editSession.agent === CUSTOM_AGENT_LABEL;
      onSave?.({
        name: name.trim(),
        startCommand: command,
        agentLabel: relabel ? agentLabel : editSession.agent,
        runOnNewTerminal: effectiveRunOnNewTerminal,
      });
    } else {
      const placed = placement.commit();
      if ('error' in placed) {
        setLaunchError(placed.error);
        return;
      }
      onLaunch?.({
        ...placed.launch,
        name: name.trim(),
        runtime: extensionRuntime ? choice.launch.runtime : null,
        openInView: extensionRuntime && choice.launch.openInView,
        startCommand: command,
        agentLabel,
        runOnNewTerminal: effectiveRunOnNewTerminal,
        worktree: useWorktree,
        setupCommand,
        rootPath: placement.noRepo ? null : root,
      });
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] max-w-[640px] flex-col gap-0 overflow-hidden p-0"
      >
        <form onSubmit={submit} className="contents">
          <div className="flex items-start justify-between gap-4 px-7 pb-2 pt-6">
            <div className="flex flex-col gap-1">
              <DialogTitle className="text-[length:calc(18px*var(--ui-font-scale,1))] tracking-[-0.3px]">
                {editing ? 'Edit session' : 'New agent session'}
              </DialogTitle>
              <DialogDescription className="text-[length:calc(13px*var(--ui-font-scale,1))] leading-relaxed">
                {editing
                  ? 'Rename this session or change how its terminals start. Changes apply to terminals you open from now on.'
                  : 'Each session runs in its own terminal. Add a start command to boot an agent CLI automatically.'}
              </DialogDescription>
            </div>
            <DialogClose className="flex size-7 shrink-0 items-center justify-center rounded text-foreground-muted outline-none transition-colors hover:bg-muted hover:text-foreground">
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </DialogClose>
          </div>

          {/* The middle section scrolls when the window is too short to fit every
              field; the header and footer (Launch/Cancel) stay pinned. */}
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-7 py-3">
            {placement.top}
            {choice.row}

            {extensionRuntime && choice.agentFields}
            <div className="flex flex-col gap-1.5" hidden={extensionRuntime}>
              <Label className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium">
                Template
              </Label>
              <div className="flex flex-wrap gap-2">
                {templates.map((t) => {
                  const isSelected = t.id === selectedId;
                  const tone = isSelected
                    ? 'border-primary bg-accent text-accent-foreground'
                    : 'border-border bg-surface text-foreground hover:border-border-strong';
                  const chipText = 'text-[length:calc(13px*var(--ui-font-scale,1))] font-medium';
                  // Every template carries a delete × except the base Terminal chip.
                  if (!isTemplateDeletable(t)) {
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => pickTemplate(t.id, t.startCommand)}
                        aria-pressed={isSelected}
                        className={cn(
                          'rounded-md border px-2.5 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                          chipText,
                          tone,
                        )}
                      >
                        {t.name}
                      </button>
                    );
                  }
                  return (
                    <span
                      key={t.id}
                      className={cn(
                        'inline-flex items-center rounded-md border py-1.5 pl-2.5 pr-1 transition-colors',
                        chipText,
                        tone,
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => pickTemplate(t.id, t.startCommand)}
                        aria-pressed={isSelected}
                        className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      >
                        {t.name}
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${t.name} template`}
                        title="Delete template"
                        onClick={() => deleteTemplate(t)}
                        className="ml-1 flex size-4 items-center justify-center rounded text-foreground-muted outline-none transition-colors hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/40"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
              <p className="text-xs text-foreground-muted">
                {editing
                  ? 'Pick a template to refill the fields below - nothing is applied until you save.'
                  : 'Pick a starting point - the fields below pre-fill. Tweak anything before launching.'}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label
                  htmlFor="session-name"
                  className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium"
                >
                  Session name
                </Label>
                {!editing && <span className="text-xs text-foreground-subtle">Optional</span>}
              </div>
              <Input
                id="session-name"
                autoFocus
                maxLength={64}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="fix-auth-tokens"
                className="font-mono"
              />
              <p className="text-xs text-foreground-muted">
                {editing && editSession?.worktreePath
                  ? 'Becomes the terminal title. The worktree branch keeps its original name.'
                  : 'What this session will work on. Leave empty to auto-name from your first prompt.'}
              </p>
            </div>

            {/* Always shown, not just when seeded from the explorer: a project
                can be a folder of independent repos, and this is what picks
                which one the session (and its worktree) belongs to. Editing a
                session shows it locked - the worktree already exists. */}
            {projectPath && !placement.noRepo && (
              <SessionRootField
                label="Session root"
                hint={editing ? 'set when the session was created' : 'terminals · agent · worktree'}
                projectPath={projectPath}
                value={editing ? (editSession?.rootPath ?? null) : root}
                onChange={setRoot}
                locked={editing}
              />
            )}

            {extensionRuntime ? (
              choice.commandFields
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label
                    htmlFor="start-command"
                    className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium"
                  >
                    Start command
                  </Label>
                  <span className="text-xs text-foreground-subtle">Optional</span>
                </div>
                <Input
                  id="start-command"
                  value={startCommand}
                  onChange={(e) => editStartCommand(e.target.value)}
                  placeholder="claude"
                  className="font-mono"
                />
                <p className="text-xs leading-relaxed text-foreground-muted">
                  Runs when the terminal opens - e.g. <span className="font-mono">claude</span>.
                  Leave empty for a plain shell.
                </p>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={effectiveRunOnNewTerminal}
                  disabled={!hasCommand}
                  onClick={() => setRunOnNewTerminal((v) => !v)}
                  className={cn(
                    'mt-0.5 flex items-center gap-2 text-left outline-none',
                    !hasCommand && 'opacity-60',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-[18px] shrink-0 items-center justify-center rounded-sm border transition-colors',
                      effectiveRunOnNewTerminal
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border-strong bg-input',
                    )}
                  >
                    {effectiveRunOnNewTerminal && <Check className="size-3" />}
                  </span>
                  <span className="text-[length:calc(13px*var(--ui-font-scale,1))] leading-snug text-foreground">
                    Also run this command each time I open a new terminal with the + button.
                  </span>
                </button>
              </div>
            )}

            {!extensionRuntime && (
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={saveAsTemplate}
                  onClick={() =>
                    setSaveAsTemplate((v) => {
                      const next = !v;
                      if (next && !templateName.trim()) setTemplateName(selected?.name ?? '');
                      return next;
                    })
                  }
                  className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-3.5 py-3 text-left outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground">
                      Save as template
                    </span>
                    <span className="text-xs leading-relaxed text-foreground-muted">
                      Store this start command as a reusable template.
                    </span>
                  </span>
                  <span
                    className={cn(
                      'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                      saveAsTemplate ? 'bg-primary' : 'bg-muted',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 size-4 rounded-full bg-white transition-all',
                        saveAsTemplate ? 'left-[18px]' : 'left-0.5',
                      )}
                    />
                  </span>
                </button>

                {saveAsTemplate && (
                  <div className="flex flex-col gap-1.5">
                    <Label
                      htmlFor="template-name"
                      className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium"
                    >
                      Template name
                    </Label>
                    <Input
                      id="template-name"
                      maxLength={40}
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                      placeholder="Claude Code"
                    />
                    <p className="text-xs text-foreground-muted">
                      Appears as a chip here next time you create a session.
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-3" hidden={placement.noRepo}>
              <button
                type="button"
                role="switch"
                aria-checked={worktree}
                disabled={editing}
                onClick={() => setWorktree((v) => !v)}
                className={cn(
                  'flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-3.5 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                  editing ? 'opacity-60' : 'hover:border-border-strong',
                )}
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium text-foreground">
                    {editing ? 'Git worktree' : 'Create a git worktree'}
                  </span>
                  <span className="text-xs leading-relaxed text-foreground-muted">
                    {editing ? (
                      "Set when the session was created - it can't be changed here."
                    ) : (
                      <>
                        Run this session in an isolated worktree under{' '}
                        <span className="font-mono">.worktree/</span>, on a new lowercase branch
                        named after the session.
                      </>
                    )}
                  </span>
                  {!editing && setupNote && (
                    <span className="text-xs leading-relaxed text-foreground-subtle">
                      {setupNote}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                    worktree ? 'bg-primary' : 'bg-muted',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 size-4 rounded-full bg-white transition-all',
                      worktree ? 'left-[18px]' : 'left-0.5',
                    )}
                  />
                </span>
              </button>

              {placement.worktreeFields}
              {!editing && useWorktree && !placement.ownSetup && (
                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="setup-command"
                    className="text-[length:calc(13px*var(--ui-font-scale,1))] font-medium"
                  >
                    Setup command
                  </Label>
                  <Input
                    id="setup-command"
                    value={setupCommand}
                    onChange={(e) => setSetupCommand(e.target.value)}
                    placeholder="npm i"
                    className="font-mono"
                  />
                  <p className="text-xs text-foreground-muted">
                    {setupNote
                      ? 'Prefilled from the project’s worktree setup - runs once in a new tab after its ignored files are copied in.'
                      : 'Runs once in a new terminal tab when the worktree is created.'}
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border px-7 pb-6 pt-4">
            <div className="flex items-center gap-1.5 text-xs text-foreground-subtle">
              {editing ? (
                <>
                  <Info className="size-3.5" />
                  Changes apply to this session&rsquo;s new terminals
                </>
              ) : (
                (extensionRuntime && choice.footer) || (
                  <>
                    <Terminal className="size-3.5" />
                    Opens in the workspace
                  </>
                )
              )}
              {launchError && (
                <span role="alert" className="text-destructive">
                  {launchError}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!canSubmit} className="gap-2 font-medium">
                {editing ? (
                  <>
                    Save changes
                    <Check className="size-3.5" />
                  </>
                ) : (
                  <>
                    Launch session
                    <ArrowRight className="size-3.5" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
      {placement.dialogs}
    </Dialog>
  );
}
