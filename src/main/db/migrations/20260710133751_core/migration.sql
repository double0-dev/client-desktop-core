ALTER TABLE "agent_sessions" ADD COLUMN "sortOrder" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Seed existing rows with -epoch(createdAt) so the list keeps its prior
-- newest-first order (ascending sort, newest = most negative) instead of
-- collapsing every row onto the shared 0 default. New rows are stamped the same
-- way in launch-session.ts.
UPDATE "agent_sessions" SET "sortOrder" = -EXTRACT(EPOCH FROM "createdAt") * 1000;