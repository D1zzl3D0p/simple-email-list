# Public test fixtures

`sns-test-key.pem` and `sns-test-cert.pem` are a synthetic key/certificate pair used by local SNS signature tests. The private key is intentionally public, grants no production access, and must never be reused outside tests. Gitleaks permits this exact fixture path.

`dkim.json` contains synthetic messages with example.com addresses and test signatures. `scripts/generate-dkim-fixtures.mjs` regenerates DKIM fixtures. Never replace these files with captured real mail or operational signing keys.
