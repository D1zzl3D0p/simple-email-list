import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { archiveAccess } from "../src/archive-access";
import { receiveEmail } from "../src/inbound";
import { handlePublicArchive } from "../src/public-archive";
import type { Env } from "../src/types";
import { configure, mail, now, rawMail, testEnv } from "./helpers";

let cookie: string;
beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        success: true,
        hostname: new URL(env.PUBLIC_URL).hostname,
        action: "archive",
      }),
    ),
  );
  const response = await archiveAccess(
    new Request(env.PUBLIC_URL + "/updates/verify", {
      method: "POST",
      body: new URLSearchParams({
        "cf-turnstile-response": "fixture",
        return: "/updates",
      }),
    }),
    testEnv(),
    now,
  );
  cookie = response!.headers.get("set-cookie")!.split(";")[0];
});
afterEach(() => vi.unstubAllGlobals());

async function seed(
  id: string,
  received = "2026-10-18T16:00:00Z",
  extra: {
    subject?: string;
    text?: string;
    role?: string;
    state?: string;
    textKey?: string;
  } = {},
) {
  await env.DB.prepare(
    `INSERT INTO inbound_messages
    (id,role,raw_key,raw_hash,sender,fingerprint,subject,text,received_at,state,run_id,text_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      extra.role ?? "broadcast",
      "raw/private.eml",
      id,
      "private-sender@example.com",
      id,
      extra.subject ?? `Subject ${id}`,
      extra.text ?? `Body ${id}`,
      new Date(received).getTime(),
      extra.state ?? "pending",
      "fixture",
      extra.textKey ?? null,
    )
    .run();
}
function read(path = "/updates", method = "GET", bindings: Env = testEnv()) {
  return handlePublicArchive(
    new Request(env.PUBLIC_URL + path, { method, headers: { cookie } }),
    bindings,
    now,
  );
}
function history(html: string) {
  return html.match(/<nav class="archive-history"[^>]*>([\s\S]*?)<\/nav>/)![1];
}
function historyLinks(html: string) {
  return [...history(html).matchAll(/href="([^"]+)"/g)].map(
    (match) => match[1],
  );
}
function navigation(html: string) {
  return html.match(
    /<nav[^>]*aria-label="Update navigation"[^>]*>([\s\S]*?)<\/nav>/,
  )![1];
}

test("long subjects use bounded history excerpts but the selected reader preserves the entire subject", async () => {
  const subject = "A long subject ".repeat(500) + "FINAL SUBJECT";
  await seed("long", undefined, { subject });
  const html = await (await read()).text();
  expect(history(html)).not.toContain(subject);
  expect(history(html)).toContain("A long subject ");
  expect(history(html).length).toBeLessThan(1500);
  expect(html).toContain("<h1>" + subject + "</h1>");
});
function privateHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

test("latest accepted canonical body opens by default and complete history has permanent URLs", async () => {
  await seed("broadcast:old");
  await seed("broadcast:new", "2026-10-19T16:00:00Z");
  const response = await read();
  expect(response.status).toBe(200);
  privateHeaders(response);
  const html = await response.text();
  expect(html).toContain("Body broadcast:new");
  expect(html).not.toContain("Body broadcast:old");
  expect(historyLinks(html)).toEqual([
    "/updates/broadcast%3Anew",
    "/updates/broadcast%3Aold",
  ]);
  expect(html).not.toContain("private-sender@example.com");
  expect(html).not.toContain("raw/private.eml");
  expect(html).not.toContain("unsubscribe");
});

test("middle entry offers Older and Newer at the top in chronological order", async () => {
  await seed("old", "2026-10-17T16:00:00Z");
  await seed("middle");
  await seed("new", "2026-10-19T16:00:00Z");
  const html = await (await read("/updates/middle")).text();
  expect(navigation(html)).toMatch(
    /href="\/updates\/old"[^>]*>← Older<\/a>[\s\S]*href="\/updates\/new"[^>]*>Newer →<\/a>/,
  );
  expect(html).toContain("Body middle");
  expect(history(html)).toMatch(
    /href="\/updates\/middle"[^>]*aria-current="page"/,
  );
});

test("oldest and newest entries disable only controls without a destination", async () => {
  await seed("old");
  await seed("new", "2026-10-19T16:00:00Z");
  const oldest = navigation(await (await read("/updates/old")).text());
  expect(oldest).toMatch(/aria-disabled="true"[^>]*>← Older<\/span>/);
  expect(oldest).toMatch(/href="\/updates\/new"[^>]*>Newer →<\/a>/);
  const latest = navigation(await (await read()).text());
  expect(latest).toMatch(/aria-disabled="true"[^>]*>Newer →<\/span>/);
  expect(latest).toMatch(/href="\/updates\/old"[^>]*>← Older<\/a>/);
});

test("one entry disables both controls and trailing slash also selects it", async () => {
  await seed("only");
  const html = await (await read("/updates/")).text();
  expect(navigation(html).match(/aria-disabled="true"/g)).toHaveLength(2);
  expect(html).toContain("Body only");
});

test("same received timestamp uses descending ID and adjacent navigation is deterministic", async () => {
  await seed("a");
  await seed("c");
  await seed("b");
  const html = await (await read("/updates/b")).text();
  expect(historyLinks(html)).toEqual([
    "/updates/c",
    "/updates/b",
    "/updates/a",
  ]);
  expect(navigation(html)).toMatch(/href="\/updates\/a"[^>]*>← Older<\/a>/);
  expect(navigation(html)).toMatch(/href="\/updates\/c"[^>]*>Newer →<\/a>/);
});

test("year grouping and displayed dates use Mountain Time across UTC year rollover", async () => {
  await seed("denver-2026", "2027-01-01T06:30:00Z");
  await seed("denver-2027", "2027-01-01T07:30:00Z");
  const html = await (await read("/updates/denver-2026")).text();
  expect(history(html)).toContain('data-year="2027" data-month="January"');
  expect(history(html)).toContain('data-year="2026" data-month="December"');
  expect(history(html)).toMatch(
    /<h3>2027<\/h3>[\s\S]*January 1, 2027[\s\S]*<h3>2026<\/h3>[\s\S]*December 31, 2026/,
  );
  expect(html).toContain(
    '<time datetime="2027-01-01T06:30:00.000Z">December 31, 2026</time>',
  );
});

test("empty eligible history gives an empty state and signup link after verification", async () => {
  const response = await read();
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("No updates yet");
  expect(html).toMatch(/href="\/"[^>]*>Sign up/);
  privateHeaders(response);
});

test("permanent URL decodes the canonical ID and selects that earlier body", async () => {
  await seed("broadcast:earlier");
  await seed("newer", "2026-10-19T16:00:00Z");
  const html = await (await read("/updates/broadcast%3Aearlier")).text();
  expect(html).toContain("Body broadcast:earlier");
  expect(html).not.toContain("Body newer");
});

test("test flag excludes history and direct URLs while new accepted mail defaults to public", async () => {
  await seed("marked-test", "2026-10-31T20:00:00Z");
  await env.DB.prepare("UPDATE inbound_messages SET is_test=1 WHERE id=?")
    .bind("marked-test")
    .run();
  await seed("future-letter", "2026-10-30T20:00:00Z", {
    subject: "Testing for real",
  });
  const html = await (await read()).text();
  expect(historyLinks(html)).toEqual(["/updates/future-letter"]);
  expect(html).toContain("Testing for real");
  for (const method of ["GET", "HEAD"]) {
    const response = await read("/updates/marked-test", method);
    expect(response.status).toBe(404);
  }
  expect(
    await env.DB.prepare(
      "SELECT is_test FROM inbound_messages WHERE id='future-letter'",
    ).first("is_test"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT text FROM inbound_messages WHERE id='marked-test'",
    ).first("text"),
  ).toBe("Body marked-test");
  await env.DB.prepare(
    "UPDATE inbound_messages SET is_test=0 WHERE id='marked-test'",
  ).run();
  expect(historyLinks(await (await read()).text())).toEqual([
    "/updates/marked-test",
    "/updates/future-letter",
  ]);
});

test("commands and held messages never enter the date index", async () => {
  await seed("command", undefined, {
    role: "command",
    subject: "Private command",
  });
  await seed("held", undefined, { state: "held", subject: "Private held" });
  await seed("accepted", undefined, { state: "processed" });
  const html = await (await read()).text();
  expect(historyLinks(html)).toEqual(["/updates/accepted"]);
  expect(html).not.toContain("Private command");
  expect(html).not.toContain("Private held");
});

test("command held missing and malformed IDs return the same generic not-found response", async () => {
  await seed("command", undefined, { role: "command" });
  await seed("held", undefined, { state: "held" });
  const bodies = [];
  for (const path of [
    "/updates/command",
    "/updates/held",
    "/updates/missing",
    "/updates/%GG",
  ]) {
    const response = await read(path);
    expect(response.status).toBe(404);
    privateHeaders(response);
    bodies.push(await response.text());
  }
  expect(new Set(bodies).size).toBe(1);
  expect(bodies[0]).not.toContain("Subject");
});

test("visibility is independent of subscriber count broadcast preparation and delivery failures", async () => {
  await seed("pending");
  await seed("prepared", undefined, { state: "prepared" });
  await seed("processed", undefined, { state: "processed" });
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,text,state,due_at,created_at,unique_key) VALUES('failed','owner','private@example.com','Private delivery','failed',0,0,'failed')",
  ).run();
  const html = await (await read()).text();
  expect(historyLinks(html)).toEqual([
    "/updates/processed",
    "/updates/prepared",
    "/updates/pending",
  ]);
  expect(html).not.toContain("private@example.com");
  expect(html).not.toContain("Private delivery");
});

test("authenticated inbound mail appears automatically without subscribers and duplicate receipt stays one entry", async () => {
  await configure();
  const deps = { authenticate: async () => true, clock: () => now };
  await receiveEmail(
    mail(rawMail("Automatic canonical body", "", "Automatic accepted subject")),
    testEnv(),
    deps,
  );
  await receiveEmail(
    mail(
      rawMail(
        "Automatic canonical body",
        "Received: transit changed\r\n",
        "Automatic accepted subject",
      ),
    ),
    testEnv(),
    deps,
  );
  const html = await (await read()).text();
  expect(historyLinks(html)).toHaveLength(1);
  expect(html).toContain("Automatic accepted subject");
  expect(html).toContain("Automatic canonical body");
  expect(
    await env.DB.prepare("SELECT count(*) n FROM subscribers").first("n"),
  ).toBe(0);
});

test("large accepted normalized text remains complete when ingestion stores it in private R2", async () => {
  await configure();
  const body =
    "Opening paragraph\r\n\r\n" +
    "Large canonical content. ".repeat(600) +
    "\r\n\r\nFINAL SENTINEL";
  await receiveEmail(mail(rawMail(body)), testEnv(), {
    authenticate: async () => true,
    clock: () => now,
  });
  const row = await env.DB.prepare(
    "SELECT text,text_key FROM inbound_messages",
  ).first<{ text: string; text_key: string }>();
  expect(row!.text).toBe("");
  expect(row!.text_key).toMatch(/^text\//);
  const html = await (await read()).text();
  expect(html).toContain("Opening paragraph");
  expect(html).toContain("Large canonical content. ".repeat(600));
  expect(html).toContain("FINAL SENTINEL");
  expect(html).not.toContain(row!.text_key);
});

test("missing referenced body fails visibly with 503 instead of silently choosing another entry", async () => {
  await seed("old");
  await seed("missing-body", "2026-10-19T16:00:00Z", {
    textKey: `text/${"a".repeat(64)}.txt`,
  });
  const response = await read();
  expect(response.status).toBe(503);
  privateHeaders(response);
  const html = await response.text();
  expect(html).toContain("temporarily unavailable");
  expect(html).not.toContain("Body old");
  expect(html).not.toContain("text/");
});

test("hostile subject body and link attributes stay inert while safe HTTP links remain usable", async () => {
  await seed("hostile", undefined, {
    subject: '<img src=x onerror="alert(1)">',
    text: '<script>alert(2)</script>\nline two\n\nNext paragraph https://example.com/?a=1&b=2\nhttp://example.org/path javascript:alert(3) data:text/html,evil https://example.com/\"onclick=\"evil',
  });
  const html = await (await read()).text();
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
  expect(html).toContain('href="http://example.org/path"');
  expect(html).not.toMatch(/href="(?:javascript|data):/);
  expect(html).not.toContain('"onclick="');
  expect(html).toMatch(/line two<\/p>[\s\S]*<p>Next paragraph/);
  expect(html).toMatch(/alert\(2\)&lt;\/script&gt;<br\s*\/?>(?:\n)?line two/);
});

test("safe links preserve balanced URL parentheses and trim enclosing prose punctuation", async () => {
  await seed("parentheses", undefined, {
    text: "See https://en.wikipedia.org/wiki/Mission_(LDS_Church). Also (https://example.com/story). Nested https://example.com/a_(b_(c)).",
  });
  const html = await (await read()).text();
  expect(html).toContain(
    'href="https://en.wikipedia.org/wiki/Mission_(LDS_Church)"',
  );
  expect(html).toContain('href="https://example.com/story"');
  expect(html).toContain('href="https://example.com/a_(b_(c))"');
  expect(html).toContain("</a>). Nested");
});

test("long unmatched URL suffix stays outside the link without dropping canonical text", async () => {
  const suffix = ".)".repeat(10000);
  await seed("long-url-suffix", undefined, {
    text: "Read https://example.com/entry_(part)" + suffix + " End.",
  });
  const html = await (await read()).text();
  expect(html).toContain('href="https://example.com/entry_(part)"');
  expect(html).toContain(
    "https://example.com/entry_(part)</a>" + suffix + " End.",
  );
});

test("month index identifies the current entry and its toggle shares the top toolbar", async () => {
  await seed("old");
  await seed("new", "2026-10-19T16:00:00Z");
  const html = await (await read("/updates/old")).text();
  expect(html.match(/id="archive-timeline"/g)).toHaveLength(1);
  expect(html).not.toContain("<details");
  expect(html).toContain('aria-controls="archive-timeline"');
  expect(history(html)).toContain('data-year="2026" data-month="October"');
  expect(history(html)).toMatch(
    /href="\/updates\/old"[^>]*aria-current="page"/,
  );
  expect(history(html)).toContain('href="/updates/new"');
  const header = html.slice(0, html.indexOf("<article"));
  expect(header).toContain('aria-label="Update navigation"');
  expect(header).toContain(">Timeline</button>");
  expect(header).toContain('href="/">Sign up for updates</a>');
  expect(html).not.toContain("All updates");
  expect(html).not.toContain("Past updates");
  expect(navigation(html)).not.toMatch(/>First<|>Latest</);
  expect(html).toMatch(
    /<footer[^>]*>[\s\S]*href="https:\/\/github.com\/D1zzl3D0p\/simple-email-list"/,
  );
});

test("invalid passes gate every content path before any D1 or R2 read", async () => {
  const noStorage = testEnv({
    DB: {
      prepare() {
        throw Error("Newsletter read before gate");
      },
    } as unknown as D1Database,
    ARCHIVE: {
      get() {
        throw Error("Object read before gate");
      },
    } as unknown as R2Bucket,
  });
  for (const path of ["/updates", "/updates/missing"]) {
    const response = await handlePublicArchive(
      new Request(env.PUBLIC_URL + path, {
        headers: { cookie: "__Host-mission_archive=forged" },
      }),
      noStorage,
      now,
    );
    expect(response.status).toBe(200);
    privateHeaders(response);
    const html = await response.text();
    expect(html).toContain("cf-turnstile");
    expect(html).not.toContain("All updates");
  }
});

test("HEAD has matching status and headers but no body for content empty error gate and unsupported paths", async () => {
  await seed("accepted");
  await seed("broken", "2026-10-17T16:00:00Z", {
    textKey: `text/${"b".repeat(64)}.txt`,
  });
  for (const path of [
    "/updates",
    "/updates/accepted",
    "/updates/missing",
    "/updates/broken",
    "/updates/nested/path",
    "/updates/verify",
  ]) {
    const get = await read(path);
    const head = await read(path, "HEAD");
    expect(head.status).toBe(get.status);
    expect([...head.headers]).toEqual([...get.headers]);
    expect(await head.text()).toBe("");
  }
  await env.DB.prepare("DELETE FROM inbound_messages").run();
  expect(await (await read("/updates", "HEAD")).text()).toBe("");
  const gate = await handlePublicArchive(
    new Request(env.PUBLIC_URL + "/updates", { method: "HEAD" }),
    testEnv(),
    now,
  );
  expect(gate.status).toBe(200);
  expect(await gate.text()).toBe("");
});
