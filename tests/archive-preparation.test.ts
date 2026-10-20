import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { prepareArchivePages } from "../src/archive";
import { receiveEmail } from "../src/inbound";
import { configure, mail, rawMail, testEnv, now } from "./helpers";

beforeEach(configure);
const verified = { authenticate: async () => true, clock: () => now };

test("receipt commits a complete escaped private archive before its reference", async () => {
  const body = "José <script>bad()</script> &lt; 🏔\n".repeat(1000).trim();
  await receiveEmail(mail(rawMail(body)), testEnv(), verified);
  const key = await env.DB.prepare(
    "SELECT archive_key FROM inbound_messages",
  ).first<string>("archive_key");
  expect(key).toMatch(/^pages\/v1\/[a-f0-9]{64}\.html$/);
  const html = await (await env.ARCHIVE.get(key!))!.text();
  expect(html).toContain("José &lt;script&gt;bad()&lt;/script&gt; &amp;lt; 🏔");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Download original email");
});

test("failed page storage never commits a reference or executes commands", async () => {
  const archive = new Proxy(env.ARCHIVE, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          if (String(args[0]).startsWith("pages/"))
            throw Error("page storage unavailable");
          return target.put(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    receiveEmail(
      mail(rawMail("add new@example.com"), env.MANAGE_ADDRESS),
      testEnv({ ARCHIVE: archive }),
      verified,
    ),
  ).rejects.toThrow("page storage unavailable");
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM subscribers").first("n"),
  ).toBe(0);
});

test("historical pages are backfilled in bounded idempotent batches without changing mail state", async () => {
  const key = `text/${"e".repeat(64)}.txt`;
  await env.ARCHIVE.put(key, "Historic <&> José");
  for (const id of ["old:one", "old:two"])
    await env.DB.prepare(
      "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,text_key,received_at,state,run_id) VALUES(?,'broadcast','raw/old',?,'missionary@example.com',?,'Full <subject>','',?,0,'held','r')",
    )
      .bind(id, id, id, key)
      .run();
  expect(await prepareArchivePages(testEnv(), 1)).toBe(1);
  expect(await prepareArchivePages(testEnv(), 1)).toBe(1);
  expect(await prepareArchivePages(testEnv(), 1)).toBe(0);
  const rows = (
    await env.DB.prepare(
      "SELECT id,archive_key,state FROM inbound_messages",
    ).all<{ id: string; archive_key: string; state: string }>()
  ).results;
  for (const row of rows) {
    expect(row.state).toBe("held");
    const html = await (await env.ARCHIVE.get(row.archive_key))!.text();
    expect(html).toContain("Full &lt;subject&gt;");
    expect(html).toContain("Historic &lt;&amp;&gt; José");
    expect(html).toContain(`/raw/${encodeURIComponent(row.id)}`);
  }
});
