import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { handleAdmin } from "../src/pages";
import { prepareArchivePages } from "../src/archive";
import { configure, testEnv, now } from "./helpers";
let keys: Awaited<ReturnType<typeof generateKeyPair>>,
  jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture" }],
  });
});
beforeEach(configure);
test("dashboard reports current membership on every read", async () => {
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) VALUES('live','live@example.com','active',1,0,0,'test','v1')",
  ).run();
  const jwt = await token();
  expect(
    await (await handleAdmin(await req("/", jwt), e(), now, jwks)).text(),
  ).toContain("Active: 1");
  await env.DB.prepare(
    "UPDATE subscribers SET status='unsubscribed' WHERE id='live'",
  ).run();
  expect(
    await (await handleAdmin(await req("/", jwt), e(), now, jwks)).text(),
  ).toContain("Active: 0");
});
const e = () =>
  testEnv({
    ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
    ACCESS_AUD: "mission-audience",
  });
async function token(
  email = "missionary@example.com",
  aud = "mission-audience",
  exp = now.getTime() / 1000 + 3600,
  issuer = "https://fixture.cloudflareaccess.com",
) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setExpirationTime(exp)
    .sign(keys.privateKey);
}
async function req(path = "/", jwt?: string, host: string = env.ADMIN_HOST) {
  return new Request(`https://${host}${path}`, {
    headers: jwt ? { "cf-access-jwt-assertion": jwt } : {},
  });
}
test("missing expired wrong audience unapproved admin and alternate hosts rejected", async () => {
  for (const jwt of [
    undefined,
    await token("evil@example.com"),
    await token(undefined, "wrong"),
    await token(undefined, undefined, 1),
  ])
    expect(
      (await handleAdmin(await req("/", jwt), e(), now, jwks)).status,
    ).toBe(403);
  expect(
    (
      await handleAdmin(
        await req("/", await token(), "evil.workers.dev"),
        e(),
        now,
        jwks,
      )
    ).status,
  ).toBe(404);
});

test("admin reuses completed issuer key data while preserving identity checks and cache expiry", async () => {
  const issuer = `https://cache-${crypto.randomUUID()}.cloudflareaccess.com`;
  const settings = testEnv({
    ACCESS_ISSUER: issuer,
    ACCESS_AUD: "mission-audience",
  });
  const publicKeys = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture" }],
  };
  const outbound = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(publicKeys));
  try {
    const jwt = await token(undefined, undefined, undefined, issuer);
    for (let i = 0; i < 2; i++)
      expect(
        (await handleAdmin(await req("/", jwt), settings, now)).status,
      ).toBe(200);
    expect(outbound).toHaveBeenCalledOnce();
    expect(
      (
        await handleAdmin(
          await req(
            "/",
            await token("evil@example.com", undefined, undefined, issuer),
          ),
          settings,
          now,
        )
      ).status,
    ).toBe(403);
    expect(outbound).toHaveBeenCalledOnce();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600001);
    outbound.mockRejectedValue(Error("key service unavailable"));
    try {
      expect(
        (await handleAdmin(await req("/", jwt), settings, now)).status,
      ).toBe(403);
    } finally {
      clock.mockRestore();
    }
    expect(outbound).toHaveBeenCalledTimes(2);
  } finally {
    outbound.mockRestore();
  }
});

test("admin refreshes rotated signing keys and cannot reuse keys across issuers", async () => {
  const issuer = `https://rotation-${crypto.randomUUID()}.cloudflareaccess.com`;
  const settings = testEnv({
    ACCESS_ISSUER: issuer,
    ACCESS_AUD: "mission-audience",
  });
  const replacement = await generateKeyPair("RS256");
  let publicKeys = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture" }],
  };
  const outbound = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      String(input).startsWith(issuer + "/")
        ? Response.json(publicKeys)
        : new Response("unavailable", { status: 503 }),
    );
  try {
    expect(
      (
        await handleAdmin(
          await req("/", await token(undefined, undefined, undefined, issuer)),
          settings,
          now,
        )
      ).status,
    ).toBe(200);
    const other = issuer.replace("rotation-", "other-");
    expect(
      (
        await handleAdmin(
          await req("/", await token(undefined, undefined, undefined, other)),
          { ...settings, ACCESS_ISSUER: other },
          now,
        )
      ).status,
    ).toBe(403);
    publicKeys = {
      keys: [{ ...(await exportJWK(replacement.publicKey)), kid: "rotated" }],
    };
    const rotated = await new SignJWT({ email: "missionary@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "rotated" })
      .setIssuer(issuer)
      .setAudience("mission-audience")
      .setExpirationTime(now.getTime() / 1000 + 3600)
      .sign(replacement.privateKey);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30001);
    try {
      expect(
        (await handleAdmin(await req("/", rotated), settings, now)).status,
      ).toBe(200);
    } finally {
      clock.mockRestore();
    }
    expect(outbound).toHaveBeenCalledTimes(3);
    expect(
      (await handleAdmin(await req("/", rotated), settings, now)).status,
    ).toBe(200);
    expect(outbound).toHaveBeenCalledTimes(3);
  } finally {
    outbound.mockRestore();
  }
});
test("authenticated archive escapes hostile original body; raw is download only", async () => {
  await env.DB.prepare(
    "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,received_at,run_id) VALUES('i','broadcast','raw/test','hash','missionary@example.com','f','<script>','<img onerror=bad()>',0,'r')",
  ).run();
  await env.ARCHIVE.put("raw/test", "<html>hostile</html>");
  const jwt = await token();
  const html = await handleAdmin(await req("/archive/i", jwt), e(), now, jwks);
  expect(html.status).toBe(200);
  expect(await html.text()).toContain("&lt;img");
  const raw = await handleAdmin(await req("/raw/i", jwt), e(), now, jwks);
  expect(raw.headers.get("content-disposition")).toContain("attachment");
  expect(raw.headers.get("content-type")).toBe("application/octet-stream");
});
test("dashboard bounds subject previews while the archive retains the complete subject", async () => {
  const prefix = "🏔<&".repeat(40);
  const subject = prefix + "PRIVATE SUBJECT END".repeat(700);
  await env.DB.prepare(
    "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,received_at,run_id) VALUES('long-subject','broadcast','raw/long','hash','missionary@example.com','long',?,'Complete body',0,'r')",
  )
    .bind(subject)
    .run();
  const jwt = await token();
  const dashboard = await handleAdmin(await req("/", jwt), e(), now, jwks);
  const html = await dashboard.text();
  expect(html).toContain('href="/archive/long-subject"');
  expect(html).toContain("🏔&lt;&amp;".repeat(40) + "…</a>");
  expect(html).not.toContain("PRIVATE SUBJECT END");
  const archive = await handleAdmin(
    await req("/archive/long-subject", jwt),
    e(),
    now,
    jwks,
  );
  expect(await archive.text()).toContain("PRIVATE SUBJECT END".repeat(700));
  expect(
    await env.DB.prepare(
      "SELECT subject FROM inbound_messages WHERE id='long-subject'",
    ).first("subject"),
  ).toBe(subject);
});
test("dashboard previews incident details and links to the complete authenticated record", async () => {
  const detail = "<&>".repeat(40) + "Full incident tail";
  const row = await env.DB.prepare(
    "INSERT INTO incidents(source_key,code,detail,affected,created_at) VALUES('preview','fixture',?,7,0) RETURNING id",
  )
    .bind(detail)
    .first<{ id: number }>();
  const jwt = await token();
  const response = await handleAdmin(await req("/", jwt), e(), now, jwks);
  const html = await response.text();
  expect(html).toContain(`/incidents/${row!.id}`);
  expect(html).not.toContain("Full incident tail");
  expect(html).toContain("&lt;&amp;&gt;".repeat(40) + "…");
  expect(
    (await handleAdmin(await req(`/incidents/${row!.id}`), e(), now, jwks))
      .status,
  ).toBe(403);
  const full = await handleAdmin(
    await req(`/incidents/${row!.id}`, jwt),
    e(),
    now,
    jwks,
  );
  expect(full.status).toBe(200);
  expect(await full.text()).toContain(
    "&lt;&amp;&gt;".repeat(40) + "Full incident tail",
  );
});
test("dashboard pages through all messages and incidents with bounded lists", async () => {
  for (let i = 0; i < 21; i++)
    await env.DB.prepare(
      "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,received_at,run_id) VALUES(?,'broadcast','raw/list',?,'missionary@example.com',?,'Week','Body',?,'r')",
    )
      .bind(`list-${i}`, `hash-${i}`, `f-${i}`, i)
      .run();
  for (let i = 0; i < 11; i++)
    await env.DB.prepare(
      "INSERT INTO incidents(source_key,code,detail,created_at) VALUES(?,?,?,0)",
    )
      .bind(`list-${i}`, `code-${i}`, `detail-${i}`)
      .run();
  const jwt = await token();
  const first = await (
    await handleAdmin(await req("/", jwt), e(), now, jwks)
  ).text();
  expect(first).toContain('href="/archive/list-20"');
  expect(first).not.toContain('href="/archive/list-0"');
  expect(first).not.toContain("detail-0</li>");
  expect(first).toContain("inboxPage=1");
  expect(first).toContain("incidentPage=1");
  const second = await (
    await handleAdmin(
      await req("/?inboxPage=1&incidentPage=1", jwt),
      e(),
      now,
      jwks,
    )
  ).text();
  expect(second).toContain('href="/archive/list-0"');
  expect(second).not.toContain('href="/archive/list-20"');
  expect(second).toContain("detail-0</li>");
  expect(second).not.toContain("detail-10</li>");
  expect(
    (await handleAdmin(await req("/?inboxPage=-1", jwt), e(), now, jwks))
      .status,
  ).toBe(400);
});
test("private referenced body is rendered only after admin authorization", async () => {
  const bodyKey = `text/${"a".repeat(64)}.txt`;
  await env.ARCHIVE.put(bodyKey, "Private <img onerror=bad()> José");
  await env.DB.prepare(
    "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,text_key,received_at,run_id) VALUES('private','broadcast','raw/private','hash','missionary@example.com','f','Week','',?,0,'r')",
  )
    .bind(bodyKey)
    .run();
  const denied = await handleAdmin(
    await req("/archive/private"),
    e(),
    now,
    jwks,
  );
  expect(denied.status).toBe(403);
  const allowed = await handleAdmin(
    await req("/archive/private", await token()),
    e(),
    now,
    jwks,
  );
  expect(allowed.status).toBe(200);
  const text = await allowed.text();
  expect(text).toContain("Private &lt;img onerror=bad()&gt; José");
});

test("prepared private archives preserve complete content and never read objects before authorization", async () => {
  const subject = "<subject> &".repeat(1500);
  const body = "Private José <script>bad()</script> &lt; 🏔".repeat(1000);
  await env.DB.prepare(
    "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,received_at,run_id) VALUES('prepared:one','broadcast','raw/private','hash','missionary@example.com','p',?,?,0,'r')",
  )
    .bind(subject, body)
    .run();
  await prepareArchivePages(e());
  const get = vi.spyOn(env.ARCHIVE, "get");
  try {
    expect(
      (await handleAdmin(await req("/archive/prepared%3Aone"), e(), now, jwks))
        .status,
    ).toBe(403);
    expect(get).not.toHaveBeenCalled();
    const response = await handleAdmin(
      await req("/archive/prepared%3Aone", await token()),
      e(),
      now,
      jwks,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await response.text();
    expect(html).toContain("&lt;subject&gt; &amp;".repeat(1500));
    expect(html).toContain(
      "Private José &lt;script&gt;bad()&lt;/script&gt; &amp;lt; 🏔".repeat(1000),
    );
    expect(html).toContain("/raw/prepared%3Aone");
    expect(get).toHaveBeenCalledOnce();
    const key = await env.DB.prepare(
      "SELECT archive_key FROM inbound_messages",
    ).first<string>("archive_key");
    await env.ARCHIVE.delete(key!);
    expect(
      (
        await handleAdmin(
          await req("/archive/prepared%3Aone", await token()),
          e(),
          now,
          jwks,
        )
      ).status,
    ).toBe(503);
  } finally {
    get.mockRestore();
  }
});

test("large archive preserves every text character without interpreting markup or entities", async () => {
  const body =
    "&<>\"' José 🏔️\n&lt;script&gt; &#39; </pre><script>bad()</script>\n".repeat(
      12000,
    );
  const bodyKey = `text/${"c".repeat(64)}.txt`;
  await env.ARCHIVE.put(bodyKey, body);
  await env.DB.prepare(
    "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,text_key,received_at,run_id) VALUES('heavy','broadcast','raw/heavy','hash','missionary@example.com','heavy','<script>','',?,0,'r')",
  )
    .bind(bodyKey)
    .run();
  const response = await handleAdmin(
    await req("/archive/heavy", await token()),
    e(),
    now,
    jwks,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const html = await response.text();
  expect(html).not.toContain("<script>");
  const encoded = html.match(/<pre(?: [^>]*)?>([\s\S]*)<\/pre>/)![1];
  // Decode only the entities used by HTML text escaping, ampersand last to
  // avoid recursively interpreting literal entity strings from the original.
  const decoded = encoded
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
  expect(decoded).toBe(body);
});

test("archive native stream preserves split UTF-8 and propagates a late object read failure", async () => {
  const bodyKey = `text/${"d".repeat(64)}.txt`;
  await env.DB.prepare(
    "INSERT INTO inbound_messages(id,role,raw_key,raw_hash,sender,fingerprint,subject,text,text_key,received_at,run_id) VALUES('stream','broadcast','raw/stream','hash','missionary@example.com','stream','Week','',?,0,'r')",
  )
    .bind(bodyKey)
    .run();
  const text = "José 🏔️ &</pre><script>bad()</script> &lt;";
  const bytes = new TextEncoder().encode(text);
  const jwt = await token();
  for (const fail of [false, true]) {
    let offset = 0;
    const archive = {
      get: async () => ({
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === bytes.length) {
              if (fail) controller.error(Error("private object interrupted"));
              else controller.close();
            } else controller.enqueue(bytes.slice(offset, ++offset));
          },
        }),
      }),
    } as unknown as R2Bucket;
    const response = await handleAdmin(
      await req("/archive/stream", jwt),
      { ...e(), ARCHIVE: archive },
      now,
      jwks,
    );
    if (fail)
      await expect(response.text()).rejects.toThrow(
        "private object interrupted",
      );
    else {
      const html = await response.text();
      expect(html).toContain(
        "José 🏔️ &amp;&lt;/pre&gt;&lt;script&gt;bad()&lt;/script&gt; &amp;lt;",
      );
      expect(html).not.toContain("<script>");
    }
  }
});
