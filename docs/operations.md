# Deployment and operations

## Prepare an isolated staging deployment

The checked-in configurations are templates. They do not provision resources and contain no live account configuration. Keep `SENDING_ENABLED=false` and use `STAGE=staging` with an explicit JSON `STAGING_RECIPIENTS` allowlist while testing.

1. Create a Worker, a D1 database, a Queue with a batch-size-one consumer, and a private R2 bucket in your Cloudflare account. Replace the placeholder bindings in a private copy of `wrangler.staging.jsonc`. Keep staging resources separate from production. Update the QR generator argument in `build.command` to the private configuration filename so the generated signup QR uses your own hostname.
2. Choose public signup, admin, inbound, and sending hostnames. Preserve existing mail records; configure Email Routing only for the chosen inbound subdomain. Route the exact update and management addresses to the Worker.
3. Configure Turnstile for the signup hostname. Protect the admin hostname with Cloudflare Access; set `ACCESS_ISSUER` and `ACCESS_AUD`. The Worker independently verifies the JWT and configured administrator identity.
4. Verify your SES sending identity, regional access, quota, and rate. Set `SES_REGION`, `SES_FROM`, `SES_CONFIGURATION_SET`, `SES_DAILY_QUOTA`, and `SES_RATE`. Restrict IAM sending permission to your intended identity and configuration set.
5. Create an SNS topic for SES delivery events and set `SNS_TOPIC_ARN`. Adapt `config/sns-staging-policy.json` to your account and configuration set. Subscribe `https://YOUR_PUBLIC_HOST/events/sns` and verify a real signed confirmation and correlated events. Disable open/click tracking.
6. Install Worker secrets and apply migrations, then set mailbox settings as described below. Complete [verification](verification.md) before enabling delivery.

No claim of fitting entirely within Workers Free is made. Validate CPU limits and provider costs for your workload before launch.

## Secrets and mailbox settings

Store these with `npx wrangler secret put NAME --config wrangler.private.staging.jsonc`:

| Secret | Purpose |
| --- | --- |
| `CAPABILITY_SECRET` | At least 32 random bytes for leave/undo capabilities |
| `TURNSTILE_SECRET` | Server-side signup validation |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Restricted SES signing credentials |

The Worker does not need a Cloudflare API/export credential. Rotating the capability secret invalidates existing unsubscribe and undo links.

Copy `config/settings.sql` to an ignored `config/settings.local.sql` and replace its example mailboxes. The `missionary` setting is the primary administrator, `owner` is recovery admin, and `approved_senders` is the JSON array allowed to broadcast. The owner is not implicitly a broadcaster. Set an optional HTTPS album link and keep newsletters paused initially.

Apply migrations locally first:

```sh
npx wrangler d1 migrations apply DB --local
npm run check
```

Then explicitly select your isolated remote target:

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.private.staging.jsonc
npx wrangler d1 execute DB --remote --config wrangler.private.staging.jsonc --file config/settings.local.sql
npx wrangler deploy --config wrangler.private.staging.jsonc
```

Use your own resource identifiers and secrets. Never commit private configuration, SQL dumps, captured mail, or subscriber lists. Regenerate binding types with `npm run types` after editing the base configuration.

## Managing the list

Send ordinary email to the update address to broadcast its subject and text. Attachments and inline images are discarded from outgoing content; ordinary links remain. Raw signed mail is retained privately. Messages are limited to 1 MiB and CRLF headers to 32 KiB.

Send commands to the management address, one per nonblank unquoted line:

```text
add friend@example.com
remove old@example.com
full
status
pause
resume
help
```

There is a 100-line maximum. Valid lines apply in order; errors are returned together. Successful mutations return one ordered response. New newsletters return one final summary to their authenticated original sender after no recipient is pending, retrying or sending. It counts Amazon-accepted, failed, uncertain and cancelled outcomes without asserting inbox placement; historical broadcasts are exempt. Requested results return to the authenticated administrator, not arbitrary Reply-To. Reply history and common mobile signatures stop command parsing.

Incoming email requires complete, aligned DKIM from an approved visible sender, covering stable Message-ID, subject, MIME metadata, and receiving address. Authentication-Results assertions do not grant authority. Partial-body signatures and Bcc-only destination input fail authentication.

`mailauth` performs maintained DKIM verification. The version-guarded install/build patch changes its RSA digest argument from `rsa-sha256` to the Workers-supported `sha256` without bypassing verification. Unexpected upstream source fails the build.

## Delivery and recovery

Public signup requires successful server-side Turnstile validation and activates immediately without a confirmation click. One welcome per membership generation includes an unsubscribe link. Repeat active submissions do not resend it. Welcomes respect suppression/generation and consume the newsletter allowance, even while newsletters are paused. Failed queue notification does not undo a committed signup; cron recovers durable work. Leave GET displays confirmation; confirmation/one-click POST removes membership. Undo is scoped to the subscription generation. Provider suppressions remain independent: signup, add, undo, and resume do not clear hard-bounce or complaint suppression.

The D1 outbox retains pending work. SES accepted means submission accepted; delivered means a receiving mail server accepted it. It does not establish inbox placement. Timeout or lost acceptance responses become review-required; reconcile SES/SNS evidence before any manual retry. Exactly-once delivery is not guaranteed.

Inspect the private dashboard or email `status`. Preserve attempt IDs, provider IDs, incidents, and prior state during recovery. Newsletter pause and transport faults are separate; `resume` does not clear a transport fault. Confirmed provider quota exhaustion retains pending work and applies a shared cooldown.

## Database recovery

Use [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) for database recovery. It is always enabled on production-backend D1, incurs no additional history/restore charge, and offers minute-level restore points within seven days on Workers Free. The owner accepts up to one day's lost changes; select the latest known-good point. Problems must be detected within the seven-day window. This recovery model stays within Cloudflare and does not provide an independent copy. No scheduled SQL export, snapshot rotation or export credential is required. Existing historical SQL snapshots are preserved.

Time Travel restores D1 only. Preserve R2 `raw/`, `text/`, `pages/` and required pending/held `receipts/` content. Do not introduce automatic object deletion based only on current references: recoverable older database states may reference those objects. Completed receipt processing already deletes provisional receipt objects after preserving canonical mail; rollback can therefore restore receipt rows whose provisional object is gone. Reconcile these explicitly below. Photos album contents remain outside application recovery scope.

`rtk npm run verify:restore` remains a manual portability check using local Wrangler SQL export/import and isolated fixture databases. It checks generations, suppressions, pending attempts, private body/page references and receipt recovery state. It does not test Time Travel. Read-only `rtk npm exec -- wrangler d1 time-travel info DB --config wrangler.staging.jsonc` verifies bookmark retrieval. A real recovery drill must use a disposable staging database; never roll back the active database as a verification shortcut.

Migration 0008 adds an optional private archive-page reference. New receipt queue jobs write the complete escaped subject/body page under `pages/v1/<hash>.html` before inserting its database reference. Admin requests still verify Access and the approved identity before reading private objects; prepared pages stream directly with no-store/nosniff headers. Historical rows retain their existing renderer until a separate `archives` queue job backfills up to 25 pages per scheduled tick. Backfill has its own D1 allowance and never changes mail state or applies commands. Retain referenced page objects with raw/text objects during backup and restoration. A referenced missing page returns 503 visibly; to rebuild a lost derivative after checking canonical content, clear that affected row's archive_key so the next backfill reconstructs it. Do not clear raw or normalized-body references.

For a Time Travel restore:

1. Disable sending (`SENDING_ENABLED=false`) and pause newsletters. Stop all database mutations: suspend cron and queue consumers, disable inbound email routing to this Worker, and put signup/unsubscribe/SNS mutation routes into maintenance. Wait for in-flight handlers to settle and retain provider events for reconciliation. Newsletter pause and the sending flag do not stop receipt processing or commands.
2. Record the current bookmark, target timestamp and exact database with authenticated operator Wrangler tooling. Preserve the current SQL state through a manual export if possible for reconciliation. Time Travel restores **in place**, overwriting newer state and cancelling in-flight queries. Run the documented `d1 time-travel restore` command only after reviewing the target; record its undo bookmark. Never automate rollback.
3. Keep all mutations stopped after rollback. Reconcile submissions since the target against SES/SNS and preserved pre-restore state. Restored pending mail may already have been sent: mark unresolved work `review_required`, including restored sending reservations. Reapply later complaints, hard-bounce suppressions, unsubscribe requests and membership changes from reliable evidence. Keep newsletters paused even if the restored settings were unpaused.
4. Check referenced R2 content. Match restored receipt rows with missing provisional originals to canonical mail and already-applied command/broadcast state before repairing that specific job. Hold ambiguous cases for review; do not blindly replay commands. R2 objects newer than the target remain unchanged. Preserve existing ids, attempt counts and deduplication records when repairing recoverable work. Clear stale leases only after confirming original handlers have stopped.
5. Verify generations, suppressions, commands, broadcasts, pending work and schema compatibility with the deployed Worker. Obtain owner approval before resuming routes, cron, consumers or sending. Database recovery cannot unsend accepted mail.

Manual SQL export/import remains available for migration or an explicitly requested independent copy. Import into a new isolated database first; this is separate from in-place Time Travel and is no longer required for automatic backups.

## Async processing and migrations

Apply all migrations before deploying source changes. Migrations 0006–0008 add private body references, durable receipt jobs and prepared archive pages; 0009 indexes recovery; 0010 adds welcome/completion tracking and exempts historical broadcasts from new summaries. Keep the queue consumer batch size at one. Cron signals delivery, archive and completion jobs every 15 minutes. Email receipt durably stores bounded mail before authentication/processing in the queue; failed authentication never permits actions. Exhausted receipt processing is held for review. Existing sending and recipient restrictions remain in force.
