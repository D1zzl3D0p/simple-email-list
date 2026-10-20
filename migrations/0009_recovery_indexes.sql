-- Completed runs accumulate at 96 per day. Recovery must visit only open work.
CREATE INDEX runs_unfinished ON processing_runs(started_at) WHERE finished_at IS NULL;
-- Completing a run checks for incidents even when all older incidents are resolved.
CREATE INDEX incidents_run ON incidents(run_id);
