import { env } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { handleSignup } from "../src/signup";
import { testEnv, now } from "./helpers";
afterEach(() => vi.unstubAllGlobals());
const request = (email = "friend@example.com", token = "good", website = "") =>
  new Request(env.PUBLIC_URL + "/subscribe", {
    method: "POST",
    body: new URLSearchParams({
      email,
      "cf-turnstile-response": token,
      website,
    }),
  });
function challenge(
  data: object = {
    success: true,
    hostname: "mission.example.com",
    action: "subscribe",
  },
) {
  vi.stubGlobal("fetch", async () => Response.json(data));
}
test("valid immediate activation without welcome mail", async () => {
  challenge();
  expect((await handleSignup(request(), testEnv(), now)).status).toBe(200);
  expect(
    await env.DB.prepare("SELECT status FROM subscribers").first("status"),
  ).toBe("active");
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(0);
});
test.each([
  "bad",
  "a@",
  "a b@example.com",
  "a@example",
  "a..b@example.com",
  "a@example.com\r\nBcc:x@y.com",
])("reject malformed %s", async (email) => {
  challenge();
  expect((await handleSignup(request(email), testEnv(), now)).status).toBe(400);
});
test.each([
  { success: false, "error-codes": ["timeout-or-duplicate"] },
  { success: true, hostname: "evil.example", action: "subscribe" },
  { success: true, hostname: "mission.example.com", action: "login" },
])("invalid expired reused wrong-host/action token rejected", async (data) => {
  challenge(data);
  const r = await handleSignup(request(), testEnv(), now);
  expect(r.status).toBe(400);
  expect(await r.text()).toContain("friend@example.com");
  expect(
    await env.DB.prepare("SELECT count(*) FROM subscribers").first("count(*)"),
  ).toBe(0);
});
test("missing challenge, honeypot and oversized requests rejected", async () => {
  challenge();
  for (const r of [
    request("a@example.com", ""),
    request("a@example.com", "good", "bot"),
    request("a".repeat(9000)),
  ])
    expect((await handleSignup(r, testEnv(), now)).status).toBe(400);
});
test("validation outage returns retry error", async () => {
  vi.stubGlobal("fetch", async () => {
    throw Error("offline");
  });
  const r = await handleSignup(request(), testEnv(), now);
  expect(r.status).toBe(503);
  expect(await r.text()).toMatch(/retry/i);
});
test("D1 failure never reports successful signup", async () => {
  challenge();
  const db = new Proxy(env.DB, {
    get(t, k) {
      if (k === "batch")
        return async () => {
          throw Error("offline");
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  expect((await handleSignup(request(), testEnv({ DB: db }), now)).status).toBe(
    503,
  );
});
test("six hundred valid signups on one shared network succeed", async () => {
  challenge();
  for (let i = 0; i < 600; i++) {
    const r = request(`a${i}@example.com`, `token${i}`);
    r.headers.set("cf-connecting-ip", "192.0.2.1");
    expect((await handleSignup(r, testEnv(), now)).status).toBe(200);
  }
  expect(
    await env.DB.prepare("SELECT count(*) FROM subscribers").first("count(*)"),
  ).toBe(600);
  expect(
    await env.DB.prepare("SELECT count(*) FROM outbox").first("count(*)"),
  ).toBe(0);
});
