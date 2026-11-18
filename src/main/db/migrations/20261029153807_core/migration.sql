ALTER TABLE "projects" ALTER COLUMN "color" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "color" DROP NOT NULL;--> statement-breakpoint
-- Every color so far was auto-assigned on create (there was no picker), so
-- none was a choice: clear them and let every project follow the accent.
UPDATE "projects" SET "color" = NULL;
