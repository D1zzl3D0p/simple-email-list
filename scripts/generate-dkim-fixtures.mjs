import { readFileSync, writeFileSync } from "node:fs";
import { dkimSign } from "mailauth/lib/dkim/sign";

// Test key only, already public in this repository. Never use a real sender key.
const key = readFileSync(
  new URL("../tests/fixtures/sns-test-key.pem", import.meta.url),
  "utf8",
);
const message = [
  "From: Missionary <missionary@example.com>",
  "To: update@in.example.com",
  "Subject: Week one",
  "Message-ID: <dkim-fixture@example.com>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: 7bit",
  "",
  "Only the signed content is authorized.",
  "",
].join("\r\n");
const fixtures = { unsigned: message };
const variants = {
  valid: {},
  partialBody: { maxBodyLength: 0 },
  unrelatedDomain: { signingDomain: "other.example" },
  unsignedSubject: {
    headerList:
      "from:to:message-id:mime-version:content-type:content-transfer-encoding",
  },
  unsignedEncoding: {
    headerList: "from:to:subject:message-id:mime-version:content-type",
  },
  sha1: { algorithm: "rsa-sha1" },
  expiring: {},
  multipleFrom: {},
  signedCc: {},
  missingMessageId: {},
  emptyMessageId: {},
  longLineSignature: {},
};
for (const [name, change] of Object.entries(variants)) {
  let raw = message;
  if (name === "longLineSignature")
    raw = raw.replace(
      "Only the signed content is authorized.",
      "x".repeat(70000),
    );
  if (name === "missingMessageId")
    raw = raw.replace("Message-ID: <dkim-fixture@example.com>\r\n", "");
  if (name === "emptyMessageId")
    raw = raw.replace("<dkim-fixture@example.com>", "");
  if (name === "multipleFrom")
    raw = raw.replace(
      "Missionary <missionary@example.com>",
      "missionary@example.com, another@example.com",
    );
  if (name === "signedCc")
    raw = raw.replace(
      "To: update@in.example.com",
      "To: update@in.example.com\r\nCc: manage@in.example.com",
    );
  const result = await dkimSign(raw, {
    signTime: new Date("2026-10-19T23:00:00Z"),
    ...(name === "expiring"
      ? { expires: new Date("2026-10-19T23:30:00Z") }
      : {}),
    strict: name !== "sha1",
    signatureData: [
      {
        signingDomain: "example.com",
        selector: "fixture",
        privateKey: key,
        ...change,
      },
    ],
  });
  if (result.errors.length) throw Error(`Fixture signing failed: ${name}`);
  fixtures[name] =
    name === "longLineSignature" ? result.signatures : result.signatures + raw;
}
writeFileSync(
  new URL("../tests/fixtures/dkim.json", import.meta.url),
  JSON.stringify(fixtures, null, 2) + "\n",
);
