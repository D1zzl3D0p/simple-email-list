import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  capability,
  handleUnsubscribe,
  handleResubscribe,
  newsletterContent,
} from "../src/unsubscribe";
import { testEnv, now } from "./helpers";
async function seed() {
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) VALUES('opaque','a@example.com','active',7,0,0,'test','v1')",
  ).run();
  return capability(testEnv(), "leave", "opaque", 7);
}
function req(token: string, method = "POST", path = "unsubscribe") {
  return new Request(
    env.PUBLIC_URL + "/" + path + "?token=" + encodeURIComponent(token),
    { method },
  );
}
test("reconstructable capability: GET never changes state, POST leaves, undo restores", async () => {
  const t = await seed();
  expect(t).not.toContain("example.com");
  expect((await handleUnsubscribe(req(t, "GET"), testEnv(), now)).status).toBe(
    200,
  );
  expect(
    await env.DB.prepare("SELECT status FROM subscribers").first("status"),
  ).toBe("active");
  const r = await handleUnsubscribe(req(t), testEnv(), now);
  expect(await r.text()).toContain("Undo");
  expect(
    await env.DB.prepare("SELECT status FROM subscribers").first("status"),
  ).toBe("unsubscribed");
  const undo = await capability(testEnv(), "undo", "opaque", 7);
  await handleResubscribe(req(undo, "POST", "resubscribe"), testEnv(), now);
  expect(
    await env.DB.prepare("SELECT generation FROM subscribers").first(
      "generation",
    ),
  ).toBe(8);
  await handleUnsubscribe(req(t), testEnv(), now);
  expect(
    await env.DB.prepare("SELECT status FROM subscribers").first("status"),
  ).toBe("active");
});
test("undo replay cannot reverse subsequent unsubscribe or clear suppressions", async () => {
  const t = await seed();
  await env.DB.prepare(
    "INSERT INTO suppressions VALUES('a@example.com','complaint',0)",
  ).run();
  await handleUnsubscribe(req(t), testEnv(), now);
  const u = await capability(testEnv(), "undo", "opaque", 7);
  await handleResubscribe(req(u, "POST", "resubscribe"), testEnv(), now);
  await handleUnsubscribe(
    req(await capability(testEnv(), "leave", "opaque", 8)),
    testEnv(),
    now,
  );
  await handleResubscribe(req(u, "POST", "resubscribe"), testEnv(), now);
  expect(
    await env.DB.prepare("SELECT status FROM subscribers").first("status"),
  ).toBe("unsubscribed");
  expect(
    await env.DB.prepare("SELECT reason FROM suppressions").first("reason"),
  ).toBe("complaint");
});
test("wrong purpose, tampering and method cannot mutate membership", async () => {
  const t = await seed();
  for (const token of [
    t + "x",
    await capability(testEnv(), "undo", "opaque", 7),
  ])
    expect((await handleUnsubscribe(req(token), testEnv(), now)).status).toBe(
      400,
    );
  expect(
    (
      await handleResubscribe(
        req(
          await capability(testEnv(), "undo", "opaque", 7),
          "GET",
          "resubscribe",
        ),
        testEnv(),
        now,
      )
    ).status,
  ).toBe(405);
});
test("newsletter without an album omits Photos but preserves subscribe and leave links", () => {
  const content = newsletterContent(
    "Hello",
    "",
    "https://mission.example.com",
    "https://mission.example.com/unsubscribe?token=test",
  );
  expect(content.text).not.toContain("Photos:");
  expect(content.html).not.toContain("Google Photos album");
  expect(content.html).not.toContain('href=""');
  expect(content.text).toContain(
    "Share / subscribe: https://mission.example.com",
  );
  expect(content.html).toContain("Unsubscribe");
});

test("share link is public and separate from personal unsubscribe", async () => {
  const t = await seed();
  const c = newsletterContent(
    "Hello <reader>",
    "https://photos.google.com/album",
    env.PUBLIC_URL,
    env.PUBLIC_URL + "/unsubscribe?token=" + t,
  );
  expect(c.text).toContain("Share / subscribe: https://mission.example.com");
  expect(c.text).toContain("\n\nUnsubscribe:");
  expect(c.html).toContain("&lt;reader&gt;");
  expect(c.html).not.toContain("<reader>");
});
