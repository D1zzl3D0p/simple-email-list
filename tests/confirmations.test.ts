import { env, createMessageBatch } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configure, testEnv, now } from "./helpers";
import { handleJobs } from "../src/jobs";
import { prepareNextMessage } from "../src/mail";

beforeEach(configure);
afterEach(() => vi.unstubAllGlobals());
async function broadcast(states: string[] = []) {
  await env.DB.prepare(
    "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,received_at,run_id) VALUES('b','broadcast','raw','hash','missionary@example.com','fp','Weekly letter','Hello',0,'b')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,created_at,updated_at,source,consent_version) SELECT 's'||key,'reader'||key||'@example.com','active',0,0,'test','v1' FROM json_each(?)",
  )
    .bind(JSON.stringify(states))
    .run();
  await prepareNextMessage(testEnv(), now);
  for (const [index, state] of states.entries())
    await env.DB.prepare("UPDATE outbox SET state=? WHERE subscriber_id=?")
      .bind(state, `s${index}`)
      .run();
}
async function summaryJob() {
  await handleJobs(
    createMessageBatch("test", [
      {
        id: crypto.randomUUID(),
        timestamp: now,
        attempts: 1,
        body: { type: "summaries" },
      },
    ]),
    testEnv(),
  );
}
test("mixed final outcomes create one truthful summary to original sender", async () => {
  await broadcast([
    "accepted",
    "delivered",
    "failed",
    "review_required",
    "cancelled",
  ]);
  await env.DB.prepare(
    "UPDATE settings SET missionary='different@example.com'",
  ).run();
  await Promise.all([summaryJob(), summaryJob()]);
  const summary = await env.DB.prepare(
    "SELECT recipient,text,is_summary FROM outbox WHERE unique_key='broadcast-summary:b'",
  ).first<{ recipient: string; text: string; is_summary: number }>();
  expect(summary?.recipient).toBe("missionary@example.com");
  expect(summary?.text).toContain("Accepted by Amazon: 2");
  expect(summary?.text).toContain("Failed: 1");
  expect(summary?.text).toContain("Uncertain / needs review: 1");
  expect(summary?.text).toContain("Cancelled: 1");
  expect(summary?.is_summary).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM outbox WHERE kind='owner'",
    ).first("n"),
  ).toBe(1);
});
test.each(["pending", "retry_wait", "sending"])(
  "summary waits while a recipient is %s",
  async (state) => {
    await broadcast(["accepted", state]);
    await summaryJob();
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM outbox WHERE kind='owner'",
      ).first("n"),
    ).toBe(0);
    await env.DB.prepare(
      "UPDATE outbox SET state='failed' WHERE subscriber_id='s1'",
    ).run();
    await summaryJob();
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM outbox WHERE kind='owner'",
      ).first("n"),
    ).toBe(1);
  },
);
test("empty audience gets a summary and later events never generate another", async () => {
  await broadcast();
  await summaryJob();
  expect(
    await env.DB.prepare("SELECT text FROM outbox WHERE kind='owner'").first(
      "text",
    ),
  ).toContain("Recipients: 0");
  await summaryJob();
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM outbox WHERE kind='owner'",
    ).first("n"),
  ).toBe(1);
});
test("historical broadcasts do not produce unsolicited retroactive summaries", async () => {
  await env.DB.prepare(
    "INSERT INTO broadcasts(id,subject,text,album_url,created_at) VALUES('old','Old','text','',0)",
  ).run();
  await summaryJob();
  expect(await env.DB.prepare("SELECT count(*) n FROM outbox").first("n")).toBe(
    0,
  );
});
test("summary job sends one final response through the actual SES adapter", async () => {
  await broadcast();
  const fetchSpy = vi.fn(async () =>
    Response.json({ MessageId: "summary-ses" }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  const e = testEnv({
    SENDING_ENABLED: "true",
    STAGE: "production",
    SES_CONFIGURATION_SET: "fixture",
    SES_DAILY_QUOTA: "1000",
    SES_RATE: "1000",
  });
  const batch = () =>
    createMessageBatch("test", [
      {
        id: crypto.randomUUID(),
        timestamp: now,
        attempts: 1,
        body: { type: "summaries" },
      },
    ]);
  await handleJobs(batch(), e);
  await handleJobs(batch(), e);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(
    await env.DB.prepare(
      "SELECT state FROM outbox WHERE unique_key='broadcast-summary:b'",
    ).first("state"),
  ).toBe("accepted");
});
