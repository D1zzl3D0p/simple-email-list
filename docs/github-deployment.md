# Deploy a private instance

Keep reusable application code in this public repository and live deployment configuration in a separate private instance repository. This public repository runs application checks and does not deploy an instance or store deployment credentials.

## Instance repository

An instance contains a source manifest with the upstream repository name and an exact 40-character commit SHA, private staging and production Wrangler configurations, and a GitHub Actions deployment workflow. Keep the Cloudflare deployment API token in the instance repository Actions secrets. Runtime SES credentials, Turnstile secrets, and capability secrets remain in Cloudflare Worker secrets.

The workflow checks out the pinned upstream source, installs from its lockfile, runs application checks and restore verification, copies the selected instance configuration into that checkout, and bundles and deploys with the pinned Wrangler version. After deployment, verify the health endpoint, signup page, stylesheet, and generated QR image.

Update the upstream commit pin through a reviewed change to upgrade an instance. Upstream changes do not automatically release your deployment. Use staging before production, keep database migrations separate, and check schema compatibility before rolling back a source pin.

Create an independent private repository: forks of public repositories remain public. Never commit credential values, including in a private repository. Version ordinary deployment configuration privately and store credentials using Actions and Worker secrets.

See [deployment and operations](operations.md) for provider setup, migrations, runtime secrets, and launch verification.
