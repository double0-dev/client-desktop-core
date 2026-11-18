CREATE TABLE "session_layouts" (
	"sessionId" uuid PRIMARY KEY,
	"layout" jsonb NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_layouts" ADD CONSTRAINT "session_layouts_sessionId_agent_sessions_id_fkey" FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;