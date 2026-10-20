import {
  env,
  createMessageBatch,
  createExecutionContext,
  getQueueResult,
} from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import worker from "../src/index";
import { configure, mail, rawMail, testEnv } from "./helpers";
import {
  queueReceipt,
  processReceiptJob,
  recoverReceiptJobs,
} from "../src/jobs";
import { authenticateDkim } from "../src/inbound-auth";
import { createPublicKey } from "node:crypto";
import key from "./fixtures/sns-test-key.pem?raw";
import fixtures from "./fixtures/dkim.json";
import type { ReceivedMessage } from "../src/inbound";
import { buildSnapshot } from "../src/report";

const now = new Date("2026-10-19T23:00:00Z");
const rr =
  "v=DKIM1; k=rsa; p=" +
  createPublicKey(key)
    .export({ type: "spki", format: "der" })
    .toString("base64");
const authenticated = {
  clock: () => now,
  authenticate: async (
    message: ReceivedMessage,
    raw: Uint8Array,
    sender: string,
  ) =>
    authenticateDkim(raw, sender, {
      resolver: async () => [[rr]],
      now,
      destination: message.to,
    }),
};
function queuedEnv(messages: unknown[] = []) {
  return testEnv({
    UPDATE_ADDRESS: "update@in.example.com",
    JOBS: {
      send: async (body: unknown) => {
        messages.push(body);
      },
      sendBatch: async (batch: Iterable<{ body: unknown }>) => {
        for (const { body } of batch) messages.push(body);
      },
    } as unknown as ReturnType<typeof testEnv>["JOBS"],
  });
}

beforeEach(configure);
test("scheduled dispatch separates archive backfill from delivery query budgets", async () => {
  const messages: unknown[] = [];
  await worker.scheduled(
    { scheduledTime: now.getTime() } as ScheduledController,
    queuedEnv(messages),
  );
  expect(messages).toEqual([
    { type: "scheduled" },
    { type: "archives" },
    { type: "summaries" },
  ]);
});
test("email intake durably queues raw mail before authentication or any actions", async () => {
  const messages: unknown[] = [];
  const e = testEnv({
    JOBS: {
      send: async (body: unknown) => {
        messages.push(body);
      },
    } as unknown as ReturnType<typeof testEnv>["JOBS"],
  });
  let rejected = "";
  const input = {
    ...mail(rawMail()),
    setReject(reason: string) {
      rejected = reason;
    },
  };
  await worker.email(input, e);
  expect(rejected).toBe("");
  expect(messages).toHaveLength(1);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(0);
  const job = await env.DB.prepare("SELECT * FROM receipt_jobs").first<{
    id: string;
    raw_key: string;
    state: string;
  }>();
  expect(messages[0]).toEqual({ type: "receipt", id: job!.id });
  expect(job?.state).toBe("pending");
  expect(await (await env.ARCHIVE.get(job!.raw_key))!.text()).toBe(rawMail());
});

test("signed queued mail authenticates and duplicate notifications process one operation", async () => {
  const messages: unknown[] = [];
  const e = queuedEnv(messages);
  const id = await queueReceipt(mail(fixtures.valid, e.UPDATE_ADDRESS), e, now);
  await Promise.all([
    processReceiptJob(id, e, authenticated),
    processReceiptJob(id, e, authenticated),
  ]);
  await processReceiptJob(id, e, authenticated);
  expect(
    await env.DB.prepare("SELECT state FROM receipt_jobs WHERE id=?")
      .bind(id)
      .first("state"),
  ).toBe("complete");
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT state FROM inbound_messages").first("state"),
  ).toBe("pending");
  const rawKey = await env.DB.prepare(
    "SELECT raw_key FROM inbound_messages",
  ).first<string>("raw_key");
  expect(await (await env.ARCHIVE.get(rawKey!))!.text()).toBe(fixtures.valid);
  expect(await env.ARCHIVE.get(`receipts/${id}.eml`)).toBeNull();
  expect(messages).toEqual([{ type: "receipt", id }, { type: "scheduled" }]);
});

test("delivery signal failure preserves completed receipt and pending newsletter", async () => {
  const messages: unknown[] = [];
  const e = queuedEnv(messages);
  const id = await queueReceipt(mail(fixtures.valid, e.UPDATE_ADDRESS), e, now);
  e.JOBS.send = async (body: unknown) => {
    messages.push(body);
    throw Error("queue unavailable");
  };
  await processReceiptJob(id, e, authenticated);
  await processReceiptJob(id, e, authenticated);
  expect(messages).toEqual([{ type: "receipt", id }, { type: "scheduled" }]);
  expect(
    await env.DB.prepare("SELECT state,attempts FROM receipt_jobs WHERE id=?")
      .bind(id)
      .first(),
  ).toEqual({ state: "complete", attempts: 1 });
  expect(
    await env.DB.prepare("SELECT state FROM inbound_messages").first("state"),
  ).toBe("pending");
});

test("failed queue notification remains durable and scheduled repair can complete it", async () => {
  const e = queuedEnv();
  e.JOBS = {
    ...e.JOBS,
    send: async () => {
      throw Error("queue unavailable");
    },
  } as typeof e.JOBS;
  const id = await queueReceipt(mail(fixtures.valid, e.UPDATE_ADDRESS), e, now);
  expect(
    await env.DB.prepare("SELECT notified_at FROM receipt_jobs WHERE id=?")
      .bind(id)
      .first("notified_at"),
  ).toBe(0);
  const repaired: unknown[] = [];
  const healthy = queuedEnv(repaired);
  expect(await recoverReceiptJobs(healthy, now)).toBe(1);
  expect(repaired).toEqual([{ type: "receipt", id }]);
  await processReceiptJob(id, healthy, authenticated);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(1);
});
test("object and intent failures reject intake instead of acknowledging lost work", async () => {
  const signals: unknown[] = [];
  const e = queuedEnv(signals);
  const archive = {
    put: async () => {
      throw Error("archive unavailable");
    },
  } as unknown as R2Bucket;
  await expect(
    queueReceipt(
      mail(fixtures.valid, e.UPDATE_ADDRESS),
      { ...e, ARCHIVE: archive },
      now,
    ),
  ).rejects.toThrow("archive unavailable");
  const db = new Proxy(e.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (sql.startsWith("INSERT INTO receipt_jobs"))
            throw Error("intent unavailable");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    queueReceipt(mail(fixtures.valid, e.UPDATE_ADDRESS), { ...e, DB: db }, now),
  ).rejects.toThrow("intent unavailable");
  expect(signals).toEqual([]);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM receipt_jobs").first("n"),
  ).toBe(0);
});

test("notification and repair failures still accept committed work for later recovery", async () => {
  const e = queuedEnv();
  e.JOBS.send = async () => {
    throw Error("queue unavailable");
  };
  const db = new Proxy(e.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (sql.startsWith("UPDATE receipt_jobs SET notified_at=0"))
            throw Error("repair unavailable");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const id = await queueReceipt(
    mail(fixtures.valid, e.UPDATE_ADDRESS),
    { ...e, DB: db },
    now,
  );
  expect(await recoverReceiptJobs(e, new Date(now.getTime() + 900001))).toBe(1);
  await processReceiptJob(id, e, authenticated);
  expect(
    await env.DB.prepare("SELECT state FROM receipt_jobs WHERE id=?")
      .bind(id)
      .first("state"),
  ).toBe("complete");
});

test("crashed exhausted receipts become held atomically without another processing attempt", async () => {
  const e = queuedEnv();
  const id = await queueReceipt(mail(fixtures.valid, e.UPDATE_ADDRESS), e, now);
  await env.DB.prepare(
    "UPDATE receipt_jobs SET state='processing',holder='crashed',attempts=5,lease_until=? WHERE id=?",
  )
    .bind(now.getTime() + 1, id)
    .run();
  await processReceiptJob(id, e, authenticated);
  expect(
    await env.DB.prepare("SELECT state FROM receipt_jobs WHERE id=?")
      .bind(id)
      .first("state"),
  ).toBe("processing");
  await env.DB.prepare("UPDATE receipt_jobs SET lease_until=? WHERE id=?")
    .bind(now.getTime() - 1, id)
    .run();
  expect(await recoverReceiptJobs(e, now)).toBe(1);
  await processReceiptJob(id, e, authenticated);
  await processReceiptJob(id, e, authenticated);
  expect(
    await env.DB.prepare(
      "SELECT state,attempts,holder,lease_until FROM receipt_jobs WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({ state: "held", attempts: 5, holder: null, lease_until: null });
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM incidents WHERE code='receipt_held'",
    ).first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(0);
  expect(await env.ARCHIVE.get(`receipts/${id}.eml`)).not.toBeNull();
});

test("forged queued mail never applies actions and eventually becomes a durable held incident", async () => {
  const messages: unknown[] = [];
  const e = queuedEnv(messages);
  const id = await queueReceipt(
    mail(fixtures.unsigned, e.UPDATE_ADDRESS),
    e,
    now,
  );
  for (let i = 0; i < 4; i++)
    await expect(processReceiptJob(id, e, authenticated)).rejects.toThrow(
      /authentication/,
    );
  await processReceiptJob(id, e, authenticated);
  expect(
    await env.DB.prepare("SELECT state FROM receipt_jobs WHERE id=?")
      .bind(id)
      .first("state"),
  ).toBe("held");
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM command_results").first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM incidents WHERE code='receipt_held'",
    ).first("n"),
  ).toBe(1);
  expect(await env.ARCHIVE.get(`receipts/${id}.eml`)).not.toBeNull();
  const snapshot = await buildSnapshot(e, now);
  expect(snapshot.held).toBe(1);
  expect(snapshot.receipts_pending).toBe(0);
  expect(messages).toEqual([{ type: "receipt", id }]);
});

test("active receipt lease blocks duplicates and an expired lease is recoverable", async () => {
  const e = queuedEnv();
  const id = await queueReceipt(mail(fixtures.valid, e.UPDATE_ADDRESS), e, now);
  await env.DB.prepare(
    "UPDATE receipt_jobs SET state='processing',holder='crashed',lease_until=? WHERE id=?",
  )
    .bind(now.getTime() + 1000, id)
    .run();
  await processReceiptJob(id, e, authenticated);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(0);
  await env.DB.prepare("UPDATE receipt_jobs SET lease_until=? WHERE id=?")
    .bind(now.getTime() - 1, id)
    .run();
  expect(await recoverReceiptJobs(e, now)).toBe(1);
  await processReceiptJob(id, e, authenticated);
  expect(
    await env.DB.prepare("SELECT state FROM receipt_jobs WHERE id=?")
      .bind(id)
      .first("state"),
  ).toBe("complete");
});

test("oversized and mismatched raw streams cannot create accepted receipt intents", async () => {
  const e = queuedEnv();
  await expect(
    queueReceipt({ ...mail("", e.UPDATE_ADDRESS), rawSize: 1048577 }, e, now),
  ).rejects.toThrow(/1 MiB/);
  const input = mail(rawMail(), e.UPDATE_ADDRESS);
  // Drain the failed native stream directly: Miniflare's remote R2 proxy logs
  // client-disconnect errors when an intentionally malformed upload is aborted.
  const archive = {
    put: async (_key: string, stream: ReadableStream) => {
      await new Response(stream).arrayBuffer();
      return null;
    },
  } as unknown as R2Bucket;
  await expect(
    queueReceipt(
      { ...input, rawSize: input.rawSize - 1 },
      { ...e, ARCHIVE: archive },
      now,
    ),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT count(*) n FROM receipt_jobs").first("n"),
  ).toBe(0);
});

test("queue handler explicitly retries transient receipt failures", async () => {
  const e = queuedEnv();
  const id = await queueReceipt(
    mail(fixtures.unsigned, e.UPDATE_ADDRESS),
    e,
    now,
  );
  const batch = createMessageBatch("fixture", [
    {
      id: "notification",
      timestamp: now,
      attempts: 1,
      body: { type: "receipt", id },
    },
  ]);
  await worker.queue(batch, e);
  const result = await getQueueResult(batch, createExecutionContext());
  expect(result.explicitAcks).toEqual([]);
  expect(result.retryMessages).toEqual([{ msgId: "notification" }]);
  expect(
    await env.DB.prepare("SELECT state FROM receipt_jobs WHERE id=?")
      .bind(id)
      .first("state"),
  ).toBe("pending");
});
