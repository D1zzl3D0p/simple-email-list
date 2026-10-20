# Security

This project is an early release. Security fixes target the default branch.

## Reporting vulnerabilities

Use the repository's **Security → Report a vulnerability** option for a private GitHub report. Do not disclose credentials, captured mail, subscriber data, or a working exploit against a live deployment in a public issue. If private reporting is unavailable, open an issue asking the maintainer to enable a private reporting channel without including vulnerability details.

## Credentials and private data

Store deployed credentials in Worker secrets. Keep local credentials in ignored `.dev.vars` or `.env` files. Keep private configuration, captured email, exported databases, logs, and profiling outputs outside tracked files. Example hostnames and identifiers are placeholders.

The SNS private key in `tests/fixtures/sns-test-key.pem` is an intentionally public test fixture, paired with the test certificate. It has no production authority and must never be reused. DKIM fixtures contain synthetic mail.

Gitleaks runs in CI and can be run locally with `gitleaks dir --redact .` and `gitleaks git --redact .`. Scanning reduces risk but cannot prove that every kind of secret is absent. Review the staged diff before every commit.

If a real secret is committed, revoke or rotate it immediately and review provider activity. Removing the current file does not remove the secret from Git history. Coordinate any history cleanup with collaborators.

## Deployment boundaries

Keep R2 private and protect the admin hostname with Access. Keep sending disabled until inbound DKIM, SNS signatures, staging recipient restrictions, provider configuration, runtime limits, and recovery have been verified. Never clear provider suppression or blindly retry an uncertain send to make a test pass.
