# Contributing

Issues and pull requests are welcome. Explain the problem and expected behavior, and include regression coverage for behavior changes.

Use Node.js 22 or newer, install with `npm ci --legacy-peer-deps`, then run:

```sh
npm run check
npm run verify:restore
```

Keep changes focused. Preserve inbound authentication, recipient suppression, unsubscribe generations, and uncertain-send recovery. A timeout after an SES submission must not trigger a blind resend. Keep sending disabled in example configurations.

Do not include real messages, subscriber data, logs, credentials, or personal deployment identifiers in issues, fixtures, or pull requests. Use `example.com` addresses and synthetic messages. Run Gitleaks before committing:

```sh
gitleaks dir --redact .
gitleaks git --redact .
```

The Gitleaks configuration allows only the fixed synthetic capability secret and the intentionally public SNS test key. Do not expand these exceptions to hide real credentials.

Changes are contributed under the repository's MIT license. Do not commit generated bundles, local databases, dependency folders, or private configuration.
