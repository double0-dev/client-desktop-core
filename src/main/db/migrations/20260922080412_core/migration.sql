-- Data-only. A turn that ran no edit tool and no command used to persist
-- "Finished - no changes" as the session's detail. It only ever described
-- that one turn, yet read as a claim about the folder - shown under sessions
-- whose earlier turns had left new files in it. The summary is plain
-- "Finished" now (activity-text.ts › finishedLine); rows written before keep
-- the old words until their next turn ends, so rewrite them here.
UPDATE "agent_sessions"
SET "detail" = 'Finished'
WHERE "detail" = 'Finished - no changes';
