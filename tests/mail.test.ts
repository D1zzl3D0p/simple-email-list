import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { receiveEmail } from "../src/inbound";
import { prepareNextMessage, parseMail } from "../src/mail";
import { configure, testEnv, mail, rawMail, now } from "./helpers";
beforeEach(configure);
test("unicode_and_links_preserved", async () => {
  const p = await parseMail(new TextEncoder().encode(rawMail()));
  expect(p.text).toContain("José https://example.com");
});
test("html_only_becomes_safe_text", async () => {
  const p = await parseMail(
    new TextEncoder().encode(
      rawMail(
        '<p>Hello <a href="https://example.com">visit</a><script>bad()</script></p>',
      ).replace("text/plain", "text/html"),
    ),
  );
  expect(p.text).toContain("https://example.com");
  expect(p.text).not.toContain("bad()");
});
test.each([
  ["", "Hello", "missing subject"],
  ["Week", "", "missing body"],
])("blank input held: %s", async (subject, body) => {
  await receiveEmail(mail(rawMail(body, "", subject)), testEnv(), {
    authenticate: async () => true,
    clock: () => now,
  });
  expect(
    await env.DB.prepare("SELECT state FROM inbound_messages").first("state"),
  ).toBe("held");
});
const attachmentMail = (content = "AAECAw==") =>
  rawMail(
    `--part\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nLetter with https://photos.google.com/album\r\n--part\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="a.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}\r\n--part--\r\n`,
  ).replace(
    "Content-Type: text/plain; charset=utf-8",
    'Content-Type: multipart/mixed; boundary="part"',
  );
test("attachments are dropped while the text update is prepared", async () => {
  await receiveEmail(mail(attachmentMail()), testEnv(), {
    authenticate: async () => true,
    clock: () => now,
  });
  await prepareNextMessage(testEnv(), now);
  expect(
    await env.DB.prepare("SELECT state FROM inbound_messages").first("state"),
  ).toBe("prepared");
  expect(
    await env.DB.prepare("SELECT text FROM broadcasts").first("text"),
  ).toBe("Letter with https://photos.google.com/album");
});
test("changing ignored attachment bytes does not replay the text update", async () => {
  const verified = { authenticate: async () => true, clock: () => now };
  await receiveEmail(mail(attachmentMail()), testEnv(), verified);
  await receiveEmail(mail(attachmentMail("AAECAA==")), testEnv(), verified);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(1);
});
test("attachment-only mail is held for missing text, never published as binary", async () => {
  await receiveEmail(
    mail(
      rawMail(
        "binary",
        'Content-Disposition: attachment; filename="a.bin"\r\n',
      ),
    ),
    testEnv(),
    {
      authenticate: async () => true,
      clock: () => now,
    },
  );
  expect(
    await env.DB.prepare("SELECT held_reason FROM inbound_messages").first(
      "held_reason",
    ),
  ).toBe("Missing body");
});
test("inline attached images disappear while HTML text and album links survive", async () => {
  const raw = rawMail(
    `--part\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <a href="https://photos.google.com/album">photos</a><img src="cid:photo" alt="Embedded photo"></p>\r\n--part\r\nContent-Type: image/png\r\nContent-ID: <photo>\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==\r\n--part--\r\n`,
  ).replace(
    "Content-Type: text/plain; charset=utf-8",
    'Content-Type: multipart/related; boundary="part"',
  );
  const parsed = await parseMail(new TextEncoder().encode(raw));
  expect(parsed.text).toContain("Hello");
  expect(parsed.text).toContain("https://photos.google.com/album");
  expect(parsed.text).not.toMatch(/cid:|Embedded photo|AAECAw/);
  expect(parsed.parsed.attachments).toHaveLength(0);
});
test("snapshot freezes generations, excludes later joins, and stores shared body once for six hundred", async () => {
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) SELECT 's'||value,'a'||value||'@example.com','active',3,0,0,'test','v1' FROM json_each(?)",
  )
    .bind(JSON.stringify(Array.from({ length: 600 }, (_, i) => i)))
    .run();
  await receiveEmail(mail(rawMail()), testEnv(), {
    authenticate: async () => true,
    clock: () => now,
  });
  let calls = 0;
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          calls++;
          return target.prepare(sql);
        };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await prepareNextMessage(testEnv({ DB: db }), now);
  expect(calls).toBeLessThan(10);
  await env.DB.prepare(
    "UPDATE settings SET album_url='https://changed.example.com'",
  ).run();
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) VALUES('late','late@example.com','active',1,0,0,'test','v1')",
  ).run();
  expect(await env.DB.prepare("SELECT count(*) n FROM outbox").first("n")).toBe(
    600,
  );
  expect(
    await env.DB.prepare("SELECT min(generation) FROM outbox").first(
      "min(generation)",
    ),
  ).toBe(3);
  expect(
    await env.DB.prepare("SELECT count(text) FROM outbox").first("count(text)"),
  ).toBe(0);
  const b = await env.DB.prepare("SELECT * FROM broadcasts").first();
  expect(b?.text).toContain("José");
  expect(b?.album_url).toBe("https://photos.google.com/fixture");
});
