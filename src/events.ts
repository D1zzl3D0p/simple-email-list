import type { Env } from "./types";
import { verifySnsSignature } from "./sns-verifier";
import { boundedBytes } from "./util";
import { stmt } from "./db";
import { decodeDeliveryTag } from "./correlation";
interface SesEvent {
  eventType: string;
  mail: {
    messageId: string;
    destination: string[];
    sendingAccountId: string;
    tags?: Record<string, string[]>;
  };
  bounce?: { bounceType: string };
}
export async function handleSnsEvents(
  request: Request,
  env: Env,
  now: Date,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  let envelope: Record<string, string>;
  try {
    envelope = JSON.parse(
      new TextDecoder().decode(await boundedBytes(request.body, 262144)),
    );
  } catch {
    return new Response("Invalid or oversized event", { status: 400 });
  }
  const topic = env.SNS_TOPIC_ARN;
  const arn = /^arn:aws:sns:([a-z0-9-]+):(\d{12}):[a-zA-Z0-9_-]+$/.exec(topic);
  if (
    !arn ||
    arn[1] !== env.SES_REGION ||
    !envelope ||
    envelope.TopicArn !== topic
  )
    return new Response("Topic rejected", { status: 403 });
  const host = `sns.${arn[1]}.amazonaws.com`;
  try {
    for (const key of [
      "Message",
      "MessageId",
      "Timestamp",
      "TopicArn",
      "Type",
      "Signature",
      "SigningCertURL",
      "SignatureVersion",
    ])
      if (typeof envelope[key] !== "string") throw Error("Invalid envelope");
    if (
      !["Notification", "SubscriptionConfirmation"].includes(envelope.Type) ||
      !["1", "2"].includes(envelope.SignatureVersion)
    )
      throw Error("Invalid type");
    const cert = new URL(envelope.SigningCertURL);
    if (
      cert.origin !== `https://${host}` ||
      cert.username ||
      cert.password ||
      cert.search ||
      cert.hash ||
      !/^\/SimpleNotificationService-[a-zA-Z0-9_-]+\.pem$/.test(cert.pathname)
    )
      throw Error("Untrusted certificate");
    await verifySnsSignature(envelope, cert);
    if (envelope.Type === "SubscriptionConfirmation") {
      const url = new URL(envelope.SubscribeURL);
      if (
        url.origin !== `https://${host}` ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== "/" ||
        url.searchParams.get("Action") !== "ConfirmSubscription" ||
        url.searchParams.get("TopicArn") !== topic ||
        url.searchParams.get("Token") !== envelope.Token
      )
        throw Error("Untrusted confirmation");
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Error("Confirmation failed");
      return new Response("Confirmed");
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        code: "sns_verification_failed",
        reason:
          error instanceof Error
            ? error.message.slice(0, 160)
            : "Unknown verifier error",
      }),
    );
    return new Response("Signature or confirmation rejected", { status: 403 });
  }
  let event: SesEvent;
  try {
    event = JSON.parse(envelope.Message);
    if (
      !event.mail?.messageId ||
      event.mail.sendingAccountId !== arn[2] ||
      !Array.isArray(event.mail.destination)
    )
      throw Error("Invalid SES identity");
  } catch {
    return new Response("Invalid SES event", { status: 400 });
  }
  const type = event.eventType;
  if (
    ![
      "Send",
      "Delivery",
      "DeliveryDelay",
      "Bounce",
      "Complaint",
      "Reject",
      "Rendering Failure",
    ].includes(type)
  )
    return new Response("Ignored");
  const attemptId = event.mail.tags?.attempt_id?.[0] ?? null;
  const taggedDelivery = event.mail.tags?.delivery_id?.[0];
  const deliveryId = taggedDelivery ? decodeDeliveryTag(taggedDelivery) : null;
  if (taggedDelivery && !deliveryId)
    return new Response("Invalid delivery correlation", { status: 400 });
  const delivery = await stmt(
    env.DB,
    `SELECT o.id,o.recipient,o.is_summary,o.state FROM outbox o JOIN send_attempts a ON a.outbox_id=o.id
    WHERE (a.id=? OR a.provider_id=?) AND (? IS NULL OR o.id=?) LIMIT 1`,
    attemptId,
    event.mail.messageId,
    deliveryId,
    deliveryId,
  ).first<{
    id: string;
    recipient: string;
    is_summary: number;
    state: string;
  }>();
  // An event with unknown correlation is retained and remains visible; no subscriber state is inferred from arbitrary addresses.
  const terminal =
    ["Complaint", "Reject", "Rendering Failure"].includes(type) ||
    (type === "Bounce" && event.bounce?.bounceType === "Permanent");
  const failure = terminal || type === "Bounce" || type === "DeliveryDelay";
  const valid =
    delivery &&
    event.mail.destination
      .map((a) => a.toLowerCase())
      .includes(delivery.recipient);
  const state = terminal
    ? "failed"
    : type === "Delivery"
      ? "delivered"
      : "accepted";
  const id = envelope.MessageId;
  const t = now.getTime();
  const statements = [
    stmt(
      env.DB,
      "INSERT OR IGNORE INTO provider_events(id,type,provider_id,attempt_id,received_at) VALUES(?,?,?,?,?)",
      id,
      type,
      event.mail.messageId,
      attemptId,
      t,
    ),
  ];
  if (valid) {
    // Failed is terminal; delayed/send events cannot regress delivered. Events do not change membership generations.
    statements.push(
      stmt(
        env.DB,
        `UPDATE outbox SET state=CASE WHEN state='failed' THEN 'failed' WHEN ?='failed' THEN 'failed' WHEN state='delivered' THEN 'delivered' ELSE ? END,provider_id=?,last_error=NULL WHERE id=?`,
        state,
        state,
        event.mail.messageId,
        delivery.id,
      ),
    );
    statements.push(
      stmt(
        env.DB,
        "UPDATE send_attempts SET provider_id=? WHERE outbox_id=? AND (id=? OR provider_id=?)",
        event.mail.messageId,
        delivery.id,
        attemptId,
        event.mail.messageId,
      ),
    );
    if (
      type === "Complaint" ||
      (type === "Bounce" && event.bounce?.bounceType === "Permanent")
    )
      statements.push(
        stmt(
          env.DB,
          "INSERT OR IGNORE INTO suppressions(email,reason,created_at) VALUES(?,?,?)",
          delivery.recipient,
          type,
          t,
        ),
      );
    if (failure && !delivery.is_summary)
      statements.push(
        stmt(
          env.DB,
          "INSERT OR IGNORE INTO incidents(source_key,code,detail,created_at) VALUES(?,?,?,?)",
          `sns:${id}`,
          type,
          `SES ${type}; delivery ${delivery.id}`,
          t,
        ),
      );
  }
  await env.DB.batch(statements);
  return new Response("Recorded");
}
