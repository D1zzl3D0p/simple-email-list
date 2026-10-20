ALTER TABLE outbox ADD COLUMN is_welcome INTEGER NOT NULL DEFAULT 0 CHECK(is_welcome IN (0,1));
-- Historical broadcasts are exempt; new fanout explicitly opts into reporting.
ALTER TABLE broadcasts ADD COLUMN completion_reported INTEGER NOT NULL DEFAULT 1 CHECK(completion_reported IN (0,1));
CREATE INDEX broadcasts_completion ON broadcasts(created_at,id) WHERE completion_reported=0;
CREATE INDEX outbox_broadcast_state ON outbox(broadcast_id,state);
