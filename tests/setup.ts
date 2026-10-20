import { env, applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
beforeEach(async () => {
  const objects = await env.ARCHIVE.list();
  if (objects.objects.length)
    await env.ARCHIVE.delete(objects.objects.map((o) => o.key));
  for (const table of [
    "command_results",
    "provider_events",
    "incidents",
    "send_attempts",
    "outbox",
    "broadcasts",
    "inbound_messages",
    "processing_runs",
    "suppressions",
    "subscribers",
    "leases",
    "report_runs",
    "rate_counters",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare(
    "UPDATE settings SET paused=1,transport_paused=NULL,quota_retry_at=NULL,version=0,owner='',missionary='',approved_senders='[]',album_url=''",
  ).run();
});
