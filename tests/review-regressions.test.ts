import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configure, testEnv, now, mail, rawMail } from "./helpers";
import { receiveEmail } from "../src/inbound";
import { prepareNextMessage, parseMail } from "../src/mail";
import { parseCommands } from "../src/commands";
import {
  ensureWeeklyReport,
  buildSnapshot,
  formatSnapshot,
} from "../src/report";
import { finishRun, startRun, recordIncident } from "../src/incidents";
import { runScheduled } from "../src/delivery";
import { sendSes } from "../src/ses";
import { handleSignup } from "../src/signup";
beforeEach(configure);
afterEach(() => vi.unstubAllGlobals());
const enabled = () =>
  testEnv({
    SENDING_ENABLED: "true",
    STAGE: "production",
    SES_CONFIGURATION_SET: "fixture",
    SES_DAILY_QUOTA: "1000",
    SES_RATE: "10",
  });
function clock() {
  let time = now.getTime();
  return {
    clock: () => new Date(time),
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}
test("all actual outbox producers emit SES-compatible delivery tags", async () => {
  const e = testEnv();
  await receiveEmail(mail(rawMail()), e, {
    authenticate: async () => true,
    clock: () => now,
  });
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) VALUES('member','reader@example.com','active',1,0,0,'test','v1')",
  ).run();
  await prepareNextMessage(e, now);
  await receiveEmail(
    mail(
      rawMail("help").replace("<one@example.com>", "<command@example.com>"),
      e.MANAGE_ADDRESS,
    ),
    e,
    { authenticate: async () => true, clock: () => now },
  );
  await ensureWeeklyReport(e, now);
  await startRun(e, "test-run", "missionary@example.com", "scheduled", now);
  await recordIncident(
    e,
    { runId: "test-run", sourceKey: "f", code: "timeout", detail: "review" },
    now,
  );
  await finishRun(e, "test-run", now);
  const ids = (
    await env.DB.prepare("SELECT id FROM outbox").all<{ id: string }>()
  ).results;
  expect(ids).toHaveLength(4);
  const tags: string[] = [];
  vi.stubGlobal("fetch", async (r: Request) => {
    const p = await r.json<{ EmailTags: { Name: string; Value: string }[] }>();
    tags.push(p.EmailTags[0].Value);
    return Response.json({ MessageId: "ses" });
  });
  for (const { id } of ids)
    await sendSes(
      enabled(),
      {
        recipient: "reader@example.com",
        subject: "s",
        text: "t",
        html: "t",
        replyTo: "missionary@example.com",
        deliveryId: id,
      },
      crypto.randomUUID(),
      now,
    );
  expect(tags.every((t) => /^[A-Za-z0-9_-]{1,256}$/.test(t))).toBe(true);
  expect(new Set(tags).size).toBe(4);
});
test("Outlook plain and HTML-derived reply history never executes old commands", async () => {
  const quoted =
    "help\n\nFrom: Missionary <missionary@example.com>\nSent: Monday, October 19\nTo: Management\nSubject: Previous commands\n\nremove reader@example.com";
  expect(parseCommands(quoted)).toEqual([{ line: 1, command: "help" }]);
  const html =
    "<p>help</p><hr><div><b>From:</b> Missionary<br><b>Sent:</b> Monday<br><b>To:</b> Management<br><b>Subject:</b> Earlier</div><p>remove reader@example.com</p>";
  const parsed = await parseMail(
    new TextEncoder().encode(rawMail(html).replace("text/plain", "text/html")),
  );
  expect(parseCommands(parsed.text)).toEqual([{ line: 1, command: "help" }]);
});
test("failed backup maintenance does not stop ordinary requested mail", async () => {
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,subject,text,state,due_at,created_at) VALUES('requested','owner','missionary@example.com','Status','requested output','pending',0,0)",
  ).run();
  vi.stubGlobal(
    "fetch",
    async () => new Response("export outage", { status: 500 }),
  );
  const sent: string[] = [];
  const d = clock();
  await runScheduled(
    {
      ...enabled(),
      CLOUDFLARE_EXPORT_TOKEN: "fixture",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_DATABASE_ID: "d",
    },
    now,
    {
      ...d,
      send: async (_e, m) => {
        sent.push(m.deliveryId);
        return { kind: "accepted", messageId: "ses" };
      },
    },
  );
  expect(sent).toContain("requested");
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM incidents WHERE code='backup_failed'",
    ).first("count(*)"),
  ).toBe(1);
});
test("summary result persistence failure cannot recursively create another summary", async () => {
  const e = testEnv();
  await startRun(e, "original", "missionary@example.com", "scheduled", now);
  await recordIncident(
    e,
    {
      runId: "original",
      sourceKey: "original-error",
      code: "uncertain",
      detail: "review",
    },
    now,
  );
  await finishRun(e, "original", now);
  await ensureWeeklyReport(e, now);
  await env.DB.prepare(
    "UPDATE outbox SET state='accepted' WHERE unique_key LIKE 'weekly:%'",
  ).run();
  let fail = true;
  const db = new Proxy(env.DB, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          if (fail && sql.startsWith("UPDATE outbox SET state=?")) {
            fail = false;
            throw Error("summary result write failed");
          }
          return t.prepare(sql);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const sent: string[] = [];
  const d = clock();
  await expect(
    runScheduled({ ...enabled(), DB: db }, now, {
      ...d,
      send: async (_e, m) => {
        sent.push(m.deliveryId);
        return { kind: "accepted", messageId: "ses" };
      },
    }),
  ).rejects.toThrow("summary result write failed");
  expect(sent).toEqual(["failure:original"]);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM outbox WHERE is_summary=1",
    ).first("count(*)"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT count(*) FROM incidents").first("count(*)"),
  ).toBe(1);
});
test("weekly recovery supersedes old unsent reports while preserving uncertain reports", async () => {
  await ensureWeeklyReport(testEnv(), now);
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,subject,text,state,due_at,created_at,unique_key) VALUES('uncertain-week','owner','missionary@example.com','Weekly','old','review_required',0,0,'weekly:2026-10-12')",
  ).run();
  await ensureWeeklyReport(testEnv(), new Date("2026-11-02T16:00:00Z"));
  expect(
    await env.DB.prepare(
      "SELECT state FROM outbox WHERE unique_key='weekly:2026-10-19'",
    ).first("state"),
  ).toBe("cancelled");
  expect(
    await env.DB.prepare(
      "SELECT state FROM outbox WHERE id='uncertain-week'",
    ).first("state"),
  ).toBe("review_required");
});
test("actual SES daily quota exhaustion stops batch and persists shared cooldown", async () => {
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,subject,text,state,due_at,created_at) VALUES('a','owner','missionary@example.com','a','a','pending',0,0),('b','owner','missionary@example.com','b','b','pending',0,0)",
  ).run();
  let submissions = 0;
  vi.stubGlobal("fetch", async () => {
    submissions++;
    return Response.json(
      { message: "Daily message quota exceeded." },
      {
        status: 429,
        headers: { "x-amzn-errortype": "TooManyRequestsException" },
      },
    );
  });
  const d = clock();
  await runScheduled(enabled(), now, { ...d, send: sendSes });
  await runScheduled(enabled(), now, { ...d, send: sendSes });
  expect(submissions).toBe(1);
  expect(
    await env.DB.prepare("SELECT count(*) FROM send_attempts").first(
      "count(*)",
    ),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT quota_retry_at FROM settings").first<number>(
      "quota_retry_at",
    ),
  ).toBeGreaterThan(now.getTime());
});
test("status includes quota-aware backlog estimates, changes and aggregate validation outage", async () => {
  await env.DB.prepare("UPDATE settings SET paused=0").run();
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,state,due_at,created_at) SELECT 'q'||value,'newsletter','reader@example.com','pending',0,? FROM json_each(?)",
  )
    .bind(
      now.getTime() - 7200000,
      JSON.stringify(Array.from({ length: 300 }, (_, i) => i)),
    )
    .run();
  vi.stubGlobal("fetch", async () => {
    throw Error("Turnstile offline");
  });
  await handleSignup(
    new Request(env.PUBLIC_URL + "/subscribe", {
      method: "POST",
      body: new URLSearchParams({
        email: "reader@example.com",
        "cf-turnstile-response": "fixture",
      }),
    }),
    testEnv(),
    now,
  );
  const snapshot = await buildSnapshot(testEnv({ SES_DAILY_QUOTA: "10" }), now);
  const output = formatSnapshot(snapshot);
  expect(output).toContain("Oldest pending age: 2.0 hours");
  expect(output).toContain("Newsletter budget: 0/8");
  expect(output).toMatch(/Projected.*900/);
  expect(output).toContain("Validation service faults: 1");
  expect(snapshot.warnings.join(" ")).toMatch(/weekly capacity/i);
});
test("held-first Message-ID remains protected against changed content", async () => {
  await receiveEmail(mail(rawMail("", "", "Week")), testEnv(), {
    authenticate: async () => true,
    clock: () => now,
  });
  await receiveEmail(mail(rawMail("Changed later")), testEnv(), {
    authenticate: async () => true,
    clock: () => now,
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM inbound_messages WHERE state='pending'",
    ).first("count(*)"),
  ).toBe(0);
});
test("quota reservations do not consume the safe-rejection retry allowance", async () => {
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,subject,text,state,due_at,created_at,attempt_count) VALUES('quota-recovered','owner','missionary@example.com','s','t','pending',0,0,5)",
  ).run();
  await ensureWeeklyReport(testEnv(), now);
  await env.DB.prepare(
    "UPDATE outbox SET state='accepted' WHERE unique_key LIKE 'weekly:%'",
  ).run();
  const d = clock();
  await runScheduled(enabled(), now, {
    ...d,
    send: async () => ({
      kind: "safe_retry",
      dueAt: now.getTime() + 900000,
      reason: "rate throttling",
    }),
  });
  expect(
    await env.DB.prepare(
      "SELECT state FROM outbox WHERE id='quota-recovered'",
    ).first("state"),
  ).toBe("retry_wait");
});
