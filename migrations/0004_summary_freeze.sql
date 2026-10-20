CREATE TRIGGER freeze_summary AFTER INSERT ON send_attempts WHEN (SELECT is_summary FROM outbox WHERE id=NEW.outbox_id)=1 BEGIN
 UPDATE outbox SET text=COALESCE(text, 'Processing summary for '||id||char(10)||COALESCE((SELECT group_concat(detail_line,char(10)) FROM (SELECT code||': '||sum(affected)||' affected — '||min(detail) detail_line FROM incidents WHERE summary_id=NEW.outbox_id GROUP BY code)), 'See the requested management output.')) WHERE id=NEW.outbox_id;
 UPDATE processing_runs SET watermark=(SELECT max(id) FROM incidents WHERE summary_id=NEW.outbox_id) WHERE 'failure:'||id=NEW.outbox_id AND watermark IS NULL;
END;
