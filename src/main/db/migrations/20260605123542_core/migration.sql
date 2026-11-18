CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"label" varchar(32) NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"agent" varchar(32) DEFAULT '' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"projectId" uuid,
	"ownerId" uuid DEFAULT '00000000-0000-4000-8000-000000000000' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(256) NOT NULL,
	"description" text,
	"path" text,
	"color" varchar(16) DEFAULT '#6366f1' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"ownerId" uuid DEFAULT '00000000-0000-4000-8000-000000000000' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_sessions_ownerId_updatedAt_idx" ON "agent_sessions" ("ownerId","updatedAt");--> statement-breakpoint
CREATE INDEX "projects_ownerId_createdAt_idx" ON "projects" ("ownerId","createdAt");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_projectId_projects_id_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE;