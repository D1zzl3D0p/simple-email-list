# Deploy through GitHub

The `Deploy` GitHub Actions workflow builds and deploys from GitHub-hosted Linux runners with Node 22 and the lockfile's Wrangler version. Your computer does not need to be running or signed in to Cloudflare.

Once this workflow is merged into `main`, pushes to `main` deploy production after the test suite, type checks, local bundle, restore verification, and target-specific dry-run bundle pass. The existing `Checks` workflow continues to run independently on pull requests and pushes.

Changes limited to documentation or the deployment workflow do not automatically release the application. Test workflow changes with a manual staging run. The GitHub repository is the deployment source; local-only application changes must be reviewed and pushed separately before they can ship.

For a manual deployment, open the repository's **Actions → Deploy → Run workflow**, select branch `main`, and choose `staging` or `production`. Manual deployment from other branches is skipped. Runs for the same target are serialized and an active deployment is never canceled by a newer push.

## One-time setup

1. Create a dedicated Cloudflare API token using the **Edit Cloudflare Workers** template, scoped to your deployment account and zone. Include permissions for the existing D1, R2, and Queues bindings. Use a dedicated token rather than a personal Wrangler OAuth session.
2. Store it in this repository's **Settings → Secrets and variables → Actions** as `CLOUDFLARE_API_TOKEN`. Store the full private staging and production Wrangler JSONC configurations as `WRANGLER_STAGING_CONFIG` and `WRANGLER_PRODUCTION_CONFIG`. The runners restore the selected configuration before bundling and deployment. Keep private configurations out of the public repository.
3. Merge the workflow into `main`. GitHub records deployments under the `production` and `staging` environments. Environment protection rules can be configured in repository settings if approval before deployment is desired.
4. Confirm the first workflow run succeeds and verify the deployed application.

The workflow uses `wrangler.production.jsonc` or `wrangler.staging.jsonc`; it never deploys the local placeholder config. Existing runtime secrets, including SES credentials and Turnstile secrets, stay in Cloudflare. They do not need to be copied to GitHub.

Database migrations remain separate reviewed operations, as required by the operations guide. Apply and verify necessary migrations before merging code that depends on them. The deployment workflow does not create resources or apply migrations.

Only committed changes pushed to GitHub are deployed. Local uncommitted work is not included. For rollback, revert the release commit through GitHub and let the workflow deploy the revert; confirm schema compatibility first because Worker rollback does not undo database changes.

References: [Cloudflare GitHub Actions deployment](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [project operations](operations.md).
