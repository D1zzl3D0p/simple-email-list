# Verification checklist

Tests run in the local Workers runtime with D1/R2 bindings. External Turnstile, SES, and certificate-fetch boundaries use synthetic fixtures; cryptographic checks execute locally. `npm run verify:restore` tests SQL export/import into isolated local databases.

Local tests do not establish deployed CPU limits, production credentials, DNS correctness, remote backup recovery, or actual delivery. Before enabling your own deployment, record evidence for:

- Aligned DKIM from an approved sender, tamper rejection, and signed destination/Message-ID checks.
- Server-side Turnstile hostname/action validation.
- Signed SNS confirmation and event correlation, bounce suppression, and complaint suppression.
- SES identity, production access where required, regional quota/rate, and a controlled-recipient send.
- Worker CPU and other resource limits for HTTP, email, and scheduled workloads at supported input sizes.
- A consistent remote D1 export and restore into a separate database, with private R2 objects retained.
- Access login and anonymous/incorrect-host rejection for admin routes.
- Existing DNS preserved, with routing restricted to the chosen inbound subdomain.

Keep `SENDING_ENABLED=false`, newsletters paused, and staging recipients restricted until these checks pass. This initial public release excludes the concurrent work on Workers Free CPU feasibility.
