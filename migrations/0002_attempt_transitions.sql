CREATE TRIGGER reserve_attempt AFTER INSERT ON send_attempts BEGIN
 UPDATE outbox SET state='sending',attempt_id=NEW.id,attempt_count=attempt_count+1,lease_until=NEW.reserved_at+300000 WHERE id=NEW.outbox_id;
END;
CREATE TRIGGER finish_attempt AFTER UPDATE OF state ON outbox WHEN NEW.attempt_id IS NOT NULL AND NEW.state!='sending' BEGIN
 UPDATE send_attempts SET outcome=NEW.state,provider_id=NEW.provider_id WHERE id=NEW.attempt_id;
 INSERT OR IGNORE INTO incidents(run_id,source_key,code,detail,created_at)
 SELECT a.run_id,'attempt:'||a.id,NEW.state,NEW.last_error,a.reserved_at FROM send_attempts a
 WHERE a.id=NEW.attempt_id AND NEW.last_error IS NOT NULL AND NEW.is_summary=0 AND NEW.state IN ('failed','retry_wait','review_required');
END;
