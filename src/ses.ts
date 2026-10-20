import type { Env, OutgoingMail, SendResult } from "./types";
import { AwsClient } from "aws4fetch";
import { boundedBytes } from "./util";
import { deliveryTag } from "./correlation";
export async function sendSes(
  env: Env,
  mail: OutgoingMail,
  id: string,
  now = new Date(),
): Promise<SendResult> {
  if (
    env.SENDING_ENABLED !== "true" ||
    !["production", "staging"].includes(env.STAGE) ||
    !env.SES_CONFIGURATION_SET ||
    !env.AWS_ACCESS_KEY_ID ||
    !env.AWS_SECRET_ACCESS_KEY
  )
    return {
      kind: "configuration_error",
      reason: "Sending disabled or SES configuration incomplete",
    };
  if (
    env.STAGE === "staging" &&
    !(JSON.parse(env.STAGING_RECIPIENTS) as string[]).includes(mail.recipient)
  )
    return {
      kind: "configuration_error",
      reason: "Recipient is not on the staging allowlist",
    };
  const client = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    service: "ses",
    region: env.SES_REGION,
    retries: 0,
  });
  const payload = {
    FromEmailAddress: env.SES_FROM,
    Destination: { ToAddresses: [mail.recipient] },
    ReplyToAddresses: [mail.replyTo],
    ConfigurationSetName: env.SES_CONFIGURATION_SET,
    EmailTags: [
      { Name: "delivery_id", Value: deliveryTag(mail.deliveryId) },
      { Name: "attempt_id", Value: id },
    ],
    Content: {
      Simple: {
        Subject: { Data: mail.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: mail.text, Charset: "UTF-8" },
          Html: { Data: mail.html, Charset: "UTF-8" },
        },
        Headers: [
          { Name: "Auto-Submitted", Value: "auto-generated" },
          { Name: "X-Auto-Response-Suppress", Value: "All" },
          ...(mail.unsubscribe
            ? [
                { Name: "List-Unsubscribe", Value: `<${mail.unsubscribe}>` },
                {
                  Name: "List-Unsubscribe-Post",
                  Value: "List-Unsubscribe=One-Click",
                },
              ]
            : []),
        ],
      },
    },
  };
  try {
    const request = await client.sign(
      `https://email.${env.SES_REGION}.amazonaws.com/v2/email/outbound-emails`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      },
    );
    const response = await fetch(request);
    const body = JSON.parse(
      new TextDecoder().decode(await boundedBytes(response.body, 32768)),
    ) as {
      MessageId?: string;
      __type?: string;
      message?: string;
      Message?: string;
    };
    if (response.ok)
      return body.MessageId
        ? { kind: "accepted", messageId: body.MessageId }
        : {
            kind: "uncertain",
            reason: "Acceptance response missing SES MessageId",
          };
    const code = (
      response.headers.get("x-amzn-errortype") ??
      body.__type ??
      "Unknown"
    )
      .split(":")[0]
      .split("#")
      .pop()!;
    const explanation = body.message ?? body.Message ?? "";
    if (
      [400, 429].includes(response.status) &&
      ["TooManyRequestsException", "ThrottlingException"].includes(code) &&
      /daily.*quota|quota.*exceeded/i.test(explanation)
    )
      return {
        kind: "quota_exhausted",
        dueAt: now.getTime() + 3600000,
        reason:
          "SES daily sending quota exhausted; retry after shared cooldown",
      };
    if (
      [400, 429].includes(response.status) &&
      ["TooManyRequestsException", "ThrottlingException"].includes(code)
    )
      return {
        kind: "safe_retry",
        dueAt: now.getTime() + 900000,
        reason: code,
      };
    if (
      [401, 403, 404].includes(response.status) ||
      [
        "MailFromDomainNotVerifiedException",
        "AccountSuspendedException",
        "SendingPausedException",
        "BadRequestException",
      ].includes(code)
    )
      return { kind: "configuration_error", reason: code };
    if (response.status === 400 && code === "MessageRejected")
      return { kind: "permanent_reject", reason: code };
    return { kind: "uncertain", reason: `SES ${response.status} ${code}` };
  } catch {
    return {
      kind: "uncertain",
      reason:
        "SES request interrupted or response unavailable; reconcile before retry",
    };
  }
}
