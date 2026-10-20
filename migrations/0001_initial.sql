CREATE TABLE settings (
 id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL DEFAULT '', missionary TEXT NOT NULL DEFAULT '',
 approved_senders TEXT NOT NULL DEFAULT '[]', display_name TEXT NOT NULL DEFAULT 'Mission updates',
 album_url TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 1, transport_paused TEXT,
 version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO settings(id) VALUES(1);
CREATE TABLE subscribers (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('active','unsubscribed')),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0), version INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, consent_version TEXT NOT NULL
);
CREATE TABLE suppressions (email TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE inbound_messages (
 id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('broadcast','command')), raw_key TEXT NOT NULL, raw_hash TEXT NOT NULL,
 sender TEXT NOT NULL, message_id TEXT, fingerprint TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL,
 received_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','prepared','held','processed')),
 held_reason TEXT, run_id TEXT NOT NULL, UNIQUE(role,raw_hash)
);
CREATE UNIQUE INDEX inbox_identity ON inbound_messages(role,sender,message_id) WHERE message_id IS NOT NULL AND state!='held';
CREATE INDEX inbox_pending ON inbound_messages(state,received_at);
CREATE TABLE broadcasts (
 id TEXT PRIMARY KEY, inbound_id TEXT UNIQUE REFERENCES inbound_messages(id), subject TEXT NOT NULL,
 text TEXT NOT NULL, album_url TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE processing_runs (
 id TEXT PRIMARY KEY, recipient TEXT NOT NULL, source TEXT NOT NULL, started_at INTEGER NOT NULL,
 finished_at INTEGER, summary_key TEXT UNIQUE, watermark INTEGER
);
CREATE TABLE outbox (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('newsletter','owner')), recipient TEXT NOT NULL,
 broadcast_id TEXT REFERENCES broadcasts(id), subscriber_id TEXT REFERENCES subscribers(id), generation INTEGER,
 subject TEXT, text TEXT, state TEXT NOT NULL CHECK(state IN ('pending','sending','accepted','delivered','retry_wait','review_required','failed','cancelled')),
 due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, unique_key TEXT UNIQUE, is_summary INTEGER NOT NULL DEFAULT 0,
 attempt_count INTEGER NOT NULL DEFAULT 0, attempt_id TEXT, provider_id TEXT, last_error TEXT, lease_until INTEGER,
 UNIQUE(broadcast_id,subscriber_id)
);
CREATE INDEX outbox_due ON outbox(state,due_at,created_at);
CREATE INDEX outbox_member ON outbox(subscriber_id,state,created_at);
CREATE TABLE send_attempts (
 id TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES outbox(id), kind TEXT NOT NULL,
 reserved_at INTEGER NOT NULL, outcome TEXT NOT NULL DEFAULT 'reserved', provider_id TEXT, run_id TEXT NOT NULL
);
CREATE INDEX attempts_budget ON send_attempts(reserved_at,kind);
CREATE INDEX attempts_provider ON send_attempts(provider_id);
CREATE TABLE provider_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, provider_id TEXT, attempt_id TEXT, received_at INTEGER NOT NULL);
CREATE TABLE incidents (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, source_key TEXT NOT NULL UNIQUE,
 code TEXT NOT NULL, detail TEXT NOT NULL, affected INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, summary_id TEXT
);
CREATE INDEX incidents_group ON incidents(summary_id,run_id,id);
CREATE TABLE leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE report_runs (key TEXT PRIMARY KEY, state TEXT NOT NULL, value TEXT, created_at INTEGER NOT NULL);
CREATE TABLE command_results (inbound_id TEXT PRIMARY KEY REFERENCES inbound_messages(id), results TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE rate_counters (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
