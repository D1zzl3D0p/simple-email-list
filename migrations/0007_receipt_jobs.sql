CREATE TABLE receipt_jobs (
 id TEXT PRIMARY KEY,
 raw_key TEXT NOT NULL UNIQUE,
 destination TEXT NOT NULL,
 envelope_from TEXT NOT NULL,
 raw_size INTEGER NOT NULL CHECK(raw_size>=0 AND raw_size<=1048576),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','complete','held')),
 attempts INTEGER NOT NULL DEFAULT 0,
 holder TEXT,
 lease_until INTEGER,
 notified_at INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 finished_at INTEGER,
 last_error TEXT
);
CREATE INDEX receipt_jobs_recovery ON receipt_jobs(state,notified_at,lease_until);
