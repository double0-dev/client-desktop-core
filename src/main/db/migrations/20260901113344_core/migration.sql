ALTER TABLE "projects" ADD COLUMN "worktreeCopyPaths" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "worktreeSetupCommand" text;