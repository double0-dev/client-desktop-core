ALTER TABLE "agent_sessions" ADD COLUMN "archivedAt" timestamp with time zone;--> statement-breakpoint
-- Sessions archived before the column existed start their archive clock at
-- their last write - the closest record of when they were put away.
UPDATE "agent_sessions" SET "archivedAt" = "updatedAt" WHERE "status" = 'archived';
