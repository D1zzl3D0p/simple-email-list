import type { Env } from "./types";
import { localWeek } from "./report";
import { stmt } from "./db";
import { boundedBytes } from "./util";
export async function backupDatabase(env: Env, now: Date): Promise<void> {
  if (
    !env.CLOUDFLARE_EXPORT_TOKEN ||
    !env.CLOUDFLARE_ACCOUNT_ID ||
    !env.CLOUDFLARE_DATABASE_ID
  )
    return;
  const week = localWeek(now);
  if (!week.ready) return;
  const key = `backup:${week.key}`;
  const saved = await stmt(
    env.DB,
    "SELECT state,value FROM report_runs WHERE key=?",
    key,
  ).first<{ state: string; value: string | null }>();
  if (saved?.state === "complete") return;
  type ExportResult = {
    success?: boolean;
    at_bookmark?: string;
    status?: string;
    error?: string;
    result?: { signed_url?: string };
  };
  let completed: ExportResult | undefined;
  // Export jobs cancel unless polled continuously. A bookmark from a previous
  // cron invocation can belong to a cancelled job, so each run starts fresh.
  let bookmark: string | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(env.CLOUDFLARE_DATABASE_ID)}/export`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CLOUDFLARE_EXPORT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          output_format: "polling",
          ...(bookmark ? { current_bookmark: bookmark } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok)
      throw Error(`D1 export request failed (HTTP ${response.status})`);
    const data = await response.json<{
      success: boolean;
      result: ExportResult;
    }>();
    if (
      !data.success ||
      data.result.success === false ||
      data.result.status === "error"
    )
      throw Error("Consistent D1 export failed");
    if (data.result.status === "complete") {
      completed = data.result;
      break;
    }
    if (!data.result.at_bookmark) throw Error("Export missing bookmark");
    bookmark = data.result.at_bookmark;
  }
  if (!completed) throw Error("Export polling limit exceeded");
  const url = new URL(completed.result?.signed_url ?? "");
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".r2.cloudflarestorage.com") ||
    url.username ||
    url.password
  )
    throw Error("Untrusted export download URL");
  const download = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (!download.ok) throw Error("Export download failed");
  const bytes = await boundedBytes(download.body, 25 * 1024 * 1024);
  await env.ARCHIVE.put(`backups/${week.key}.sql`, bytes, {
    httpMetadata: { contentType: "application/sql" },
  });
  await stmt(
    env.DB,
    "INSERT INTO report_runs(key,state,value,created_at) VALUES(?,'complete',?,?) ON CONFLICT(key) DO UPDATE SET state='complete',value=excluded.value",
    key,
    completed.at_bookmark ?? null,
    now.getTime(),
  ).run();
  const backups = await env.ARCHIVE.list({ prefix: "backups/" });
  const old = backups.objects
    .map((o) => o.key)
    .sort()
    .reverse()
    .slice(8);
  if (old.length) await env.ARCHIVE.delete(old);
}
