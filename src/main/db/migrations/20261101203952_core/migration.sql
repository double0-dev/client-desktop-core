-- Pinning is gone (docs/plan/31-workspace-only.md): projects follow the drag
-- order alone. Bake the order the lists showed (pinned first, then ascending
-- sortOrder, newest first on a tie) into sortOrder and clear every pin - only
-- when a pin exists, so an install that never pinned keeps its numbers.
UPDATE "projects" AS p
SET "sortOrder" = r.rank, "pinned" = false
FROM (
  SELECT "id", row_number() OVER (
    ORDER BY "pinned" DESC, "sortOrder" ASC, "createdAt" DESC
  ) AS rank
  FROM "projects"
) AS r
WHERE p."id" = r."id" AND EXISTS (SELECT 1 FROM "projects" WHERE "pinned");
