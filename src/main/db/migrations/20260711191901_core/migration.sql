ALTER TABLE "projects" ADD COLUMN "sortOrder" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Seed existing rows with -epoch(createdAt) so the lists keep their prior
-- newest-first order (ascending sort, newest = most negative) instead of
-- collapsing every row onto the shared 0 default. New rows are stamped the same
-- way in the dashboard's createProject.
UPDATE "projects" SET "sortOrder" = -EXTRACT(EPOCH FROM "createdAt") * 1000;