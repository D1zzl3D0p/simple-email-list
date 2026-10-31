import { afterEach, expect, test, vi } from "vitest";
import { archiveAccess, archiveHeaders } from "../src/archive-access";
import type { Env } from "../src/types";
import { testEnv } from "./helpers";

const now = new Date("2026-10-28T12:00:00.000Z");
const host = "mission.example.com";
const url = `https://${host}`;
const cookieName = "__Host-mission_archive";

afterEach(() => vi.unstubAllGlobals());

function isolatedEnv(extra: Partial<Env> = {}): Env {
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw Error("Unexpected storage access");
      },
    },
  );
  return testEnv({
    DB: forbidden as D1Database,
    ARCHIVE: forbidden as R2Bucket,
    ...extra,
  });
}

function read(path = "/updates", cookie = "", method = "GET") {
  return new Request(url + path, { method, headers: { cookie } });
}

function verify(target = "/updates/mail%3A123", token = "valid-token") {
  return new Request(url + "/updates/verify", {
    method: "POST",
    body: new URLSearchParams({
      return: target,
      "cf-turnstile-response": token,
    }),
  });
}

function provider(
  data: unknown = { success: true, hostname: host, action: "archive" },
) {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      );
      expect(init?.method).toBe("POST");
      expect(
        new URLSearchParams(init?.body as URLSearchParams).get("secret"),
      ).toBe("test");
      expect(
        new URLSearchParams(init?.body as URLSearchParams).get("response"),
      ).toBe("valid-token");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(data);
    },
  );
}

function privateResponse(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
}

async function pass(env = isolatedEnv()) {
  provider();
  const response = (await archiveAccess(verify(), env, now))!;
  expect(response.status).toBe(303);
  return response.headers.get("Set-Cookie")!.split(";")[0];
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function signedFixture(changes: Record<string, unknown>) {
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        purpose: "mission-archive",
        host,
        issuedAt: now.getTime(),
        expiresAt: now.getTime() + 86400000,
        ...changes,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(isolatedEnv().CAPABILITY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`mission-archive:v1:${payload}`),
  );
  return `${cookieName}=${payload}.${base64url(new Uint8Array(signature))}`;
}

test("unverified reader requests show an escaped archive challenge without storage access", async () => {
  const response = (await archiveAccess(
    read("/updates/mail%3A123"),
    isolatedEnv({ TURNSTILE_SITE_KEY: '\"><script>bad()</script>' }),
    now,
  ))!;
  privateResponse(response);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('action="/updates/verify"');
  expect(body).toContain('data-action="archive"');
  expect(body).toContain('name="return" value="/updates/mail%3A123"');
  expect(body).toContain("&quot;&gt;&lt;script&gt;");
  expect(body).not.toContain("<script>bad()");
  expect(body).not.toContain("All updates");
  expect(body).not.toContain("<article");
});

test("successful server validation redirects locally with a host-only secure fixed-duration cookie", async () => {
  provider();
  const request = verify();
  request.headers.set("Host", "attacker.example");
  request.headers.set("X-Forwarded-Host", "attacker.example");
  const response = (await archiveAccess(request, isolatedEnv(), now))!;
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe("/updates/mail%3A123");
  expect(response.headers.get("Set-Cookie")).toMatch(
    /^__Host-mission_archive=[A-Za-z0-9_.-]+; Path=\/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax$/,
  );
  expect(response.headers.get("Set-Cookie")).not.toContain("Domain=");
  privateResponse(response);
});

test("a pass authorizes only reader GET and HEAD until exactly 24 hours after issuance", async () => {
  const cookie = await pass();
  for (const path of ["/updates", "/updates/", "/updates/mail%3A123"])
    for (const method of ["GET", "HEAD"])
      expect(
        await archiveAccess(
          read(path, cookie, method),
          isolatedEnv(),
          new Date(now.getTime() + 86399999),
        ),
      ).toBeNull();
  const expired = (await archiveAccess(
    read("/updates", cookie),
    isolatedEnv(),
    new Date(now.getTime() + 86400000),
  ))!;
  expect(await expired.text()).toContain('data-action="archive"');
  expect(expired.headers.get("Set-Cookie")).toBeNull();
});

test("tampering, wrong secrets, malformed cookies, and duplicate cookies cannot authorize content", async () => {
  const cookie = await pass();
  const [name, token] = cookie.split("=");
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = token.at(-1)!;
  const noncanonical =
    cookie.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1];
  const cookies = [
    noncanonical,
    cookie.slice(0, -5) + "AAAAA",
    `${name}=${token.split(".")[0]}.broken`,
    `${name}=invalid`,
    `${cookie}; ${cookie}`,
    `${name}=${"x".repeat(9000)}`,
  ];
  for (const candidate of cookies) {
    const response = (await archiveAccess(
      read("/updates", candidate),
      isolatedEnv(),
      now,
    ))!;
    expect(response).toBeInstanceOf(Response);
    privateResponse(response);
    expect(await response.text()).toContain('data-action="archive"');
  }
  expect(
    await archiveAccess(
      read("/updates", cookie),
      isolatedEnv({ CAPABILITY_SECRET: "another-secret" }),
      now,
    ),
  ).toBeInstanceOf(Response);
});

test("even correctly signed passes reject another purpose or host, future issuance, and extended expiry", async () => {
  for (const changes of [
    { purpose: "unsubscribe" },
    { host: "other.example" },
    { issuedAt: now.getTime() + 1 },
    { expiresAt: now.getTime() + 86400001 },
    { expiresAt: now.getTime() },
    { issuedAt: "today" },
  ]) {
    expect(
      await archiveAccess(
        read("/updates", await signedFixture(changes)),
        isolatedEnv(),
        now,
      ),
    ).toBeInstanceOf(Response);
  }
  expect(
    await archiveAccess(
      new Request("https://other.example/updates", {
        headers: { cookie: await pass() },
      }),
      isolatedEnv(),
      now,
    ),
  ).toBeInstanceOf(Response);
});

test("failed or reused challenge tokens and incorrect provider hostname or action fail closed", async () => {
  for (const data of [
    { success: false, "error-codes": ["timeout-or-duplicate"] },
    { success: true, hostname: "attacker.example", action: "archive" },
    { success: true, hostname: host, action: "subscribe" },
    { success: "yes", hostname: host, action: "archive" },
    null,
  ]) {
    provider(data);
    const response = (await archiveAccess(verify(), isolatedEnv(), now))!;
    expect(response.status).toBe(400);
    privateResponse(response);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.text()).toContain("retry");
  }
});

test("provider errors, malformed replies, and aborts offer a retry without a pass", async () => {
  for (const fetcher of [
    async () => {
      throw Error("outage");
    },
    async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
    async () => new Response("bad", { status: 503 }),
    async () => new Response("not-json"),
  ]) {
    vi.stubGlobal("fetch", fetcher);
    const response = (await archiveAccess(verify(), isolatedEnv(), now))!;
    expect(response.status).toBe(503);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    privateResponse(response);
    expect(await response.text()).toContain("retry");
  }
});

test("verification rejects missing or oversized tokens, duplicate fields and unsupported content types before provider access", async () => {
  vi.stubGlobal("fetch", () => {
    throw Error("Unexpected validation access");
  });
  const requests = [
    verify("/updates", ""),
    verify("/updates", "x".repeat(2049)),
    new Request(url + "/updates/verify", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    }),
    new Request(url + "/updates/verify", {
      method: "POST",
      body: new URLSearchParams([
        ["cf-turnstile-response", "valid-token"],
        ["cf-turnstile-response", "another"],
      ]),
    }),
  ];
  for (const request of requests) {
    const response = (await archiveAccess(request, isolatedEnv(), now))!;
    expect(response.status).toBe(400);
    privateResponse(response);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  }
});

test("verification bounds actual streamed body bytes regardless of caller length claims", async () => {
  let cancelled = false;
  vi.stubGlobal("fetch", () => {
    throw Error("Unexpected validation access");
  });
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(9000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = (await archiveAccess(
    new Request(url + "/updates/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": "1",
      },
      body,
    }),
    isolatedEnv(),
    now,
  ))!;
  expect(response.status).toBe(400);
  expect(cancelled).toBe(true);
  privateResponse(response);
});

test("verification refuses unsafe and non-reader return targets", async () => {
  vi.stubGlobal("fetch", () => {
    throw Error("Unexpected validation access");
  });
  for (const target of [
    "https://attacker.example/updates",
    "//attacker.example/updates",
    "/admin",
    "/updates/verify",
    "/updates/a/b",
    "/updates/a%2fb",
    "/updates/a%5cb",
    "/updates/%2e%2e",
    "/updates/a?next=//attacker.example",
    "/updates/a#fragment",
    "/updates\\attacker.example",
    "/updates/%zz",
  ]) {
    const response = (await archiveAccess(verify(target), isolatedEnv(), now))!;
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    privateResponse(response);
  }
});

test("verification rejects raw Unicode return targets before constructing a Location header", async () => {
  provider();
  const response = (await archiveAccess(
    verify("/updates/東京"),
    isolatedEnv(),
    now,
  ))!;
  expect(response.status).toBe(400);
  expect(response.headers.get("Location")).toBeNull();
  expect(response.headers.get("Set-Cookie")).toBeNull();
  privateResponse(response);
});

test("only POST verifies and reader requests support GET and HEAD with empty HEAD responses", async () => {
  for (const [path, method, status] of [
    ["/updates/verify", "GET", 405],
    ["/updates/verify", "HEAD", 405],
    ["/updates", "POST", 405],
    ["/updates/id", "DELETE", 405],
    ["/updates/id/extra", "GET", 404],
  ] as const) {
    const response = (await archiveAccess(
      read(path, "", method),
      isolatedEnv(),
      now,
    ))!;
    expect(response.status).toBe(status);
    privateResponse(response);
    if (status === 405)
      expect(response.headers.get("Allow")).toBe(
        path === "/updates/verify" ? "POST" : "GET, HEAD",
      );
    if (method === "HEAD") expect(await response.text()).toBe("");
  }
  const response = (await archiveAccess(
    read("/updates", "", "HEAD"),
    isolatedEnv(),
    now,
  ))!;
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("");
  privateResponse(response);
  expect(archiveHeaders()).toEqual({
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
});
