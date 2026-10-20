import type { Env, Clock, OutgoingMail, SendResult } from "./types";
import { getSettings, rows, stmt, invocationDatabase } from "./db";
import { sendSes } from "./ses";
import { capability, newsletterContent } from "./unsubscribe";
import { escapeHtml } from "./util";
import { prepareNextMessage } from "./mail";
import { startRun, finishRun, recoverRuns, recordIncident } from "./incidents";
import { ensureWeeklyReport } from "./report";
import { processPendingCommands } from "./inbound";
import { readBody } from "./body";
export interface DeliveryDependencies {
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  send: (
    env: Env,
    mail: OutgoingMail,
    id: string,
    now: Date,
  ) => Promise<SendResult>;
}
interface Work {
  id: string;
  kind: string;
  recipient: string;
  subject: string;
  text: string;
  text_key: string | null;
  album_url: string;
  subscriber_id: string;
  generation: number;
  attempt_count: number;
  safe_retry_count: number;
  is_summary: number;
  is_welcome: number;
}
class NotificationProcessingError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : "Notification processing failed",
      { cause },
    );
  }
}
export async function runScheduled(
  env: Env,
  now: Date,
  deps?: DeliveryDependencies,
): Promise<void> {
  const budget = invocationDatabase(env.DB);
  env = { ...env, DB: budget.db };
  const started = Date.now();
  const d = deps ?? {
    clock: () => new Date(now.getTime() + Date.now() - started),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    send: sendSes,
  };
  const holder = crypto.randomUUID();
  const t = now.getTime();
  const lease = await stmt(
    env.DB,
    "INSERT INTO leases(name,holder,expires_at) VALUES('scheduler',?,?) ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at WHERE leases.expires_at<=? RETURNING holder",
    holder,
    t + 300000,
    t,
  ).first();
  if (!lease) return;
  const runId = `tick:${holder}`;
  try {
    const settings = await getSettings(env.DB);
    await startRun(env, runId, settings.missionary, "scheduled", now);
    await stmt(
      env.DB,
      "UPDATE outbox SET state='review_required',last_error='Expired sending reservation; reconcile SES before retry' WHERE state='sending' AND lease_until<=?",
      t,
    ).run();
    await recoverRuns(env, now);
    if (budget.remaining() > 20) await ensureWeeklyReport(env, now);
    const pending = await env.DB.prepare(
      "SELECT role FROM inbound_messages WHERE state='pending' ORDER BY received_at,id LIMIT 1",
    ).first<{ role: string }>();
    if (budget.remaining() > 22) {
      if (pending?.role === "command") await processPendingCommands(env, now);
      else await prepareNextMessage(env, now);
    }
    await stmt(
      env.DB,
      "DELETE FROM rate_counters WHERE expires_at<=?",
      t,
    ).run();
    await stmt(
      env.DB,
      "UPDATE outbox SET state='cancelled' WHERE kind='newsletter' AND state IN ('pending','retry_wait') AND (NOT EXISTS(SELECT 1 FROM subscribers s WHERE s.id=outbox.subscriber_id AND s.status='active' AND s.generation=outbox.generation) OR EXISTS(SELECT 1 FROM suppressions x WHERE x.email=outbox.recipient))",
    ).run();
    if (env.SENDING_ENABLED !== "true" || settings.transport_paused) return;
    await drain(env, now, holder, runId, d, 6, budget.remaining);
  } catch (error) {
    console.error(
      JSON.stringify({
        code:
          error instanceof NotificationProcessingError
            ? "notification_processing_failed"
            : "scheduled_failed",
        runId,
      }),
    );
    if (
      !(error instanceof NotificationProcessingError) &&
      budget.remaining() > 6
    )
      await recordIncident(
        env,
        {
          runId,
          sourceKey: "run:" + runId,
          code: "scheduled_failed",
          detail: "Scheduled processing failed; inspect durable records",
        },
        d.clock(),
      );
    throw error;
  } finally {
    try {
      if (budget.remaining() > 5) {
        await finishRun(env, runId, d.clock(), false);
        if (budget.remaining() > 12)
          await drain(
            env,
            now,
            holder,
            runId,
            d,
            1,
            budget.remaining,
            "failure:" + runId,
          );
      }
    } finally {
      await stmt(
        env.DB,
        "DELETE FROM leases WHERE name='scheduler' AND holder=?",
        holder,
      ).run();
    }
  }
}

async function drain(
  env: Env,
  now: Date,
  holder: string,
  runId: string,
  d: DeliveryDependencies,
  limit: number,
  remaining: () => number,
  onlyId?: string,
) {
  const t = now.getTime();
  const settings = await getSettings(env.DB);
  if (
    env.SENDING_ENABLED !== "true" ||
    settings.transport_paused ||
    (settings.quota_retry_at ?? 0) > d.clock().getTime()
  )
    return;
  const quota = Number(env.SES_DAILY_QUOTA),
    rate = Number(env.SES_RATE);
  if (
    !Number.isFinite(quota) ||
    quota < 1 ||
    !Number.isFinite(rate) ||
    rate <= 0
  )
    return;
  // Six ordinary attempts leave room for preparation, completion reporting and maintenance below 40 D1 statements.
  const work = await rows<Work>(
    env.DB,
    `SELECT o.*,COALESCE(b.subject,o.subject) subject,COALESCE(b.text,o.text,(SELECT 'Processing summary for '||o.id||char(10)||group_concat(detail_line,char(10)) FROM (SELECT code||': '||sum(affected)||' affected — '||min(detail) detail_line FROM incidents WHERE summary_id=o.id GROUP BY code))) text,b.text_key,COALESCE(b.album_url,'') album_url FROM outbox o LEFT JOIN broadcasts b ON b.id=o.broadcast_id
      WHERE o.state IN ('pending','retry_wait') AND o.due_at<=? AND (o.kind='owner' OR o.is_welcome=1 OR ?=0) AND (? IS NULL OR o.id=?)
      AND (o.kind='owner' OR NOT EXISTS(SELECT 1 FROM outbox older WHERE older.subscriber_id=o.subscriber_id AND older.kind='newsletter' AND (older.created_at<o.created_at OR (older.created_at=o.created_at AND older.id<o.id)) AND older.state IN ('pending','retry_wait','sending','review_required')))
      ORDER BY CASE WHEN o.kind='owner' THEN 0 WHEN o.is_welcome=1 THEN 1 ELSE 2 END,o.created_at,o.id LIMIT ?`,
    t,
    settings.paused,
    onlyId ?? null,
    onlyId ?? null,
    limit,
  );
  let last = 0;
  for (const w of work) {
    try {
      if (remaining() < 12 || d.clock().getTime() >= t + 180000) break;
      // Resolve before reservation: missing storage must not create an uncertain
      // SES attempt. Keep inline historical messages on the existing path.
      const text = await readBody(env, w);
      const lastReservation =
        last ||
        Number(
          await stmt(
            env.DB,
            "SELECT COALESCE(max(reserved_at),0) value FROM send_attempts",
          ).first("value"),
        );
      const delay =
        lastReservation + Math.ceil(1000 / rate) - d.clock().getTime();
      if (delay > 0) await d.sleep(delay);
      const stamp = d.clock().getTime();
      if (stamp >= t + 180000) break;
      const attempt = crypto.randomUUID();
      const claimed = await stmt(
        env.DB,
        `INSERT INTO send_attempts(id,outbox_id,kind,reserved_at,run_id)
        SELECT ?,id,kind,?,? FROM outbox WHERE id=? AND state IN ('pending','retry_wait') AND due_at<=?
        AND EXISTS(SELECT 1 FROM leases WHERE name='scheduler' AND holder=? AND expires_at>?)
        AND EXISTS(SELECT 1 FROM settings WHERE transport_paused IS NULL AND (quota_retry_at IS NULL OR quota_retry_at<=?) AND (outbox.kind='owner' OR outbox.is_welcome=1 OR paused=0))
        AND NOT EXISTS(SELECT 1 FROM suppressions x WHERE x.email=outbox.recipient)
        AND (kind='owner' OR (EXISTS(SELECT 1 FROM subscribers s WHERE s.id=outbox.subscriber_id AND s.status='active' AND s.generation=outbox.generation) AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.email=outbox.recipient)))
        AND (SELECT count(*) FROM send_attempts WHERE reserved_at>?)<?
        AND (kind='owner' OR (SELECT count(*) FROM send_attempts WHERE kind='newsletter' AND reserved_at>?)<?)
        AND NOT EXISTS(SELECT 1 FROM send_attempts WHERE reserved_at>?) RETURNING id`,
        attempt,
        stamp,
        runId,
        w.id,
        stamp,
        holder,
        stamp,
        stamp,
        stamp - 86400000,
        Math.min(2100, Math.floor(quota * 0.9)),
        stamp - 86400000,
        Math.min(2000, Math.floor(quota * 0.8)),
        stamp - Math.ceil(1000 / rate),
      ).first();
      if (!claimed) continue;
      let content = { text, html: `<pre>${escapeHtml(text)}</pre>` };
      let leave: string | undefined;
      if (w.kind === "newsletter") {
        leave = `${env.PUBLIC_URL}/unsubscribe?token=${encodeURIComponent(await capability(env, "leave", w.subscriber_id, w.generation))}`;
        content = w.is_welcome
          ? {
              text: `${text}\n\nPersonal unsubscribe: ${leave}`,
              html: `<div style="white-space:pre-wrap">${escapeHtml(text)}</div><p><a href="${escapeHtml(leave)}">Personal unsubscribe</a></p>`,
            }
          : newsletterContent(text, w.album_url, env.PUBLIC_URL, leave);
      }
      let result: SendResult;
      try {
        result = await d.send(
          env,
          {
            recipient: w.recipient,
            subject: w.subject,
            ...content,
            replyTo: settings.missionary,
            unsubscribe: leave,
            deliveryId: w.id,
          },
          attempt,
          new Date(stamp),
        );
      } catch {
        result = {
          kind: "uncertain",
          reason: "Send interrupted; reconcile SES",
        };
      }
      last = stamp;
      const state =
        result.kind === "accepted"
          ? "accepted"
          : result.kind === "quota_exhausted"
            ? "retry_wait"
            : result.kind === "safe_retry"
              ? w.safe_retry_count >= 4
                ? "review_required"
                : "retry_wait"
              : result.kind === "uncertain"
                ? "review_required"
                : result.kind === "configuration_error"
                  ? "retry_wait"
                  : "failed";
      const due =
        result.kind === "safe_retry" || result.kind === "quota_exhausted"
          ? Math.max(
              result.dueAt,
              stamp +
                [900000, 3600000, 21600000][Math.min(w.safe_retry_count, 2)],
            )
          : stamp;
      // Event updates can precede this result. Never overwrite a terminal callback state.
      await stmt(
        env.DB,
        "UPDATE outbox SET state=?,provider_id=COALESCE(?,provider_id),last_error=?,due_at=?,safe_retry_count=safe_retry_count+? WHERE id=? AND attempt_id=? AND state='sending'",
        state,
        result.kind === "accepted" ? result.messageId : null,
        result.kind === "accepted" ? null : result.reason,
        due,
        result.kind === "safe_retry" ? 1 : 0,
        w.id,
        attempt,
      ).run();
      if (result.kind === "quota_exhausted") {
        await stmt(
          env.DB,
          "UPDATE settings SET quota_retry_at=? WHERE id=1",
          result.dueAt,
        ).run();
        break;
      }
      if (result.kind === "configuration_error") {
        await stmt(
          env.DB,
          "UPDATE settings SET transport_paused=? WHERE id=1",
          result.reason,
        ).run();
        break;
      }
    } catch (error) {
      if (w.is_summary) throw new NotificationProcessingError(error);
      throw error;
    }
  }
}

export async function dispatchSummary(
  env: Env,
  id: string,
  now: Date,
): Promise<void> {
  if (env.SENDING_ENABLED !== "true") return;
  const budget = invocationDatabase(env.DB);
  env = { ...env, DB: budget.db };
  const holder = crypto.randomUUID();
  const stamp = now.getTime();
  const lease = await stmt(
    env.DB,
    "INSERT INTO leases(name,holder,expires_at) VALUES('scheduler',?,?) ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at WHERE leases.expires_at<=? RETURNING holder",
    holder,
    stamp + 300000,
    stamp,
  ).first();
  if (!lease) return;
  const started = Date.now();
  const d = {
    clock: () => new Date(stamp + Date.now() - started),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    send: sendSes,
  };
  try {
    await drain(
      env,
      now,
      holder,
      "notification:" + id,
      d,
      1,
      budget.remaining,
      id,
    );
  } finally {
    await stmt(
      env.DB,
      "DELETE FROM leases WHERE name='scheduler' AND holder=?",
      holder,
    ).run();
  }
}
