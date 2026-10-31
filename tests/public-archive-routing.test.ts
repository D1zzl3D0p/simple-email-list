import { env } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import worker from "../src/index";
import { testEnv } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

function routeEnv() {
  return testEnv({
    ASSETS: {
      fetch: async (request: Request) =>
        new Response(
          new URL(request.url).pathname === "/styles.css"
            ? "fixture stylesheet"
            : "asset not found",
          {
            status: new URL(request.url).pathname === "/styles.css" ? 200 : 404,
          },
        ),
    } as Fetcher,
  });
}

function request(path: string, init?: RequestInit) {
  return new Request(env.PUBLIC_URL + path, init);
}

function privateHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

async function seed() {
  await env.DB.prepare(
    `INSERT INTO inbound_messages
    (id,role,raw_key,raw_hash,sender,fingerprint,subject,text,received_at,state,run_id)
    VALUES ('mail:earlier','broadcast','raw/private','routing-hash','sender@example.com','routing-fingerprint','Earlier letter','Earlier canonical body',1,'pending','fixture')`,
  ).run();
  await env.ARCHIVE.put("raw/private", "PRIVATE RAW MIME");
}

async function verify(target = "/updates/mail%3Aearlier") {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      success: true,
      hostname: new URL(env.PUBLIC_URL).hostname,
      action: "archive",
    }),
  );
  const response = await worker.fetch(
    request("/updates/verify", {
      method: "POST",
      body: new URLSearchParams({
        return: target,
        "cf-turnstile-response": "fixture",
      }),
    }),
    routeEnv(),
  );
  expect(response.status).toBe(303);
  return response;
}

test("robots exclusion is served by the public Worker before asset fallback", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(
      request("/robots.txt", { method }),
      routeEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(
      method === "HEAD" ? "" : "User-agent: *\nDisallow: /\n",
    );
  }
  const unsupported = await worker.fetch(
    request("/robots.txt", { method: "POST" }),
    routeEnv(),
  );
  expect(unsupported.status).toBe(405);
  expect(unsupported.headers.get("allow")).toBe("GET, HEAD");
});

test("Archive remains available on open disabled and successful signup pages", async () => {
  const open = await worker.fetch(request("/"), routeEnv());
  expect(await open.text()).toMatch(/href="\/updates"[^>]*>Archive<\/a>/);
  const disabled = await worker.fetch(
    request("/"),
    testEnv({ STAGE: "production", SIGNUP_ENABLED: "false" }),
  );
  expect(await disabled.text()).toMatch(/href="\/updates"[^>]*>Archive<\/a>/);
  vi.stubGlobal("fetch", async () =>
    Response.json({
      success: true,
      hostname: new URL(env.PUBLIC_URL).hostname,
      action: "subscribe",
    }),
  );
  const success = await worker.fetch(
    request("/subscribe", {
      method: "POST",
      body: new URLSearchParams({
        email: "reader@example.com",
        "cf-turnstile-response": "fixture",
      }),
    }),
    testEnv({ SENDING_ENABLED: "false", STAGE: "test" }),
  );
  expect(success.status).toBe(200);
  const html = await success.text();
  expect(html).toContain("You’re on the list.");
  expect(html).toMatch(/href="\/updates"[^>]*>Archive<\/a>/);
});

test("unverified reader GET and HEAD gate content and history before storage or assets", async () => {
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw Error("Storage or asset access before verification");
      },
    },
  );
  const e = testEnv({
    DB: forbidden as D1Database,
    ARCHIVE: forbidden as R2Bucket,
    ASSETS: forbidden as Fetcher,
  });
  for (const path of ["/updates", "/updates/", "/updates/mail%3Aearlier"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(request(path, { method }), e);
      expect(response.status).toBe(200);
      privateHeaders(response);
      const html = await response.text();
      if (method === "HEAD") expect(html).toBe("");
      else {
        expect(html).toContain('action="/updates/verify"');
        expect(html).not.toContain("Earlier letter");
        expect(html).not.toContain("Earlier canonical body");
        expect(html).not.toContain("archive-date-list");
      }
    }
  }
});

test("a verified permanent link resumes the selected letter through the public entrypoint", async () => {
  await seed();
  const redirect = await verify();
  expect(redirect.status).toBe(303);
  expect(redirect.headers.get("location")).toBe("/updates/mail%3Aearlier");
  privateHeaders(redirect);
  const cookie = redirect.headers.get("set-cookie")!.split(";")[0];
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(
      request(redirect.headers.get("location")!, {
        method,
        headers: { cookie },
      }),
      routeEnv(),
    );
    expect(response.status).toBe(200);
    privateHeaders(response);
    const html = await response.text();
    if (method === "HEAD") expect(html).toBe("");
    else {
      expect(html).toContain("Earlier letter");
      expect(html).toContain("Earlier canonical body");
      expect(html).not.toContain("PRIVATE RAW MIME");
      expect(html).not.toContain('href="/raw/');
      expect(html).not.toContain("sender@example.com");
    }
  }
});

test("all nested update paths stay reserved and unsupported methods retain private headers", async () => {
  const e = testEnv({
    ASSETS: {
      fetch() {
        throw Error("Archive namespace reached assets");
      },
    } as unknown as Fetcher,
  });
  for (const [path, method, status, allow] of [
    ["/updates/nested/asset.html", "GET", 404, null],
    ["/updates/nested/asset.html", "HEAD", 404, null],
    ["/updates/%zz", "GET", 404, null],
    ["/updates", "POST", 405, "GET, HEAD"],
    ["/updates/mail%3Aearlier", "DELETE", 405, "GET, HEAD"],
    ["/updates/verify", "GET", 405, "POST"],
    ["/updates/verify", "HEAD", 405, "POST"],
  ] as const) {
    const response = await worker.fetch(request(path, { method }), e);
    expect(response.status).toBe(status);
    expect(response.headers.get("allow")).toBe(allow);
    privateHeaders(response);
    if (method === "HEAD") expect(await response.text()).toBe("");
  }
});

test("authorized missing and unavailable letters remain private error responses", async () => {
  const redirect = await verify("/updates");
  const cookie = redirect.headers.get("set-cookie")!.split(";")[0];
  const missing = await worker.fetch(
    request("/updates/missing", { headers: { cookie } }),
    routeEnv(),
  );
  expect(missing.status).toBe(404);
  privateHeaders(missing);
  await seed();
  await env.DB.prepare(
    "UPDATE inbound_messages SET text_key='text/missing',text='' WHERE id='mail:earlier'",
  ).run();
  const unavailable = await worker.fetch(
    request("/updates", { headers: { cookie } }),
    routeEnv(),
  );
  expect(unavailable.status).toBe(503);
  privateHeaders(unavailable);
});

test("admin host keeps Access authorization and public or unknown hosts never expose private routes", async () => {
  await seed();
  const redirect = await verify();
  const cookie = redirect.headers.get("set-cookie")!.split(";")[0];
  for (const path of [
    "/",
    "/updates",
    "/updates/verify",
    "/robots.txt",
    "/archive/mail%3Aearlier",
    "/raw/mail%3Aearlier",
  ]) {
    const response = await worker.fetch(
      new Request(`https://${env.ADMIN_HOST}${path}`, { headers: { cookie } }),
      routeEnv(),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Access denied");
  }
  for (const host of [env.PUBLIC_URL, "https://unknown.example"]) {
    for (const path of ["/archive/mail%3Aearlier", "/raw/mail%3Aearlier"]) {
      const response = await worker.fetch(
        new Request(host + path, { headers: { cookie } }),
        routeEnv(),
      );
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain("Earlier canonical body");
      expect(body).not.toContain("PRIVATE RAW MIME");
    }
  }
});

test("ordinary assets remain accessible without a pass and namespace lookalikes use normal fallback", async () => {
  const css = await worker.fetch(request("/styles.css"), routeEnv());
  expect(css.status).toBe(200);
  expect(await css.text()).toBe("fixture stylesheet");
  const lookalike = await worker.fetch(request("/updates-other"), routeEnv());
  expect(lookalike.status).toBe(404);
  expect(await lookalike.text()).toBe("asset not found");
});
