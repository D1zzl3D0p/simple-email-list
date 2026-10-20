# Simple Email List

A small, self-hosted email list that you manage by sending email. Originally built for sharing mission updates with friends and family, it also fits a personal newsletter or another small, private community.

Subscribers join through a simple web form. An approved sender emails the update address to broadcast an update, or emails the management address to add and remove subscribers, pause delivery, or request status. Subscribers do not need accounts.

## What it does

- Web signup with Cloudflare Turnstile, personal unsubscribe links, and scoped undo links.
- Email management commands: `add`, `remove`, `full`, `status`, `pause`, `resume`, and `help`.
- DKIM verification of approved senders before processing incoming updates or commands.
- A durable D1 outbox with paced, single-recipient Amazon SES delivery and signed SNS event handling for delivery, bounces, and complaints.
- Private R2 archives, a Cloudflare Access-protected dashboard, and database backup/restore tooling.
- Text and ordinary links in updates; attachments and inline images are discarded from outgoing messages.

## Status and costs

This is an early release. Sending is disabled and newsletters start paused. Production deployment needs your own provider setup and validation; the project is not ready to send immediately after cloning.

**Running entirely within Cloudflare Workers Free has not been verified.** CPU optimization is in progress separately and is not included in this initial release. Amazon SES is a separate service with its own charges; do not assume this application is free to operate. See [deployment and operations](docs/operations.md) and the [verification checklist](docs/verification.md).

## Local development

Requirements: Node.js 22 or newer and npm. No global Wrangler installation is required.

```sh
git clone https://github.com/D1zzl3D0p/simple-email-list.git
cd simple-email-list
npm ci --legacy-peer-deps
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npm run dev
```

Set a random `CAPABILITY_SECRET` in `.dev.vars` before exercising signed links. For local signup, configure a Turnstile site key and matching secret and hostname. The default configuration uses placeholder resources and keeps sending disabled. The automated tests use synthetic data and mock external service boundaries.

```sh
npm run check           # Workers/D1/R2 integration tests, TypeScript, dry-run bundle
npm run verify:restore  # SQL export/import into isolated local databases
```

The install script applies a version-checked compatibility patch to `mailauth` so its RSA digest argument works in Workers. It fails if the pinned source changes unexpectedly. See [operations](docs/operations.md).

## Configure your own deployment

Use `wrangler.jsonc` for local development and `wrangler.staging.jsonc` as a staging template. Every address, account ID, database ID, and hostname in the examples must be replaced with your own values. Keep local overrides in an ignored `wrangler.private*.jsonc` file and mailbox settings in an ignored `config/*.local.sql` file.

You will need Cloudflare Workers, Email Routing, D1, private R2, Turnstile, and Access, plus Amazon SES and an SNS event topic. Store credentials as Worker secrets, never in source. Complete the [deployment procedure](docs/operations.md) before enabling delivery.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/` | Worker entry points, inbound verification, list management, delivery, and recovery |
| `public/` | Signup assets; QR SVG is generated during builds |
| `migrations/` | Ordered D1 schema migrations |
| `config/` | Example mailbox settings and SNS policy |
| `tests/` | Local Workers integration tests and synthetic fixtures |
| `scripts/` | Build preparation, fixture generation, and restore verification |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and [SECURITY.md](SECURITY.md) for private reporting and secret handling. The signing key in `tests/fixtures/sns-test-key.pem` is deliberately public and test-only. Never reuse it in a deployed system.

Licensed under [MIT](LICENSE). Third-party dependencies retain their own licenses. `private: true` in `package.json` prevents accidental npm publication; the source is open for reuse under MIT.
