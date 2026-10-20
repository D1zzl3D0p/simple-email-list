# Deployment and operations

## Prepare an isolated staging deployment

The checked-in configurations are templates. They do not provision resources and contain no live account configuration. Keep `SENDING_ENABLED=false` and use `STAGE=staging` with an explicit JSON `STAGING_RECIPIENTS` allowlist while testing.

1. Create a Worker, a D1 database, and a private R2 bucket in your Cloudflare account. Replace the placeholder bindings in a private copy of `wrangler.staging.jsonc`. Keep staging resources separate from production. Update the QR generator argument in `build.command` to the private configuration filename so the generated signup QR uses your own hostname.
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
| `CLOUDFLARE_EXPORT_TOKEN` | Scoped D1 export access for backups |

Set the non-secret `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_DATABASE_ID` values to the account/database matching `DB`. Verify export permissions separately. Rotating the capability secret invalidates existing unsubscribe and undo links.

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

There is a 100-line maximum. Valid lines apply in order; errors are returned together. Successful mutations and newsletters are silent. Requested results return to the authenticated administrator, not arbitrary Reply-To. Reply history and common mobile signatures stop command parsing.

Incoming email requires complete, aligned DKIM from an approved visible sender, covering stable Message-ID, subject, MIME metadata, and receiving address. Authentication-Results assertions do not grant authority. Partial-body signatures and Bcc-only destination input fail authentication.

`mailauth` performs maintained DKIM verification. The version-guarded install/build patch changes its RSA digest argument from `rsa-sha256` to the Workers-supported `sha256` without bypassing verification. Unexpected upstream source fails the build.

## Delivery and recovery

Public signup requires successful server-side Turnstile validation. Leave GET displays confirmation; confirmation/one-click POST removes membership. Undo is scoped to the subscription generation. Provider suppressions remain independent: signup, add, undo, and resume do not clear hard-bounce or complaint suppression.

The D1 outbox retains pending work. SES accepted means submission accepted; delivered means a receiving mail server accepted it. It does not establish inbox placement. Timeout or lost acceptance responses become review-required; reconcile SES/SNS evidence before any manual retry. Exactly-once delivery is not guaranteed.

Inspect the private dashboard or email `status`. Preserve attempt IDs, provider IDs, incidents, and prior state during recovery. Newsletter pause and transport faults are separate; `resume` does not clear a transport fault. Confirmed provider quota exhaustion retains pending work and applies a shared cooldown.

## Backup and restore

Weekly backups use a consistent whole-database D1 SQL export into private R2 and retain eight snapshots. Test the export token against your actual account/database. Retain private raw mail alongside SQL and keep an encrypted copy outside Cloudflare. Linked photo albums are outside backup scope.

```sh
npm run verify:restore
```

This verifies local SQL export/import, not live credentials or remote restoration. For a real restore, disable sending and pause newsletters, import into a new isolated database, preserve the original database and R2 archive, then reconcile attempts since the snapshot against SES/SNS. Restored pending rows may already have been sent after the snapshot. Leave unresolved attempts review-required. Only attach the restored database and resume after reconciliation.
