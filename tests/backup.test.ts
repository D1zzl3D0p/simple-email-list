import { env } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { backupDatabase } from "../src/backup";
import { testEnv, now } from "./helpers";
afterEach(() => vi.unstubAllGlobals());
test("weekly private backup retention keeps newest eight complete snapshots", async () => {
  for (let i = 1; i <= 9; i++)
    await env.ARCHIVE.put(
      `backups/2026-01-${String(i).padStart(2, "0")}.sql`,
      "old",
    );
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input).startsWith("https://api.cloudflare.com/")
      ? Response.json({
          success: true,
          result: {
            status: "complete",
            at_bookmark: "fixed",
            result: {
              signed_url: "https://exports.r2.cloudflarestorage.com/test.sql",
            },
          },
        })
      : new Response("SELECT 1;"),
  );
  await backupDatabase(
    testEnv({
      CLOUDFLARE_EXPORT_TOKEN: "fixture",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_DATABASE_ID: "d",
    }),
    now,
  );
  const keys = (await env.ARCHIVE.list({ prefix: "backups/" })).objects.map(
    (o) => o.key,
  );
  expect(keys).toHaveLength(8);
  expect(keys).toContain("backups/2026-10-19.sql");
  expect(keys).not.toContain("backups/2026-01-01.sql");
  expect(keys).not.toContain("backups/2026-01-02.sql");
});
test("continually polls one consistent export during the same scheduled run", async () => {
  let phase = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://api.cloudflare.com/")) {
        const body = JSON.parse(String(init?.body));
        if (phase++ === 0) {
          expect(body.current_bookmark).toBeUndefined();
          return Response.json({
            success: true,
            result: { at_bookmark: "fixed-snapshot" },
          });
        }
        expect(body.current_bookmark).toBe("fixed-snapshot");
        return Response.json({
          success: true,
          result: {
            status: "complete",
            at_bookmark: "fixed-snapshot",
            result: {
              signed_url: "https://exports.r2.cloudflarestorage.com/file.sql",
            },
          },
        });
      }
      return new Response(
        "CREATE TABLE restored(value TEXT);\nINSERT INTO restored VALUES('snapshot');",
      );
    },
  );
  const e = testEnv({
    CLOUDFLARE_EXPORT_TOKEN: "fixture",
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_DATABASE_ID: "database",
  });
  await backupDatabase(e, now);
  expect(phase).toBe(2);
  const o = await env.ARCHIVE.get("backups/2026-10-19.sql");
  expect(await o?.text()).toContain("snapshot");
  expect(
    await env.DB.prepare(
      "SELECT state FROM report_runs WHERE key='backup:2026-10-19'",
    ).first("state"),
  ).toBe("complete");
});
test("backup failure is not marked complete", async () => {
  vi.stubGlobal("fetch", async () => new Response("offline", { status: 500 }));
  await expect(
    backupDatabase(
      testEnv({
        CLOUDFLARE_EXPORT_TOKEN: "x",
        CLOUDFLARE_ACCOUNT_ID: "a",
        CLOUDFLARE_DATABASE_ID: "d",
      }),
      now,
    ),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM report_runs WHERE state='complete'",
    ).first("count(*)"),
  ).toBe(0);
});

test("a previous interrupted run starts a fresh export instead of a cancelled bookmark", async () => {
  await env.DB.prepare(
    "INSERT INTO report_runs(key,state,value,created_at) VALUES(?,'pending','stale-bookmark',?)",
  )
    .bind("backup:2026-10-19", now.getTime() - 3600000)
    .run();
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://api.cloudflare.com/")) {
        expect(JSON.parse(String(init?.body)).current_bookmark).toBeUndefined();
        return Response.json({
          success: true,
          result: {
            success: true,
            status: "complete",
            result: {
              signed_url: "https://exports.r2.cloudflarestorage.com/test.sql",
            },
          },
        });
      }
      return new Response("SELECT 1;");
    },
  );
  await backupDatabase(
    testEnv({
      CLOUDFLARE_EXPORT_TOKEN: "x",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_DATABASE_ID: "d",
    }),
    now,
  );
  expect(await env.ARCHIVE.get("backups/2026-10-19.sql")).not.toBeNull();
});
test("unfinished export is bounded and never recorded as a successful backup", async () => {
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    return Response.json({
      success: true,
      result: { success: true, at_bookmark: "snapshot", status: "active" },
    });
  });
  await expect(
    backupDatabase(
      testEnv({
        CLOUDFLARE_EXPORT_TOKEN: "x",
        CLOUDFLARE_ACCOUNT_ID: "a",
        CLOUDFLARE_DATABASE_ID: "d",
      }),
      now,
    ),
  ).rejects.toThrow("Export polling limit exceeded");
  expect(requests).toBe(20);
  expect(await env.ARCHIVE.get("backups/2026-10-19.sql")).toBeNull();
});
