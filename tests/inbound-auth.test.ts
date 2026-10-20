import { expect, test } from "vitest";
import { createPublicKey } from "node:crypto";
import fixtures from "./fixtures/dkim.json";
import key from "./fixtures/sns-test-key.pem?raw";
import { authenticateDkim, type TxtResolver } from "../src/inbound-auth";

const now = new Date("2026-10-19T23:00:00Z");
const sender = "missionary@example.com";
const rr =
  "v=DKIM1; k=rsa; p=" +
  createPublicKey(key)
    .export({ type: "spki", format: "der" })
    .toString("base64");
const resolver: TxtResolver = async (name, type) => {
  expect(type).toBe("TXT");
  expect(name).toBe("fixture._domainkey.example.com");
  return [[rr]];
};
const { valid, unsigned } = fixtures;
test("real aligned DKIM authenticates the visible approved sender", async () => {
  expect(
    await authenticateDkim(new TextEncoder().encode(valid), sender, {
      resolver,
      now,
    }),
  ).toBe(true);
});
test("a forged receiver pass on unsigned mail grants no authority", async () => {
  const raw =
    "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.com\r\n" +
    unsigned;
  expect(
    await authenticateDkim(new TextEncoder().encode(raw), sender, {
      resolver,
      now,
    }),
  ).toBe(false);
});
test.each([
  "partialBody",
  "unrelatedDomain",
  "unsignedSubject",
  "unsignedEncoding",
  "sha1",
  "multipleFrom",
  "missingMessageId",
  "emptyMessageId",
] as const)("reject cryptographically signed but unsafe %s", async (name) => {
  expect(
    await authenticateDkim(new TextEncoder().encode(fixtures[name]), sender, {
      resolver: async () => [[rr]],
      now,
    }),
  ).toBe(false);
});
test.each([
  valid.replace("signed content", "changed content"),
  valid.replace("Week one", "Arbitrary replacement subject"),
  valid.replace("missionary@example.com", "owner@example.com"),
  "From: owner@example.com\r\n" + valid,
  "Subject: Injected subject\r\n" + valid,
  "Content-Type: text/html\r\n" + valid,
])("reject tampering or ambiguous header fields", async (raw) => {
  expect(
    await authenticateDkim(new TextEncoder().encode(raw), sender, {
      resolver,
      now,
    }),
  ).toBe(false);
});
test("untrusted pass assertions neither grant authority nor invalidate a genuine signature", async () => {
  const forged =
    "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=evil.example\r\n";
  expect(
    await authenticateDkim(new TextEncoder().encode(forged + valid), sender, {
      resolver,
      now,
    }),
  ).toBe(true);
  expect(
    await authenticateDkim(
      new TextEncoder().encode(
        forged + valid.replace("signed content", "tampered content"),
      ),
      sender,
      { resolver, now },
    ),
  ).toBe(false);
});
test("signed To/Cc bind the deliberate receiving role and prevent cross-address replay", async () => {
  const raw = new TextEncoder().encode(valid);
  expect(
    await authenticateDkim(raw, sender, {
      resolver,
      now,
      destination: "update@in.example.com",
    }),
  ).toBe(true);
  expect(
    await authenticateDkim(raw, sender, {
      resolver,
      now,
      destination: "manage@in.example.com",
    }),
  ).toBe(false);
  expect(
    await authenticateDkim(
      new TextEncoder().encode(fixtures.signedCc),
      sender,
      { resolver, now, destination: "manage@in.example.com" },
    ),
  ).toBe(true);
});
test("signature expiration and DNS failures fail closed", async () => {
  expect(
    await authenticateDkim(
      new TextEncoder().encode(fixtures.expiring),
      sender,
      { resolver, now: new Date("2026-10-20T23:00:00Z") },
    ),
  ).toBe(false);
  expect(
    await authenticateDkim(new TextEncoder().encode(valid), sender, {
      resolver: async () => {
        throw Error("DNS unavailable");
      },
      now,
    }),
  ).toBe(false);
});
test("bound header and signature work before DNS", async () => {
  let calls = 0;
  const bounded = async () => {
    calls++;
    return [[rr]];
  };
  const signature = valid.slice(0, valid.indexOf("From:"));
  for (const raw of [
    "X-Large: " + "a".repeat(32768) + "\r\n" + valid,
    signature.repeat(9) + unsigned,
  ]) {
    expect(
      await authenticateDkim(new TextEncoder().encode(raw), sender, {
        resolver: bounded,
        now,
      }),
    ).toBe(false);
  }
  expect(calls).toBe(0);
});

test("DNS TXT transport decodes fragments and rejects malformed escapes", async () => {
  const { decodeTxt } = await import("../src/inbound-auth");
  expect(decodeTxt('"v=DKIM1; " "p=abc\\061"').join("")).toBe(
    "v=DKIM1; p=abc=",
  );
  for (const value of ["unquoted", '"unfinished', '"bad\\999"', ""])
    expect(() => decodeTxt(value)).toThrow();
});

test("DNS resolver pins transport, follows aliases and honors the shortest TTL", async () => {
  const { resolveDkimTxt } = await import("../src/inbound-auth");
  const { vi } = await import("vitest");
  const name = "ttl._domainkey.fixture.example";
  let calls = 0;
  const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      calls++;
      expect(new URL(String(input)).origin).toBe("https://cloudflare-dns.com");
      expect(init?.redirect).toBe("manual");
      return Response.json({
        Status: 0,
        Question: [{ name, type: 16 }],
        Answer: [
          { name, type: 5, TTL: 1, data: "key.fixture.example." },
          {
            name: "key.fixture.example",
            type: 16,
            TTL: 300,
            data: '"v=DKIM1; " "p=abc"',
          },
        ],
      });
    });
  try {
    expect(await resolveDkimTxt(name, "TXT")).toEqual([["v=DKIM1; p=abc"]]);
    await resolveDkimTxt(name, "TXT");
    expect(calls).toBe(1);
    clock.mockReturnValue(101001);
    await resolveDkimTxt(name, "TXT");
    expect(calls).toBe(2);
  } finally {
    network.mockRestore();
    clock.mockRestore();
  }
});

test("DNS failures, redirects, cycles and oversized answers are never cached", async () => {
  const { resolveDkimTxt } = await import("../src/inbound-auth");
  const { vi } = await import("vitest");
  const name = "failure._domainkey.fixture.example";
  const bad = [
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.example" },
    }),
    new Response("{"),
    new Response("x".repeat(16385)),
    Response.json({
      Status: 0,
      Question: [{ name, type: 16 }],
      Answer: [{ name, type: 5, TTL: 10, data: name }],
    }),
    Response.json({
      Status: 0,
      Question: [{ name: "other.example", type: 16 }],
      Answer: [],
    }),
  ];
  const network = vi.spyOn(globalThis, "fetch");
  try {
    for (const response of bad) {
      network.mockResolvedValueOnce(response);
      await expect(resolveDkimTxt(name, "TXT")).rejects.toThrow();
    }
    expect(network).toHaveBeenCalledTimes(bad.length);
  } finally {
    network.mockRestore();
  }
});

test("unsigned delivery wrappers cannot replay mail without a signed stable identity", async () => {
  for (const prefix of [
    "",
    "Received: by another.example\r\nX-Wrapper: changed\r\n",
  ])
    expect(
      await authenticateDkim(
        new TextEncoder().encode(prefix + fixtures.missingMessageId),
        sender,
        { resolver, now },
      ),
    ).toBe(false);
});
