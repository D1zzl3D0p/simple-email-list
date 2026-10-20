import type { Env, Snapshot } from "./types";
import { stmt } from "./db";
const weekFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Denver",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  hourCycle: "h23",
});
export function localWeek(now: Date): { key: string; ready: boolean } {
  const parts = weekFormatter.formatToParts(now);
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const day = new Date(
    `${part("year")}-${part("month")}-${part("day")}T00:00:00Z`,
  );
  const weekday = day.getUTCDay();
  const offset = (weekday + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return {
    key: day.toISOString().slice(0, 10),
    ready: offset > 0 || Number(part("hour")) >= 9,
  };
}
export async function ensureWeeklyReport(env: Env, now: Date): Promise<void> {
  const week = localWeek(now);
  if (!week.ready) return;
  await stmt(
    env.DB,
    "UPDATE outbox SET state='cancelled' WHERE unique_key LIKE 'weekly:%' AND unique_key<? AND state IN ('pending','retry_wait')",
    `weekly:${week.key}`,
  ).run();
  if (
    await stmt(
      env.DB,
      "SELECT id FROM outbox WHERE unique_key=?",
      `weekly:${week.key}`,
    ).first()
  )
    return;
  const snapshot = await buildSnapshot(env, now);
  await stmt(
    env.DB,
    "INSERT OR IGNORE INTO outbox(id,kind,recipient,subject,text,state,due_at,created_at,unique_key) SELECT ?,'owner',missionary,'Weekly mission status',?,'pending',?,?,? FROM settings WHERE id=1 AND missionary!=''",
    `weekly:${week.key}`,
    formatSnapshot(snapshot),
    now.getTime(),
    now.getTime(),
    `weekly:${week.key}`,
  ).run();
}
export async function buildSnapshot(env: Env, now: Date): Promise<Snapshot> {
  type StoredSnapshot = Omit<
    Snapshot,
    | "warnings"
    | "newsletter_limit"
    | "total_limit"
    | "newsletter_remaining"
    | "total_remaining"
    | "oldest_age_hours"
    | "projected_hours"
    | "weekly_capacity"
  >;
  const snapshot = await stmt(
    env.DB,
    `SELECT
  (SELECT count(*) FROM subscribers WHERE status='active') active,
  (SELECT count(*) FROM suppressions) suppressed,
  (SELECT count(*) FROM outbox WHERE state IN ('pending','retry_wait')) pending,
  (SELECT count(*) FROM outbox WHERE state='accepted') accepted,
  (SELECT count(*) FROM outbox WHERE state='delivered') delivered,
  (SELECT count(*) FROM outbox WHERE state='review_required') uncertain,
  (SELECT count(*) FROM inbound_messages WHERE state='held') held,
  (SELECT min(created_at) FROM outbox WHERE state IN ('pending','retry_wait')) oldest,
  (SELECT count(*) FROM send_attempts WHERE reserved_at>?) attempts,
  (SELECT count(*) FROM send_attempts WHERE reserved_at>? AND kind='newsletter') newsletter_attempts,
  (SELECT COALESCE(sum(affected),0) FROM incidents WHERE summary_id IS NULL) incidents,
  (SELECT count(*) FROM outbox WHERE kind='newsletter' AND state IN ('pending','retry_wait')) newsletter_pending,
  (SELECT count(*) FROM subscribers WHERE created_at>=?) joined_week,
  (SELECT count(*) FROM subscribers WHERE updated_at>=?) changed_week,
  (SELECT count(*) FROM broadcasts WHERE created_at>=?) updates_week,
  (SELECT count(*) FROM outbox WHERE kind='newsletter' AND created_at>=?) demand_week,
  (SELECT COALESCE(sum(count),0) FROM rate_counters WHERE key LIKE 'diagnostic:validation:%' AND expires_at>?) validation_faults,
  paused,transport_paused,quota_retry_at FROM settings WHERE id=1`,
    now.getTime() - 86400000,
    now.getTime() - 86400000,
    now.getTime() - 7 * 86400000,
    now.getTime() - 7 * 86400000,
    now.getTime() - 7 * 86400000,
    now.getTime() - 7 * 86400000,
    now.getTime(),
  ).first<StoredSnapshot>();
  if (!snapshot) throw Error("Snapshot unavailable");
  const warnings: string[] = [];
  if (snapshot.oldest !== null && snapshot.oldest < now.getTime() - 172800000)
    warnings.push("Oldest pending work exceeds 48 hours");
  if (snapshot.uncertain)
    warnings.push(
      "Uncertain sends require SES reconciliation before any retry",
    );
  if (snapshot.transport_paused)
    warnings.push(
      "All SES submissions paused by transport configuration fault",
    );
  const quota = Math.max(0, Number(env.SES_DAILY_QUOTA) || 0);
  const newsletter_limit = Math.min(2000, Math.floor(quota * 0.8));
  const total_limit = Math.min(2100, Math.floor(quota * 0.9));
  const dailyCapacity = Math.min(6 * 96, newsletter_limit, total_limit);
  const weekly_capacity = dailyCapacity * 7;
  if (
    snapshot.newsletter_pending > weekly_capacity ||
    snapshot.demand_week > weekly_capacity
  )
    warnings.push(
      "Newsletter backlog or weekly demand exceeds configured weekly capacity",
    );
  const blocked =
    !!snapshot.paused ||
    !!snapshot.transport_paused ||
    snapshot.uncertain > 0 ||
    dailyCapacity === 0;
  const cooldown =
    Math.max(0, (snapshot.quota_retry_at ?? 0) - now.getTime()) / 3600000;
  const projected_hours =
    snapshot.pending === 0
      ? 0
      : blocked
        ? null
        : Math.max(
            snapshot.newsletter_pending / dailyCapacity,
            snapshot.pending / Math.min(6 * 96, total_limit),
          ) *
            24 +
          cooldown;
  return {
    ...snapshot,
    warnings,
    newsletter_limit,
    total_limit,
    newsletter_remaining: Math.max(
      0,
      newsletter_limit - snapshot.newsletter_attempts,
    ),
    total_remaining: Math.max(0, total_limit - snapshot.attempts),
    weekly_capacity,
    projected_hours,
    oldest_age_hours:
      snapshot.oldest === null
        ? null
        : Math.max(0, now.getTime() - snapshot.oldest) / 3600000,
  };
}
export function formatSnapshot(s: Snapshot) {
  return `Active: ${s.active}\nProvider suppressions: ${s.suppressed}\nJoined / changed in past 7 days: ${s.joined_week} / ${s.changed_week}\nUpdates / newsletter demand in past 7 days: ${s.updates_week} / ${s.demand_week}\nPending: ${s.pending}\nOldest pending age: ${s.oldest_age_hours === null ? "none" : s.oldest_age_hours.toFixed(1) + " hours"}\nProjected completion (best-case scheduled capacity): ${s.projected_hours === null ? "blocked by pause, review or unverified quota" : s.projected_hours.toFixed(1) + " hours"}\nAccepted: ${s.accepted}\nDelivered: ${s.delivered}\nUncertain: ${s.uncertain}\nHeld inputs: ${s.held}\nRolling 24h attempts: ${s.attempts} (${s.newsletter_attempts} newsletters)\nNewsletter budget: ${s.newsletter_attempts}/${s.newsletter_limit}; remaining ${s.newsletter_remaining}\nTotal budget: ${s.attempts}/${s.total_limit}; remaining ${s.total_remaining}\nConfigured weekly capacity (upper estimate): ${s.weekly_capacity}\nQuota cooldown: ${s.quota_retry_at ? new Date(s.quota_retry_at).toISOString() : "none"}\nNewsletter paused: ${!!s.paused}\nTransport fault: ${s.transport_paused ?? "none"}\nValidation service faults: ${s.validation_faults}\nUnreported incidents: ${s.incidents}\n${s.warnings.join("\n")}`;
}
