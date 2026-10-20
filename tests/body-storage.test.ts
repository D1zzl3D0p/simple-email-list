import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { receiveEmail, processPendingCommands } from "../src/inbound";
import { prepareNextMessage } from "../src/mail";
import { runScheduled } from "../src/delivery";
import { configure, testEnv, mail, rawMail, now } from "./helpers";

beforeEach(configure);
const verified = { authenticate: async () => true, clock: () => now };
const body = "Large update José <&> https://example.com\n".repeat(1000).trim();

test("large normalized bodies remain complete through private storage and delivery", async () => {
  await receiveEmail(mail(rawMail(body)), testEnv(), verified);
  const inbound = await env.DB.prepare("SELECT * FROM inbound_messages").first<{
    text: string;
    text_key?: string;
  }>();
  expect(inbound?.text_key).toMatch(/^text\/[a-f0-9]{64}\.txt$/);
  expect(inbound?.text).toBe("");
  expect(await (await env.ARCHIVE.get(inbound!.text_key!))!.text()).toBe(body);
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) VALUES('reader','reader@example.com','active',1,0,0,'fixture','v1')",
  ).run();
  await prepareNextMessage(testEnv(), now);
  expect(
    await env.DB.prepare("SELECT text_key FROM broadcasts").first("text_key"),
  ).toBe(inbound!.text_key);
  await env.DB.prepare("UPDATE settings SET paused=0").run();
  let t = now.getTime();
  const sent: { recipient: string; text: string; html: string }[] = [];
  await runScheduled(
    testEnv({
      SENDING_ENABLED: "true",
      SES_DAILY_QUOTA: "1000",
      SES_RATE: "1000",
    }),
    now,
    {
      clock: () => new Date(t),
      sleep: async (ms) => {
        t += ms;
      },
      send: async (_env, m) => {
        sent.push(m);
        return { kind: "accepted", messageId: "fixture" };
      },
    },
  );
  const newsletter = sent.find((m) => m.recipient === "reader@example.com");
  expect(newsletter?.text).toContain(body);
  expect(newsletter?.html).toContain("José &lt;&amp;&gt;");
});

test("normalized storage failure rejects receipt before a database reference exists", async () => {
  const archive = new Proxy(env.ARCHIVE, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          if (String(args[0]).startsWith("text/"))
            throw Error("normalized storage offline");
          return target.put(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    receiveEmail(mail(rawMail(body)), testEnv({ ARCHIVE: archive }), verified),
  ).rejects.toThrow("normalized storage offline");
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(0);
});

test("a large management message still executes its commands exactly once", async () => {
  const commands =
    "add new@example.com\n-- \n" + "signature text ".repeat(1500);
  await receiveEmail(
    mail(rawMail(commands), env.MANAGE_ADDRESS),
    testEnv(),
    verified,
  );
  expect(
    await env.DB.prepare(
      "SELECT status FROM subscribers WHERE email='new@example.com'",
    ).first("status"),
  ).toBe("active");
  expect(
    await env.DB.prepare("SELECT text_key FROM inbound_messages").first(
      "text_key",
    ),
  ).toMatch(/^text\//);
  await processPendingCommands(testEnv(), now);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM command_results").first("n"),
  ).toBe(1);
});
test("a missing normalized object never reserves or submits a newsletter", async () => {
  await receiveEmail(mail(rawMail(body)), testEnv(), verified);
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) VALUES('reader','reader@example.com','active',1,0,0,'fixture','v1')",
  ).run();
  await prepareNextMessage(testEnv(), now);
  const bodyKey = await env.DB.prepare(
    "SELECT text_key FROM broadcasts",
  ).first<string>("text_key");
  await env.ARCHIVE.delete(bodyKey!);
  await env.DB.prepare("UPDATE settings SET paused=0,missionary='' ").run();
  let sent = 0;
  await expect(
    runScheduled(
      testEnv({
        SENDING_ENABLED: "true",
        SES_DAILY_QUOTA: "1000",
        SES_RATE: "1000",
      }),
      now,
      {
        clock: () => now,
        sleep: async () => {},
        send: async () => {
          sent++;
          return { kind: "accepted", messageId: "fixture" };
        },
      },
    ),
  ).rejects.toThrow("Private message body unavailable");
  expect(sent).toBe(0);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM send_attempts").first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT state FROM outbox WHERE kind='newsletter'",
    ).first("state"),
  ).toBe("pending");
});
