# Verification

The current local application suite passes 216 tests across 25 files, TypeScript and the dry-run Worker bundle. Tests use local Workers/D1/R2 and synthetic external-service boundaries. They cover strict DKIM and SNS verification, receipt crash recovery, bounded input/private storage, admin authorization/pagination, subscriber generations, quota reservations, welcome deduplication, management confirmations and final broadcast summaries.

`npm run verify:restore` verifies isolated local SQL export/import including body/page references, durable receipt state and welcome/completion flags. It does not prove a live Time Travel rollback.

Before enabling a deployment:

- Apply all migrations to an isolated target and verify bindings, provider identity, quota/rate and recipient restrictions.
- Validate real signed incoming email and correlated SES/SNS events.
- Measure complete deployed CPU for signup, admin/archive, SMTP entry, cron and separate queue jobs at supported input sizes.
- Test welcome and final-summary delivery using owner-controlled addresses.
- Run a disposable Time Travel recovery drill and reconcile external deliveries before resuming.
- Review storage/daily quotas for your expected sending, signup and admin traffic.

Sending remains disabled in example configuration. No local test or prior private staging result authorizes a new deployment to send.
