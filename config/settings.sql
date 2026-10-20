-- Reviewed local seed template only. Apply explicitly to the intended isolated database.
-- Google Photos remains unset; newsletters stay paused pending final configuration.
UPDATE settings SET
 missionary='sender@example.com',
 owner='owner@example.com',
 approved_senders='["sender@example.com"]',
 display_name='Mission updates',
 album_url='',
 paused=1,
 version=version+1
WHERE id=1;
