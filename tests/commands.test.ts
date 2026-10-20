import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { parseCommands, applyCommands } from "../src/commands";
import { configure, testEnv, now, rawMail, mail } from "./helpers";
import { receiveEmail } from "../src/inbound";
test("full returns six hundred members in one bounded requested response", async () => {
  await configure();
  await inbound();
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) SELECT 'member'||value,'reader'||value||'@example.com','active',1,0,0,'test','v1' FROM json_each(?)",
  )
    .bind(JSON.stringify(Array.from({ length: 600 }, (_, i) => i)))
    .run();
  await applyCommands(testEnv(), "in", admin, parseCommands("full"), now);
  const output = await env.DB.prepare("SELECT text FROM outbox").first<string>(
    "text",
  );
  expect(output?.split("\n")).toHaveLength(600);
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(1);
});
const admin = { email: "missionary@example.com", role: "missionary" as const };
beforeEach(configure);
async function inbound(id = "in") {
  await env.DB.prepare(
    "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,message_id,fingerprint,subject,text,received_at,run_id) VALUES(?,'command','raw',?,'missionary@example.com',NULL,'fp','Manage','commands',0,?)",
  )
    .bind(id, id, id)
    .run();
}
test("optional matching backticks and quoted history/signature boundaries", () => {
  expect(
    parseCommands(
      "`ADD a@example.com`\nremove b@example.com\n\n-- \nadd ignored@example.com",
    ),
  ).toEqual([
    { line: 1, command: "add", address: "a@example.com" },
    { line: 2, command: "remove", address: "b@example.com" },
  ]);
  expect(
    parseCommands("help\nOn Monday someone wrote:\nadd ignored@example.com"),
  ).toHaveLength(1);
});
test("ordered repeated mutations reply once, dedup does not reapply", async () => {
  await inbound();
  const lines = parseCommands(
    "add a@example.com\nremove a@example.com\nadd a@example.com\npause\nresume",
  );
  await applyCommands(testEnv(), "in", admin, lines, now);
  await applyCommands(testEnv(), "in", admin, lines, now);
  expect(
    await env.DB.prepare("SELECT generation FROM subscribers").first(
      "generation",
    ),
  ).toBe(2);
  expect(
    await env.DB.prepare("SELECT status FROM subscribers").first("status"),
  ).toBe("active");
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT text FROM outbox").first("text"),
  ).toContain("5. Resumed newsletters");
});
test("valid lines apply with one ordered numbered partial-failure summary", async () => {
  await inbound();
  await applyCommands(
    testEnv(),
    "in",
    admin,
    parseCommands("add a@example.com\nadd broken\nremove a@example.com"),
    now,
  );
  const output = await env.DB.prepare("SELECT * FROM outbox").first();
  expect(output?.recipient).toBe(admin.email);
  expect(output?.text).toMatch(/1\. Added.*\n2\. Failed:.*\n3\. Removed/s);
  expect(
    await env.DB.prepare("SELECT status FROM subscribers").first("status"),
  ).toBe("unsubscribed");
});
test("full/status/help output and errors share one response", async () => {
  await inbound();
  await applyCommands(
    testEnv(),
    "in",
    admin,
    parseCommands("add a@example.com\nfull\nstatus\nhelp\nbroken"),
    now,
  );
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(1);
  const text = await env.DB.prepare("SELECT text FROM outbox").first<string>(
    "text",
  );
  expect(text).toContain("a@example.com");
  expect(text).toContain("manage@in.mission.example.com");
  expect(text).toContain("5. Failed:");
});
test("over 100 lines returns one failure and makes no changes", async () => {
  await inbound();
  await applyCommands(
    testEnv(),
    "in",
    admin,
    parseCommands(
      Array.from({ length: 101 }, () => "add a@example.com").join("\n"),
    ),
    now,
  );
  expect(
    await env.DB.prepare("SELECT count(*) FROM subscribers").first("count(*)"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(1);
});
test("100 lines use bounded SQL, suppression survives resubscribe", async () => {
  await inbound();
  await env.DB.prepare(
    "INSERT INTO suppressions VALUES('a0@example.com','complaint',0)",
  ).run();
  let count = 0;
  const db = new Proxy(env.DB, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          count++;
          return t.prepare(sql);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  await applyCommands(
    testEnv({ DB: db }),
    "in",
    admin,
    parseCommands(
      Array.from({ length: 100 }, (_, i) => `add a${i}@example.com`).join("\n"),
    ),
    now,
  );
  expect(count).toBeLessThan(25);
  expect(
    await env.DB.prepare("SELECT count(*) FROM subscribers").first("count(*)"),
  ).toBe(100);
  expect(
    await env.DB.prepare("SELECT reason FROM suppressions").first("reason"),
  ).toBe("complaint");
});
test("unapproved requester cannot manage and management never broadcasts", async () => {
  await inbound();
  await expect(
    applyCommands(
      testEnv(),
      "in",
      { email: "evil@example.com", role: "owner" },
      parseCommands("resume"),
      now,
    ),
  ).rejects.toThrow(/authorized/i);
  await receiveEmail(
    mail(
      rawMail("add a@example.com", "Reply-To: evil@example.com\r\n"),
      env.MANAGE_ADDRESS,
    ),
    testEnv(),
    { authenticate: async () => true, clock: () => now },
  );
  expect(
    await env.DB.prepare("SELECT count(*) FROM broadcasts").first("count(*)"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT status FROM subscribers").first("status"),
  ).toBe("active");
});
test("compare-and-set retries instead of overwriting concurrent unsubscribe", async () => {
  await inbound();
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) VALUES('s','a@example.com','active',1,0,0,'test','v1')",
  ).run();
  let race = true;
  const db = new Proxy(env.DB, {
    get(t, k) {
      if (k === "batch")
        return async (s: D1PreparedStatement[]) => {
          if (race) {
            race = false;
            await t
              .prepare(
                "UPDATE subscribers SET status='unsubscribed',version=version+1 WHERE id='s'",
              )
              .run();
          }
          return t.batch(s);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  await applyCommands(
    testEnv({ DB: db }),
    "in",
    admin,
    parseCommands("add a@example.com"),
    now,
  );
  expect(
    await env.DB.prepare("SELECT generation FROM subscribers").first(
      "generation",
    ),
  ).toBe(2);
});

test.each(["Sent from my iPhone", "Sent from my iPad"])(
  "mobile signature %s stops commands without a false failure reply",
  async (signature) => {
    await receiveEmail(
      mail(
        rawMail(
          `add phone@example.com\n\n${signature}\nremove phone@example.com`,
        ),
        env.MANAGE_ADDRESS,
      ),
      testEnv(),
      { authenticate: async () => true, clock: () => now },
    );
    expect(
      await env.DB.prepare(
        "SELECT status FROM subscribers WHERE email='phone@example.com'",
      ).first("status"),
    ).toBe("active");
    expect(
      await env.DB.prepare("SELECT count(*) n FROM outbox").first("n"),
    ).toBe(1);
    const result = await env.DB.prepare(
      "SELECT results FROM command_results",
    ).first<string>("results");
    expect(JSON.parse(result!)).toEqual(["1. Added phone@example.com"]);
  },
);

test("mobile-footer recognition does not hide errors before it or similar ordinary text", () => {
  expect(parseCommands("broken\nSent from my iPhone")).toEqual([
    expect.objectContaining({ line: 1, error: expect.any(String) }),
  ]);
  expect(parseCommands("Sent from my iPhone please add me")).toEqual([
    expect.objectContaining({ line: 1, error: expect.any(String) }),
  ]);
});
