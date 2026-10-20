import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { receiveEmail } from "../src/inbound";
import { configure, testEnv, mail, rawMail, now } from "./helpers";
const verified = { authenticate: async () => true, clock: () => now };
beforeEach(configure);
test("reject_unapproved_and_forged_auth", async () => {
  await expect(
    receiveEmail(
      mail(
        rawMail(
          "",
          "Authentication-Results: mx.cloudflare.net; dmarc=pass\r\n",
        ),
      ),
      testEnv(),
    ),
  ).rejects.toThrow(/authentication/i);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(0);
});
test("unapproved_sender_cannot_manage", async () => {
  await expect(
    receiveEmail(
      mail(
        rawMail().replaceAll("missionary@example.com", "stranger@example.com"),
        env.MANAGE_ADDRESS,
      ),
      testEnv(),
      verified,
    ),
  ).rejects.toThrow(/approved/i);
});
test("raw_size_limit", async () => {
  await expect(
    receiveEmail(mail(rawMail("a".repeat(1048576))), testEnv(), verified),
  ).rejects.toThrow(/1 MiB/);
});
test("duplicate_receipt", async () => {
  await receiveEmail(mail(rawMail()), testEnv(), verified);
  await receiveEmail(mail(rawMail()), testEnv(), verified);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(1);
});
test("same_message_id_new_transit_headers_deduplicates", async () => {
  await receiveEmail(mail(rawMail()), testEnv(), verified);
  await receiveEmail(
    mail(rawMail(undefined, "Received: different transit\r\n")),
    testEnv(),
    verified,
  );
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(1);
});
test("reused_message_id_changed_content_is_held", async () => {
  await receiveEmail(mail(rawMail()), testEnv(), verified);
  await receiveEmail(mail(rawMail("Changed body")), testEnv(), verified);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM inbound_messages WHERE state='held'",
    ).first("n"),
  ).toBe(1);
});
test("same_raw_message_different_destination_role_is_distinct", async () => {
  await receiveEmail(mail(rawMail()), testEnv(), verified);
  await receiveEmail(mail(rawMail(), env.MANAGE_ADDRESS), testEnv(), verified);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(2);
});
test("auto_reply_does_not_broadcast", async () => {
  await expect(
    receiveEmail(
      mail(rawMail(undefined, "Auto-Submitted: auto-replied\r\n")),
      testEnv(),
      verified,
    ),
  ).rejects.toThrow(/automatic/i);
});
test("r2_failure_is_not_acknowledged", async () => {
  const broken = testEnv({
    ARCHIVE: {
      put: async () => {
        throw Error("storage unavailable");
      },
    } as unknown as R2Bucket,
  });
  await expect(receiveEmail(mail(rawMail()), broken, verified)).rejects.toThrow(
    "storage unavailable",
  );
  expect(
    await env.DB.prepare("SELECT count(*) n FROM inbound_messages").first("n"),
  ).toBe(0);
});
test.each([
  ["Week one", env.UPDATE_ADDRESS, "broadcast"],
  ["add a@example.com", env.UPDATE_ADDRESS, "broadcast"],
  ["SEND newsletter", env.MANAGE_ADDRESS, "command"],
])("subject_is_not_a_routing_signal: %s", async (subject, to, role) => {
  await receiveEmail(
    mail(rawMail("Hello", "", subject), to),
    testEnv(),
    verified,
  );
  expect(
    await env.DB.prepare("SELECT role FROM inbound_messages").first("role"),
  ).toBe(role);
});
