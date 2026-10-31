-- Tests remain in the private archive and retain their delivery history.
ALTER TABLE inbound_messages ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0,1));
