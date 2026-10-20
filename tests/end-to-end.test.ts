import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSign } from "node:crypto";
import cert from "./fixtures/sns-test-cert.pem?raw";
import key from "./fixtures/sns-test-key.pem?raw";
import { handleSignup } from "../src/signup";
import { receiveEmail } from "../src/inbound";
import { runScheduled } from "../src/delivery";
import { handleSnsEvents } from "../src/events";
import {
  capability,
  handleUnsubscribe,
  handleResubscribe,
} from "../src/unsubscribe";
import { configure, testEnv, now, rawMail, mail } from "./helpers";
beforeEach(configure);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
test("600 signups → ordinary-subject receipt → durable paced sends → signed delivery → leave and undo", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      success: true,
      hostname: "mission.example.com",
      action: "subscribe",
    }),
  );
  const e = testEnv();
  for (let i = 0; i < 600; i++)
    expect(
      (
        await handleSignup(
          new Request(e.PUBLIC_URL + "/subscribe", {
            method: "POST",
            body: new URLSearchParams({
              email: `reader${i}@example.com`,
              "cf-turnstile-response": `fixture${i}`,
            }),
          }),
          e,
          now,
        )
      ).status,
    ).toBe(200);
  await receiveEmail(mail(rawMail()), e, {
    authenticate: async () => true,
    clock: () => now,
  });
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(0);
  await env.DB.prepare("UPDATE settings SET paused=0").run();
  const sent: { delivery: string; attempt: string; recipient: string }[] = [];
  let time = now.getTime() + 7 * 86400000;
  const live = {
    ...e,
    SENDING_ENABLED: "true",
    SES_DAILY_QUOTA: "10000",
    SES_RATE: "10",
    SNS_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:mission-events",
  };
  const deps = {
    clock: () => new Date(time),
    sleep: async (ms: number) => {
      time += ms;
    },
    send: async (
      _e: unknown,
      m: { recipient: string; deliveryId: string },
      id: string,
    ) => {
      sent.push({
        delivery: m.deliveryId,
        attempt: id,
        recipient: m.recipient,
      });
      return { kind: "accepted" as const, messageId: "ses-" + id };
    },
  };
  for (let i = 0; i < 3; i++) {
    await runScheduled(live, new Date(time), deps);
    time += 900000;
  }
  const newsletter = sent.find((s) => s.recipient.startsWith("reader"))!;
  expect(newsletter).toBeTruthy();
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM outbox WHERE kind='newsletter'",
    ).first("count(*)"),
  ).toBe(600);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM outbox WHERE kind='newsletter' AND state='pending'",
    ).first<number>("count(*)"),
  ).toBeGreaterThan(580);
  vi.stubGlobal("fetch", async () => new Response(cert));
  const event = {
    eventType: "Delivery",
    mail: {
      messageId: "ses-" + newsletter.attempt,
      sendingAccountId: "123456789012",
      destination: [newsletter.recipient],
      tags: {
        attempt_id: [newsletter.attempt],
        delivery_id: [
          "d_" + Buffer.from(newsletter.delivery).toString("base64url"),
        ],
      },
    },
  };
  const envelope: Record<string, string> = {
    Type: "Notification",
    MessageId: "e2e-event",
    Timestamp: now.toISOString(),
    TopicArn: live.SNS_TOPIC_ARN,
    Message: JSON.stringify(event),
    SignatureVersion: "2",
    SigningCertURL:
      "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem",
  };
  const signer = createSign("RSA-SHA256");
  signer.update(
    ["Message", "MessageId", "Timestamp", "TopicArn", "Type"]
      .map((k) => `${k}\n${envelope[k]}\n`)
      .join(""),
  );
  envelope.Signature = signer.sign(key, "base64");
  expect(
    (
      await handleSnsEvents(
        new Request(e.PUBLIC_URL + "/events/sns", {
          method: "POST",
          body: JSON.stringify(envelope),
        }),
        live,
        now,
      )
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare("SELECT state FROM outbox WHERE id=?")
      .bind(newsletter.delivery)
      .first("state"),
  ).toBe("delivered");
  const member = await env.DB.prepare(
    "SELECT id,generation FROM subscribers WHERE email=?",
  )
    .bind(newsletter.recipient)
    .first<{ id: string; generation: number }>();
  const token = await capability(e, "leave", member!.id, member!.generation);
  await handleUnsubscribe(
    new Request(e.PUBLIC_URL + "/unsubscribe?token=" + token, {
      method: "POST",
    }),
    e,
    now,
  );
  expect(
    await env.DB.prepare("SELECT status FROM subscribers WHERE id=?")
      .bind(member!.id)
      .first("status"),
  ).toBe("unsubscribed");
  await handleResubscribe(
    new Request(
      e.PUBLIC_URL +
        "/resubscribe?token=" +
        (await capability(e, "undo", member!.id, member!.generation)),
      { method: "POST" },
    ),
    e,
    now,
  );
  expect(
    await env.DB.prepare("SELECT generation FROM subscribers WHERE id=?")
      .bind(member!.id)
      .first("generation"),
  ).toBe(2);
});
test("missionary management is quiet on success and returns one ordered failure/requested response", async () => {
  const e = testEnv();
  await receiveEmail(
    mail(rawMail("add first@example.com"), e.MANAGE_ADDRESS),
    e,
    { authenticate: async () => true, clock: () => now },
  );
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(0);
  await receiveEmail(
    mail(
      rawMail(
        "add second@example.com\nadd malformed\nfull\nstatus\nhelp",
      ).replace("<one@example.com>", "<two@example.com>"),
      e.MANAGE_ADDRESS,
    ),
    e,
    { authenticate: async () => true, clock: () => now },
  );
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(1);
  const output = await env.DB.prepare(
    "SELECT recipient,text FROM outbox",
  ).first();
  expect(output?.recipient).toBe("missionary@example.com");
  expect(output?.text).toContain("2. Failed:");
  expect(output?.text).toContain("second@example.com");
  expect(
    await env.DB.prepare("SELECT count(*) FROM broadcasts").first("count(*)"),
  ).toBe(0);
});
