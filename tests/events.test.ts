import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { createSign } from "node:crypto";
import cert from "./fixtures/sns-test-cert.pem?raw";
import key from "./fixtures/sns-test-key.pem?raw";
import { handleSnsEvents } from "../src/events";
import { configure, now, testEnv } from "./helpers";
test("SNS certificate redirects are rejected without event mutation", async () => {
  const outbound = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", {
      status: 302,
      headers: { location: "https://evil.example/cert.pem" },
    }),
  );
  const m = envelope("Delivery", {
    SigningCertURL: `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-${crypto.randomUUID()}.pem`,
  });
  expect((await handleSnsEvents(request(m), e(), now)).status).toBe(403);
  expect(
    await env.DB.prepare("SELECT count(*) FROM provider_events").first(
      "count(*)",
    ),
  ).toBe(0);
  expect(outbound.mock.calls[0][1]?.redirect).toBe("manual");
});
const topic = "arn:aws:sns:us-east-1:123456789012:mission-events";
test("signed confirmation uses edge-supported manual redirect mode and rejects redirects", async () => {
  const url =
    "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=" +
    encodeURIComponent(topic) +
    "&Token=fixture";
  const m = envelope("Delivery", {
    Type: "SubscriptionConfirmation",
    SubscribeURL: url,
    Token: "fixture",
  });
  let redirect: RequestInit["redirect"];
  const outbound = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) => {
      if (String(_input).includes(".pem")) return new Response(cert);
      redirect = init?.redirect;
      return new Response("", {
        status: 302,
        headers: { location: "https://evil.example/" },
      });
    });
  try {
    expect((await handleSnsEvents(request(m), e(), now)).status).toBe(403);
    expect(outbound).toHaveBeenCalledTimes(2);
    expect(redirect).toBe("manual");
  } finally {
    outbound.mockRestore();
  }
});
let certUrl: string;
const e = () => testEnv({ SNS_TOPIC_ARN: topic });
function envelope(
  type = "Delivery",
  change: Record<string, string | undefined> = {},
) {
  const event = {
    eventType: type,
    mail: {
      messageId: "ses-1",
      destination: ["a@example.com"],
      sendingAccountId: "123456789012",
      tags: { attempt_id: ["attempt-1"], delivery_id: ["d_ZGVsaXZlcnktMQ"] },
    },
    bounce: {
      bounceType: "Permanent",
      bouncedRecipients: [{ emailAddress: "a@example.com" }],
    },
  };
  const m: Record<string, string> = {
    Type: "Notification",
    MessageId: crypto.randomUUID(),
    Message: JSON.stringify(event),
    Timestamp: now.toISOString(),
    TopicArn: topic,
    SignatureVersion: "2",
    SigningCertURL: certUrl,
    ...change,
  };
  const fields =
    m.Type === "Notification"
      ? [
          "Message",
          "MessageId",
          ...("Subject" in m ? ["Subject"] : []),
          "Timestamp",
          "TopicArn",
          "Type",
        ]
      : [
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ];
  const signer = createSign(
    m.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256",
  );
  signer.update(fields.map((k) => `${k}\n${m[k]}\n`).join(""));
  m.Signature = signer.sign(key, "base64");
  return m;
}
function request(m: object) {
  return new Request("https://mission.example.com/events/sns", {
    method: "POST",
    body: JSON.stringify(m),
  });
}
beforeEach(async () => {
  vi.restoreAllMocks();
  certUrl = `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-${crypto.randomUUID()}.pem`;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(cert),
  );
  await configure();
  await env.DB.prepare(
    "INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) VALUES('s','a@example.com','active',1,0,0,'test','v1')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO outbox(id,kind,recipient,subscriber_id,generation,subject,text,state,due_at,created_at) VALUES('delivery-1','owner','a@example.com','s',1,'s','t','pending',0,0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO send_attempts(id,outbox_id,kind,reserved_at,run_id) VALUES('attempt-1','delivery-1','owner',0,'run')",
  ).run();
});
test("real RSA signature validates; callback before API result reconciles and duplicate deduplicates", async () => {
  const m = envelope();
  expect((await handleSnsEvents(request(m), e(), now)).status).toBe(200);
  await handleSnsEvents(request(m), e(), now);
  expect(await env.DB.prepare("SELECT state FROM outbox").first("state")).toBe(
    "delivered",
  );
  expect(
    await env.DB.prepare("SELECT count(*) FROM provider_events").first(
      "count(*)",
    ),
  ).toBe(1);
});
test.each([
  { TopicArn: "arn:aws:sns:us-west-2:000000000000:evil" },
  { SigningCertURL: "https://evil.example/cert.pem" },
  {
    SigningCertURL: "https://sns.us-east-1.amazonaws.com.evil.example/cert.pem",
  },
  { SigningCertURL: "https://sns.us-east-1.amazonaws.com:444/cert.pem" },
])("reject wrong topic and hostile certificate URL", async (change) => {
  expect(
    (await handleSnsEvents(request(envelope("Delivery", change)), e(), now))
      .status,
  ).toBe(403);
  expect(
    await env.DB.prepare("SELECT count(*) FROM provider_events").first(
      "count(*)",
    ),
  ).toBe(0);
});
test("invalid signature and forged confirmation rejected", async () => {
  const m = envelope();
  m.Signature = "AAAA";
  expect((await handleSnsEvents(request(m), e(), now)).status).toBe(403);
  expect(
    (
      await handleSnsEvents(
        request(
          envelope("Delivery", {
            Type: "SubscriptionConfirmation",
            SubscribeURL: "https://evil.example/",
            Token: "token",
          }),
        ),
        e(),
        now,
      )
    ).status,
  ).toBe(403);
});
test("hard bounce suppression persists with monotonic delivery ordering and stale generation", async () => {
  await env.DB.prepare("UPDATE subscribers SET generation=2").run();
  await handleSnsEvents(request(envelope("Bounce")), e(), now);
  await handleSnsEvents(request(envelope("Delivery")), e(), now);
  expect(await env.DB.prepare("SELECT state FROM outbox").first("state")).toBe(
    "failed",
  );
  expect(
    await env.DB.prepare("SELECT reason FROM suppressions").first("reason"),
  ).toBe("Bounce");
  expect(
    await env.DB.prepare("SELECT generation FROM subscribers").first(
      "generation",
    ),
  ).toBe(2);
});
test("soft delay does not resubmit and summary failures do not recursively notify", async () => {
  await env.DB.prepare("UPDATE outbox SET is_summary=1").run();
  await handleSnsEvents(request(envelope("DeliveryDelay")), e(), now);
  expect(await env.DB.prepare("SELECT state FROM outbox").first("state")).toBe(
    "accepted",
  );
  await handleSnsEvents(request(envelope("Complaint")), e(), now);
  expect(
    await env.DB.prepare("SELECT count(*) FROM incidents").first("count(*)"),
  ).toBe(0);
});

test("native verifier caches imported keys and accepts signed optional subject including empty", async () => {
  const outbound = vi.mocked(fetch);
  const imports = vi.spyOn(crypto.subtle, "importKey");
  for (const Subject of ["", "delivery update"]) {
    expect(
      (
        await handleSnsEvents(
          request(envelope("Delivery", { Subject })),
          e(),
          now,
        )
      ).status,
    ).toBe(200);
  }
  expect(outbound).toHaveBeenCalledOnce();
  expect(imports).toHaveBeenCalledOnce();
  expect(outbound.mock.calls[0][1]?.redirect).toBe("manual");
  expect(outbound.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
});
test("native verifier accepts legacy RSA SHA1 without confusing versioned keys", async () => {
  for (const SignatureVersion of ["2", "1", "2"]) {
    expect(
      (
        await handleSnsEvents(
          request(envelope("Delivery", { SignatureVersion })),
          e(),
          now,
        )
      ).status,
    ).toBe(200);
  }
  expect(fetch).toHaveBeenCalledOnce();
});
test("oversized certificate bodies are rejected before verification", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(cert + " ".repeat(32769)));
  expect((await handleSnsEvents(request(envelope()), e(), now)).status).toBe(
    403,
  );
});
test("invalid confirmation signature never follows SubscribeURL", async () => {
  const m = envelope("Delivery", {
    Type: "SubscriptionConfirmation",
    SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topic)}&Token=fixture`,
    Token: "fixture",
  });
  m.Signature = "AAAA";
  expect((await handleSnsEvents(request(m), e(), now)).status).toBe(403);
  expect(fetch).toHaveBeenCalledOnce();
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(certUrl);
});

test("certificate cache expires and cannot trust stale key material forever", async () => {
  expect((await handleSnsEvents(request(envelope()), e(), now)).status).toBe(
    200,
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600001);
  try {
    expect((await handleSnsEvents(request(envelope()), e(), now)).status).toBe(
      200,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
  }
});

test("certificate key cache evicts old entries at its fixed bound", async () => {
  const first = certUrl;
  for (let i = 0; i < 17; i++) {
    const SigningCertURL =
      i === 0
        ? first
        : `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-${crypto.randomUUID()}.pem`;
    expect(
      (
        await handleSnsEvents(
          request(envelope("Delivery", { SigningCertURL })),
          e(),
          now,
        )
      ).status,
    ).toBe(200);
  }
  expect(
    (
      await handleSnsEvents(
        request(envelope("Delivery", { SigningCertURL: first })),
        e(),
        now,
      )
    ).status,
  ).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(18);
});
test("valid signed confirmation follows only its pinned SNS URL", async () => {
  const SubscribeURL = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topic)}&Token=fixture`;
  const outbound = vi
    .mocked(fetch)
    .mockImplementation(
      async (input) =>
        new Response(String(input).includes(".pem") ? cert : "confirmed"),
    );
  expect(
    (
      await handleSnsEvents(
        request(
          envelope("Delivery", {
            Type: "SubscriptionConfirmation",
            SubscribeURL,
            Token: "fixture",
          }),
        ),
        e(),
        now,
      )
    ).status,
  ).toBe(200);
  expect(outbound).toHaveBeenCalledTimes(2);
  expect(String(outbound.mock.calls[1][0])).toBe(SubscribeURL);
  expect(outbound.mock.calls[1][1]?.redirect).toBe("manual");
});
