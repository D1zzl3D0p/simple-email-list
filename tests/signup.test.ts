import { env } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { handleSignup } from "../src/signup";
import { runScheduled } from "../src/delivery";
import type { OutgoingMail } from "../src/types";
import { testEnv, now } from "./helpers";
afterEach(() => vi.unstubAllGlobals());
const request = (email = "friend@example.com", token = "good", website = "") =>
  new Request(env.PUBLIC_URL + "/subscribe", {
    method: "POST",
    body: new URLSearchParams({
      email,
      "cf-turnstile-response": token,
      website,
    }),
  });
function challenge(
  data: object = {
    success: true,
    hostname: "mission.example.com",
    action: "subscribe",
  },
) {
  vi.stubGlobal("fetch", async () => Response.json(data));
}
test("valid immediate activation queues one welcome and repeat signup does not resend", async () => {
  challenge();
  expect((await handleSignup(request(), testEnv(), now)).status).toBe(200);
  expect(
    await env.DB.prepare("SELECT status FROM subscribers").first("status"),
  ).toBe("active");
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(1);
  await handleSignup(request(), testEnv(), now);
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT recipient FROM outbox").first("recipient"),
  ).toBe("friend@example.com");
});
test.each([
  "bad",
  "a@",
  "a b@example.com",
  "a@example",
  "a..b@example.com",
  "a@example.com\r\nBcc:x@y.com",
])("reject malformed %s", async (email) => {
  challenge();
  expect((await handleSignup(request(email), testEnv(), now)).status).toBe(400);
});
test.each([
  { success: false, "error-codes": ["timeout-or-duplicate"] },
  { success: true, hostname: "evil.example", action: "subscribe" },
  { success: true, hostname: "mission.example.com", action: "login" },
])("invalid expired reused wrong-host/action token rejected", async (data) => {
  challenge(data);
  const r = await handleSignup(request(), testEnv(), now);
  expect(r.status).toBe(400);
  expect(await r.text()).toContain("friend@example.com");
  expect(
    await env.DB.prepare("SELECT count(*) FROM subscribers").first("count(*)"),
  ).toBe(0);
});
test("missing challenge, honeypot and oversized requests rejected", async () => {
  challenge();
  for (const r of [
    request("a@example.com", ""),
    request("a@example.com", "good", "bot"),
    request("a".repeat(9000)),
  ])
    expect((await handleSignup(r, testEnv(), now)).status).toBe(400);
});
test("validation outage returns retry error", async () => {
  vi.stubGlobal("fetch", async () => {
    throw Error("offline");
  });
  const r = await handleSignup(request(), testEnv(), now);
  expect(r.status).toBe(503);
  expect(await r.text()).toMatch(/retry/i);
});
test("D1 failure never reports successful signup", async () => {
  challenge();
  const db = new Proxy(env.DB, {
    get(t, k) {
      if (k === "batch")
        return async () => {
          throw Error("offline");
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  expect((await handleSignup(request(), testEnv({ DB: db }), now)).status).toBe(
    503,
  );
});
test("six hundred valid signups on one shared network succeed", async () => {
  challenge();
  for (let i = 0; i < 600; i++) {
    const r = request(`a${i}@example.com`, `token${i}`);
    r.headers.set("cf-connecting-ip", "192.0.2.1");
    expect((await handleSignup(r, testEnv(), now)).status).toBe(200);
  }
  expect(
    await env.DB.prepare("SELECT count(*) FROM subscribers").first("count(*)"),
  ).toBe(600);
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(600);
});

test("welcome sends through newsletter pause with an unsubscribe link", async () => {
  challenge();
  await handleSignup(request(), testEnv(), now);
  const sent: OutgoingMail[] = [];
  let ms = now.getTime();
  await runScheduled(
    testEnv({
      SENDING_ENABLED: "true",
      SES_DAILY_QUOTA: "1000",
      SES_RATE: "1000",
    }),
    now,
    {
      clock: () => new Date(ms),
      sleep: async (n) => {
        ms += n;
      },
      send: async (_e, mail) => {
        sent.push(mail);
        return { kind: "accepted", messageId: "ses" };
      },
    },
  );
  const welcome = sent.find((m) => m.recipient === "friend@example.com");
  expect(welcome?.subject).toContain("Welcome");
  expect(welcome?.text).toContain("Your signup is complete");
  expect(welcome?.unsubscribe).toContain("/unsubscribe?token=");
  expect(welcome?.html).toContain("Personal unsubscribe");
  expect(welcome?.text).not.toContain("Photos: null");
});
test("concurrent public signups enqueue only one welcome", async () => {
  challenge();
  await Promise.all([
    handleSignup(request(), testEnv(), now),
    handleSignup(request(), testEnv(), now),
  ]);
  expect(await env.DB.prepare("SELECT count(*) n FROM outbox").first("n")).toBe(
    1,
  );
});
test("new welcome signals delivery once and queue failure preserves successful signup", async () => {
  challenge();
  const send = vi.fn(async () => {
    throw Error("queue unavailable");
  });
  const jobs = new Proxy(env.JOBS, {
    get(target, key) {
      if (key === "send") return send;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const e = testEnv({ JOBS: jobs, SENDING_ENABLED: "true" });
  expect((await handleSignup(request(), e, now)).status).toBe(200);
  expect((await handleSignup(request(), e, now)).status).toBe(200);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({ type: "scheduled" });
  expect(await env.DB.prepare("SELECT count(*) n FROM outbox").first("n")).toBe(
    1,
  );
});
test("suppression never sends a welcome or gets cleared by signup", async () => {
  challenge();
  await env.DB.prepare(
    "INSERT INTO suppressions VALUES('friend@example.com','complaint',0)",
  ).run();
  await handleSignup(request(), testEnv(), now);
  expect(await env.DB.prepare("SELECT count(*) n FROM outbox").first("n")).toBe(
    0,
  );
  expect(
    await env.DB.prepare("SELECT reason FROM suppressions").first("reason"),
  ).toBe("complaint");
});
test("resubscription welcomes the new generation and never sends stale welcome", async () => {
  challenge();
  await handleSignup(request(), testEnv(), now);
  await env.DB.prepare("UPDATE subscribers SET status='unsubscribed'").run();
  await handleSignup(request(), testEnv(), now);
  let ms = now.getTime();
  const sent: string[] = [];
  await runScheduled(
    testEnv({
      SENDING_ENABLED: "true",
      SES_DAILY_QUOTA: "1000",
      SES_RATE: "1000",
    }),
    now,
    {
      clock: () => new Date(ms),
      sleep: async (n) => {
        ms += n;
      },
      send: async (_e, m) => {
        sent.push(m.deliveryId);
        return { kind: "accepted", messageId: "ses" };
      },
    },
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatch(/:2$/);
  expect(
    await env.DB.prepare("SELECT state FROM outbox WHERE generation=1").first(
      "state",
    ),
  ).toBe("cancelled");
});
test("welcome persistence failure rolls back membership", async () => {
  challenge();
  await env.DB.prepare(
    "CREATE TRIGGER fail_welcome BEFORE INSERT ON outbox WHEN NEW.is_welcome=1 BEGIN SELECT RAISE(ABORT,'welcome unavailable'); END",
  ).run();
  try {
    expect((await handleSignup(request(), testEnv(), now)).status).toBe(503);
    expect(
      await env.DB.prepare("SELECT count(*) n FROM subscribers").first("n"),
    ).toBe(0);
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_welcome").run();
  }
});
