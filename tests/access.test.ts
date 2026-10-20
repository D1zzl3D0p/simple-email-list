import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { handleAdmin } from "../src/pages";
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
const e = () =>
  testEnv({
    ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
    ACCESS_AUD: "mission-audience",
  });
async function token(
  email = "missionary@example.com",
  aud = "mission-audience",
  exp = now.getTime() / 1000 + 3600,
) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer("https://fixture.cloudflareaccess.com")
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
