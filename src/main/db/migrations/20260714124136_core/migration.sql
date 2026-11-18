ALTER TABLE "agent_sessions" ADD COLUMN "start_command" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "run_on_new_terminal" boolean DEFAULT true NOT NULL;