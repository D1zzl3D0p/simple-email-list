import { env } from "cloudflare:test";
import { expect, test, beforeEach, vi } from "vitest";
import { runScheduled } from "../src/delivery";
import { configure, testEnv, now } from "./helpers";
import type { SendResult } from "../src/types";
const enabled = () =>
  testEnv({
    SENDING_ENABLED: "true",
    SES_DAILY_QUOTA: "1000",
    SES_RATE: "1000",
  });
async function queue(count = 1) {
  await env.DB.prepare("UPDATE settings SET paused=0").run();
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) SELECT 's'||value,'a'||value||'@example.com','active',1,0,0,'test','v1' FROM json_each(?)",
  )
    .bind(JSON.stringify(Array.from({ length: count }, (_, i) => i)))
    .run();
  await env.DB.prepare(
    "INSERT INTO broadcasts(id,subject,text,album_url,created_at) VALUES('b','Week','Hello','https://photos.google.com',0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,broadcast_id,subscriber_id,generation,state,due_at,created_at) SELECT id,'newsletter',email,'b',id,generation,'pending',0,0 FROM subscribers",
  ).run();
}
function deps(result: SendResult = { kind: "accepted", messageId: "ses" }) {
  let ms = now.getTime();
  const sent: string[] = [];
  return {
    sent,
    clock: () => new Date(ms),
    sleep: async (n: number) => {
      ms += n;
    },
    send: async (_e: unknown, m: { recipient: string }) => {
      sent.push(m.recipient);
      return result;
    },
  };
}
beforeEach(async () => {
  await configure();
  await env.DB.prepare("UPDATE settings SET missionary='' ").run();
});
test("two_ticks_one_claim", async () => {
  await queue();
  const d = deps();
  await Promise.all([
    runScheduled(enabled(), now, d),
    runScheduled(enabled(), now, d),
  ]);
  expect(d.sent).toHaveLength(1);
  expect(
    await env.DB.prepare("SELECT count(*) FROM send_attempts").first(
      "count(*)",
    ),
  ).toBe(1);
});
test("six hundred persist across ticks and seven day outage", async () => {
  await queue(600);
  const d = deps();
  await runScheduled(enabled(), new Date(now.getTime() + 7 * 86400000), {
    ...d,
    clock: () => new Date(now.getTime() + 7 * 86400000),
  });
  expect(d.sent.length).toBeGreaterThan(0);
  expect(d.sent.length).toBeLessThanOrEqual(10);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM outbox WHERE state='pending'",
    ).first("count(*)"),
  ).toBe(600 - d.sent.length);
});
test.each([
  "UPDATE subscribers SET status='unsubscribed'",
  "UPDATE subscribers SET generation=2",
  "INSERT INTO suppressions SELECT email,'complaint',0 FROM subscribers",
])("unsubscribe and generation or suppression rechecked: %s", async (sql) => {
  await queue();
  await env.DB.prepare(sql).run();
  const d = deps();
  await runScheduled(enabled(), now, d);
  expect(d.sent).toHaveLength(0);
});
test("rolling_ses_budget_and_reserve survives restart and 24-hour boundary", async () => {
  await queue(3);
  const d = deps();
  const e = enabled();
  e.SES_DAILY_QUOTA = "2";
  await runScheduled(e, now, d);
  await runScheduled(e, now, d);
  expect(d.sent).toHaveLength(1);
  const later = new Date(now.getTime() + 86400001);
  await runScheduled(e, later, { ...d, clock: () => later });
  expect(d.sent).toHaveLength(2);
});
test("respect_ses_rate", async () => {
  await queue(3);
  const d = deps();
  const times: number[] = [];
  const e = enabled();
  e.SES_RATE = "1";
  await runScheduled(e, now, {
    ...d,
    send: async () => {
      times.push(d.clock().getTime());
      return { kind: "accepted", messageId: "x" };
    },
  });
  expect(times.length).toBeGreaterThan(1);
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
});
test("timeout never blindly retries; expired sending is review required", async () => {
  await queue(2);
  const d = deps({ kind: "uncertain", reason: "timeout" });
  await runScheduled(enabled(), now, d);
  await runScheduled(enabled(), new Date(now.getTime() + 86400000), d);
  expect(d.sent).toHaveLength(2);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM outbox WHERE state='review_required'",
    ).first("count(*)"),
  ).toBe(2);
});
test("crash after reservation never resubmits", async () => {
  await queue();
  await env.DB.prepare("UPDATE outbox SET state='sending',lease_until=1").run();
  const d = deps();
  await runScheduled(enabled(), now, d);
  expect(d.sent).toHaveLength(0);
  expect(await env.DB.prepare("SELECT state FROM outbox").first("state")).toBe(
    "review_required",
  );
});
test("configuration failure pauses ALL SES while newsletter resume cannot clear it", async () => {
  await queue(3);
  const d = deps({
    kind: "configuration_error",
    reason: "identity not verified",
  });
  await runScheduled(enabled(), now, d);
  await env.DB.prepare("UPDATE settings SET paused=0").run();
  await runScheduled(enabled(), now, d);
  expect(d.sent).toHaveLength(1);
  expect(
    await env.DB.prepare("SELECT transport_paused FROM settings").first(
      "transport_paused",
    ),
  ).toBeTruthy();
});
test("per_recipient_update_order blocks newer work behind uncertainty", async () => {
  await queue();
  await env.DB.prepare(
    "INSERT INTO broadcasts(id,inbound_id,subject,text,album_url,created_at) VALUES('b2',NULL,'Second','Hello','',1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,broadcast_id,subscriber_id,generation,state,due_at,created_at) VALUES('second','newsletter','a0@example.com','b2','s0',1,'pending',0,1)",
  ).run();
  const d = deps({ kind: "uncertain", reason: "timeout" });
  await runScheduled(enabled(), now, d);
  await runScheduled(enabled(), now, d);
  expect(d.sent).toHaveLength(1);
});
test("accepted SES followed by D1 failure retains reservation and never resubmits", async () => {
  await queue();
  let fail = true;
  const db = new Proxy(env.DB, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          if (fail && sql.startsWith("UPDATE outbox SET state=?")) {
            fail = false;
            throw Error("result persistence offline");
          }
          return t.prepare(sql);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const d = deps();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      runScheduled({ ...enabled(), DB: db }, now, d),
    ).rejects.toThrow("result persistence offline");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      code: "scheduled_failed",
      runId: expect.stringMatching(/^tick:/),
      stage: "delivery",
      errorName: "Error",
      message: "result persistence offline",
    });
  } finally {
    log.mockRestore();
  }
  const later = new Date(now.getTime() + 3600000);
  await runScheduled(enabled(), later, { ...d, clock: () => later });
  expect(d.sent).toHaveLength(1);
  expect(await env.DB.prepare("SELECT state FROM outbox").first("state")).toBe(
    "review_required",
  );
});
test.each([
  {
    failure: new Error("cleanup offline"),
    diagnostic: "Error: cleanup offline",
  },
  { failure: "cleanup offline", diagnostic: "NonError: cleanup offline" },
  {
    failure: { privateData: "do not serialize" },
    diagnostic: "NonError: Non-Error value thrown",
  },
  {
    failure: new Error("x".repeat(1000)),
    diagnostic: "Error: " + "x".repeat(100),
  },
])(
  "failure email includes processing stage and bounded exception: $diagnostic",
  async ({ failure, diagnostic }) => {
    await configure();
    let fail = true;
    const db = new Proxy(env.DB, {
      get(t, k) {
        if (k === "prepare")
          return (sql: string) => {
            if (fail && sql.startsWith("DELETE FROM rate_counters")) {
              fail = false;
              throw failure;
            }
            return t.prepare(sql);
          };
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const messages: string[] = [];
    const d = deps();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        runScheduled({ ...enabled(), DB: db }, now, {
          ...d,
          send: async (_env, mail) => {
            messages.push(mail.text);
            return { kind: "accepted", messageId: "summary" };
          },
        }),
      ).rejects.toBe(failure);
    } finally {
      log.mockRestore();
    }
    const detail = await env.DB.prepare(
      "SELECT detail FROM incidents WHERE code='scheduled_failed'",
    ).first<string>("detail");
    expect(detail).toContain("Stage: rate_counter_cleanup");
    expect(detail).toContain(diagnostic);
    expect(detail!.length).toBeLessThanOrEqual(500);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(detail);
    expect(messages[0]).not.toContain("do not serialize");
    expect(
      await env.DB.prepare("SELECT text FROM outbox WHERE is_summary=1").first(
        "text",
      ),
    ).toBe(messages[0]);
  },
);
test("600-member send batch stays under 40 D1 statements", async () => {
  await queue(600);
  let n = 0;
  const db = new Proxy(env.DB, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          n++;
          return t.prepare(sql);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  await runScheduled({ ...enabled(), DB: db }, now, deps());
  expect(n).toBeLessThan(40);
});
