# Runtime feasibility

The application uses Cloudflare Workers, D1, private R2, Email Routing, Turnstile, and Access, with Amazon SES and SNS for outbound delivery and provider events.

Local integration tests and dry-run builds establish local correctness only. Full authenticated email processing has exceeded the intended Workers Free CPU budget in development measurements. Further optimization is being investigated separately. Do not interpret this release as a verified fit within the free allowance.

Check your providers' current limits and pricing before deployment. SES charges are separate from Cloudflare usage. Validate your actual message sizes, recipient count, DKIM workloads, scheduled delivery batches, and backup procedure on an isolated staging deployment. See [verification](verification.md).
