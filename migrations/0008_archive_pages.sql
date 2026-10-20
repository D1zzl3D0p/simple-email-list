ALTER TABLE inbound_messages ADD COLUMN archive_key TEXT;
CREATE INDEX inbound_archive_pending ON inbound_messages(received_at,id) WHERE archive_key IS NULL;
