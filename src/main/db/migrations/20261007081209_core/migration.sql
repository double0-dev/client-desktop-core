ALTER TABLE "projects" ADD COLUMN "agentBrowser" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "agentBrowserEval" boolean DEFAULT false NOT NULL;