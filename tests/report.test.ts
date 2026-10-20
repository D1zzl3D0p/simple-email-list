import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import {
  startRun,
  recordIncident,
  finishRun,
  recoverRuns,
} from "../src/incidents";
import { ensureWeeklyReport } from "../src/report";
import { configure, testEnv, now } from "./helpers";
import { runScheduled } from "../src/delivery";
beforeEach(configure);
test("100 errors group once; separate failed runs same day get separate summaries; success silent", async () => {
  await startRun(testEnv(), "one", "missionary@example.com", "scheduled", now);
  for (let i = 0; i < 100; i++)
    await recordIncident(
      testEnv(),
      {
        runId: "one",
        sourceKey: "failure" + i,
        code: "rejected",
        detail: "Held for review",
      },
      now,
    );
  await finishRun(testEnv(), "one", now);
  await finishRun(testEnv(), "one", now);
  await startRun(testEnv(), "two", "missionary@example.com", "scheduled", now);
  await recordIncident(
    testEnv(),
    { runId: "two", sourceKey: "other", code: "timeout", detail: "Uncertain" },
    now,
  );
  await finishRun(testEnv(), "two", now);
  await startRun(testEnv(), "ok", "missionary@example.com", "email", now);
  await finishRun(testEnv(), "ok", now);
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(2);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM incidents WHERE summary_id='failure:one'",
    ).first("count(*)"),
  ).toBe(100);
});
test("late failures grouped next tick; stale killed run recovered", async () => {
  await startRun(
    testEnv(),
    "killed",
    "missionary@example.com",
    "scheduled",
    new Date(0),
  );
  await recordIncident(
    testEnv(),
    { sourceKey: "late1", code: "Bounce", detail: "late bounce" },
    now,
  );
  await recordIncident(
    testEnv(),
    { sourceKey: "late2", code: "Complaint", detail: "late complaint" },
    now,
  );
  await recoverRuns(testEnv(), now);
  await recoverRuns(testEnv(), now);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM outbox WHERE unique_key LIKE 'failure:%'",
    ).first("count(*)"),
  ).toBe(2);
});
test.each([
  ["2026-10-19T14:59:00Z", 0],
  ["2026-10-19T15:00:00Z", 1],
  ["2026-11-02T15:59:00Z", 0],
  ["2026-11-02T16:00:00Z", 1],
  ["2026-11-05T16:00:00Z", 1],
])("weekly report Monday 09 Denver current week: %s", async (date, count) => {
  await ensureWeeklyReport(testEnv(), new Date(date));
  await ensureWeeklyReport(testEnv(), new Date(date));
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(count);
});
test("summary delivery failure retains same notification and never creates recursive incidents", async () => {
  await startRun(
    testEnv(),
    "failed",
    "missionary@example.com",
    "scheduled",
    now,
  );
  await recordIncident(
    testEnv(),
    {
      runId: "failed",
      sourceKey: "f",
      code: "timeout",
      detail: "Held for review",
    },
    now,
  );
  await finishRun(testEnv(), "failed", now);
  let ms = now.getTime();
  const deps = {
    clock: () => new Date(ms),
    sleep: async (n: number) => {
      ms += n;
    },
    send: async () => ({ kind: "uncertain" as const, reason: "timeout" }),
  };
  await runScheduled(
    testEnv({
      SENDING_ENABLED: "true",
      SES_DAILY_QUOTA: "1000",
      SES_RATE: "10",
    }),
    now,
    deps,
  );
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM incidents WHERE source_key!='f'",
    ).first("count(*)"),
  ).toBe(1); // weekly ordinary output failure earns its own run incident
  expect(
    await env.DB.prepare(
      "SELECT state FROM outbox WHERE id='failure:failed'",
    ).first("state"),
  ).toBe("review_required");
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM incidents WHERE source_key LIKE 'attempt:%' AND detail LIKE '%summary%'",
    ).first("count(*)"),
  ).toBe(0);
});
test("new incidents during summary send stay for next group and watermark is frozen", async () => {
  await recordIncident(
    testEnv(),
    { sourceKey: "late-before", code: "Bounce", detail: "first" },
    now,
  );
  await recoverRuns(testEnv(), now);
  let ms = now.getTime();
  await runScheduled(
    testEnv({
      SENDING_ENABLED: "true",
      SES_DAILY_QUOTA: "1000",
      SES_RATE: "10",
    }),
    now,
    {
      clock: () => new Date(ms),
      sleep: async (n) => {
        ms += n;
      },
      send: async (_e, m) => {
        if (m.deliveryId.startsWith("failure:late:"))
          await recordIncident(
            testEnv(),
            {
              sourceKey: "late-during",
              code: "Complaint",
              detail: "arrived during send",
            },
            now,
          );
        return { kind: "accepted", messageId: "ses" };
      },
    },
  );
  expect(
    await env.DB.prepare(
      "SELECT summary_id FROM incidents WHERE source_key='late-during'",
    ).first("summary_id"),
  ).toBeNull();
  await recoverRuns(testEnv(), now);
  expect(
    await env.DB.prepare(
      "SELECT summary_id FROM incidents WHERE source_key='late-during'",
    ).first("summary_id"),
  ).toBeTruthy();
  expect(
    await env.DB.prepare(
      "SELECT count(DISTINCT summary_id) FROM incidents WHERE source_key LIKE 'late-%'",
    ).first("count(DISTINCT summary_id)"),
  ).toBe(2);
});
test("late grouping across numeric id width does not assign new failures to old summary", async () => {
  await env.DB.prepare(
    "INSERT INTO incidents(id,source_key,code,detail,created_at) VALUES(900,'old','Bounce','old',0)",
  ).run();
  await recoverRuns(testEnv(), now);
  await env.DB.prepare(
    "INSERT INTO incidents(id,source_key,code,detail,created_at) VALUES(1000,'new','Complaint','new',0)",
  ).run();
  await recoverRuns(testEnv(), now);
  expect(
    await env.DB.prepare(
      "SELECT summary_id FROM incidents WHERE id=1000",
    ).first("summary_id"),
  ).toBe("failure:late:1000");
});
