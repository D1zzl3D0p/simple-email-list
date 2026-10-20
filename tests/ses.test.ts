import { afterEach, expect, test, vi } from "vitest";
import { sendSes } from "../src/ses";
import { testEnv, now } from "./helpers";
const outgoing = {
  recipient: "owner@example.com",
  subject: "Week",
  text: "Hello",
  html: "<p>Hello</p>",
  replyTo: "missionary@example.com",
  deliveryId: "delivery-1",
  unsubscribe: "https://mission.example.com/unsubscribe?token=abc",
};
afterEach(() => vi.unstubAllGlobals());
test.each([
  [400, "ThrottlingException"],
  [429, "TooManyRequestsException"],
])("confirmed quota exhaustion recognized for %s %s", async (status, code) => {
  vi.stubGlobal("fetch", async () =>
    Response.json(
      { message: "Daily message quota exceeded" },
      { status, headers: { "x-amzn-errortype": code } },
    ),
  );
  expect(
    (
      await sendSes(
        testEnv({
          SENDING_ENABLED: "true",
          STAGE: "production",
          SES_CONFIGURATION_SET: "fixture",
        }),
        outgoing,
        "attempt",
        now,
      )
    ).kind,
  ).toBe("quota_exhausted");
});
test("signed SES payload has single recipient, correlation, reply and one-click headers", async () => {
  let payload: Record<string, unknown> = {};
  vi.stubGlobal("fetch", async (request: Request) => {
    expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256/);
    payload = await request.json();
    return Response.json({ MessageId: "ses-id" });
  });
  const r = await sendSes(
    testEnv({
      SENDING_ENABLED: "true",
      STAGE: "staging",
      STAGING_RECIPIENTS: '["owner@example.com"]',
      SES_CONFIGURATION_SET: "fixture",
    }),
    outgoing,
    "attempt-1",
    now,
  );
  expect(r).toEqual({ kind: "accepted", messageId: "ses-id" });
  expect(payload.Destination).toEqual({ ToAddresses: ["owner@example.com"] });
  expect(payload.EmailTags).toEqual([
    { Name: "delivery_id", Value: "d_ZGVsaXZlcnktMQ" },
    { Name: "attempt_id", Value: "attempt-1" },
  ]);
  expect(JSON.stringify(payload)).toContain("List-Unsubscribe-Post");
  expect(JSON.stringify(payload)).toContain("auto-generated");
  expect(JSON.stringify(payload)).toContain("X-Auto-Response-Suppress");
  expect(payload.ReplyToAddresses).toEqual(["missionary@example.com"]);
});
test.each([
  [429, "TooManyRequestsException", "safe_retry"],
  [500, "InternalFailure", "uncertain"],
  [403, "AccessDeniedException", "configuration_error"],
  [400, "MailFromDomainNotVerifiedException", "configuration_error"],
  [400, "MessageRejected", "permanent_reject"],
])("classifies %s %s", async (status, code, kind) => {
  vi.stubGlobal("fetch", async () =>
    Response.json(
      { message: code },
      { status, headers: { "x-amzn-errortype": code } },
    ),
  );
  expect(
    (
      await sendSes(
        testEnv({
          SENDING_ENABLED: "true",
          STAGE: "production",
          SES_CONFIGURATION_SET: "fixture",
        }),
        outgoing,
        "a",
        now,
      )
    ).kind,
  ).toBe(kind);
});
test("network timeout is uncertain; staging and disabled guard prevent real sends", async () => {
  vi.stubGlobal("fetch", async () => {
    throw Error("timeout");
  });
  expect(
    (
      await sendSes(
        testEnv({
          SENDING_ENABLED: "true",
          STAGE: "production",
          SES_CONFIGURATION_SET: "fixture",
        }),
        outgoing,
        "a",
        now,
      )
    ).kind,
  ).toBe("uncertain");
  expect((await sendSes(testEnv(), outgoing, "a", now)).kind).toBe(
    "configuration_error",
  );
  expect(
    (
      await sendSes(
        testEnv({
          SENDING_ENABLED: "true",
          STAGE: "staging",
          STAGING_RECIPIENTS: "[]",
          SES_CONFIGURATION_SET: "fixture",
        }),
        outgoing,
        "a",
        now,
      )
    ).kind,
  ).toBe("configuration_error");
});
