import { env, createMessageBatch } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/index";
import { configure, testEnv } from "./helpers";
import type { BackgroundJob } from "../src/jobs";

beforeEach(async () => {
  await configure();
  await env.DB.prepare("UPDATE settings SET paused=0").run();
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,created_at,updated_at,source,consent_version) SELECT 's'||value,'reader'||value||'@example.com','active',0,0,'test','v1' FROM json_each(?)",
  )
    .bind(JSON.stringify(Array.from({ length: 52 }, (_, i) => i)))
    .run();
  await env.DB.prepare(
    "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,received_at,run_id,state) VALUES('first','broadcast','raw/first','first','missionary@example.com','first','First update','Hello',0,'receipt','prepared')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO broadcasts(id,inbound_id,subject,text,album_url,created_at,completion_reported) VALUES('first','first','First update','Hello','',0,0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,broadcast_id,subscriber_id,generation,state,due_at,created_at) SELECT id,'newsletter',email,'first',id,1,'pending',0,0 FROM subscribers",
  ).run();
});
afterEach(() => vi.unstubAllGlobals());

function deliveryQueue(quota = "50000") {
  const pending: BackgroundJob[] = [{ type: "scheduled" }];
  let statements = 0;
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          statements++;
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const e = testEnv({
    DB: db,
    STAGE: "production",
    SENDING_ENABLED: "true",
    SES_DAILY_QUOTA: quota,
    SES_RATE: "1000",
    SES_CONFIGURATION_SET: "fixture",
    JOBS: {
      sendBatch: async (batch: Iterable<{ body: BackgroundJob }>) => {
        for (const { body } of batch) pending.push(body);
      },
    } as unknown as ReturnType<typeof testEnv>["JOBS"],
  });
  return async () => {
    let runs = 0;
    while (pending.length && runs < 80) {
      statements = 0;
      const body = pending.shift()!;
      await worker.queue(
        createMessageBatch("fixture", [
          {
            id: String(runs++),
            timestamp: new Date(),
            attempts: 1,
            body,
          },
        ]),
        e,
      );
      expect(statements).toBeLessThan(40);
    }
    expect(pending).toEqual([]);
  };
}

test("one delivery signal drains all 52 recipients and sends the final summary without another cron tick", async () => {
  const recipients: string[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    const payload = (await request.json()) as {
      Destination: { ToAddresses: string[] };
    };
    recipients.push(
      ...payload.Destination.ToAddresses.filter((address) =>
        address.startsWith("reader"),
      ),
    );
    return Response.json({ MessageId: `ses-${recipients.length}` });
  });
  await deliveryQueue()();
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM outbox WHERE broadcast_id='first' AND state='accepted' AND attempt_count=1",
    ).first("n"),
  ).toBe(52);
  expect(
    await env.DB.prepare(
      "SELECT state FROM outbox WHERE id='broadcast-summary:first'",
    ).first("state"),
  ).toBe("accepted");
  expect(
    await env.DB.prepare(
      "SELECT completion_reported FROM broadcasts WHERE id='first'",
    ).first("completion_reported"),
  ).toBe(1);
  expect(recipients).toHaveLength(52);
  expect(new Set(recipients).size).toBe(52);
  expect(
    await env.DB.prepare(
      "SELECT attempt_count FROM outbox WHERE id='broadcast-summary:first'",
    ).first("attempt_count"),
  ).toBe(1);
});

test.each([
  "UPDATE settings SET paused=1",
  "UPDATE settings SET transport_paused='identity fault'",
  "UPDATE settings SET quota_retry_at=9999999999999",
])("blocked delivery stops without a continuation loop: %s", async (sql) => {
  await env.DB.prepare(sql).run();
  vi.stubGlobal("fetch", async () => {
    throw Error("must not send");
  });
  await deliveryQueue()();
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM send_attempts WHERE kind='newsletter'",
    ).first("n"),
  ).toBe(0);
});

test("the continuation stops at the rolling daily quota", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ MessageId: "ses" }));
  await deliveryQueue("2")();
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM outbox WHERE state='accepted'",
    ).first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM send_attempts").first("n"),
  ).toBe(1);
});

test("uncertain submissions are attempted once while the remaining batch continues", async () => {
  vi.stubGlobal("fetch", async () => {
    throw Error("connection lost");
  });
  await deliveryQueue()();
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM outbox WHERE broadcast_id='first' AND state='review_required' AND attempt_count=1",
    ).first("n"),
  ).toBe(52);
});
