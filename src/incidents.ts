import { stmt } from "./db";
import type { Env, IncidentInput } from "./types";
// Incidents remain an audit trail. Only unresolved attempts should alert.
// Unknown correlation stays reportable rather than hiding an operator incident.
export function actionableIncident(alias: string, cutoff?: number): string {
  return `(${alias}.code!='review_required' OR (${cutoff === undefined ? "1" : `${alias}.created_at<=${cutoff}`} AND NOT EXISTS(
    SELECT 1 FROM send_attempts a JOIN outbox delivery ON delivery.id=a.outbox_id
    WHERE ${alias}.source_key LIKE 'attempt:%' AND a.id=substr(${alias}.source_key,9)
    AND (delivery.state!='review_required' OR delivery.attempt_id!=a.id)
  )))`;
}
const reconciliationGraceMs = 15 * 60 * 1000;

// Refresh only notifications that have never been attempted. Once attempted,
// their frozen body and the existing uncertain-send safeguards must be retained.
export async function refreshFailureSummary(env: Env, id: string) {
  const relevant = `SELECT 1 FROM incidents i WHERE i.summary_id=outbox.id AND ${actionableIncident("i")}`;
  return stmt(
    env.DB,
    `UPDATE outbox SET
    state=CASE WHEN EXISTS(${relevant}) THEN state ELSE 'cancelled' END,
    text=(SELECT 'Processing summary for '||outbox.id||char(10)||group_concat(detail_line,char(10)) FROM (
      SELECT i.code||': '||sum(i.affected)||' affected — '||min(i.detail) detail_line
      FROM incidents i WHERE i.summary_id=outbox.id AND ${actionableIncident("i")} GROUP BY i.code
    ))
    WHERE id=? AND is_summary=1 AND attempt_count=0 AND state IN ('pending','retry_wait') RETURNING state,text`,
    id,
  ).first<{ state: string; text: string | null }>();
}
export async function recordIncident(
  env: Env,
  i: IncidentInput,
  now: Date,
): Promise<void> {
  await stmt(
    env.DB,
    "INSERT OR IGNORE INTO incidents(run_id,source_key,code,detail,affected,created_at) VALUES(?,?,?,?,?,?)",
    i.runId ?? null,
    i.sourceKey,
    i.code,
    i.detail.slice(0, 500),
    i.affected ?? 1,
    now.getTime(),
  ).run();
}
export async function startRun(
  env: Env,
  id: string,
  recipient: string,
  source: string,
  now: Date,
) {
  await stmt(
    env.DB,
    "INSERT OR IGNORE INTO processing_runs(id,recipient,source,started_at) VALUES(?,?,?,?)",
    id,
    recipient,
    source,
    now.getTime(),
  ).run();
}
function completeRunStatement(env: Env, id: string, now: Date) {
  return stmt(
    env.DB,
    "UPDATE processing_runs SET finished_at=COALESCE(finished_at,?),summary_key=CASE WHEN EXISTS(SELECT 1 FROM incidents WHERE run_id=?) THEN 'failure:'||id ELSE summary_key END WHERE id=?",
    now.getTime(),
    id,
    id,
  );
}
export async function completeRunIntent(env: Env, id: string, now: Date) {
  await completeRunStatement(env, id, now).run();
}
export async function finishRun(
  env: Env,
  id: string,
  now: Date,
  dispatch = true,
): Promise<void> {
  await env.DB.batch([
    completeRunStatement(env, id, now),
    stmt(
      env.DB,
      `INSERT OR IGNORE INTO outbox(id,kind,recipient,subject,state,due_at,created_at,unique_key,is_summary)
      SELECT 'failure:'||r.id,'owner',r.recipient,'Mission processing needs attention','pending',?,?,'failure:'||r.id,1 FROM processing_runs r
      WHERE r.id=? AND r.recipient!='' AND EXISTS(SELECT 1 FROM incidents i WHERE i.run_id=r.id AND i.summary_id IS NULL AND ${actionableIncident("i", now.getTime() - reconciliationGraceMs)})`,
      now.getTime(),
      now.getTime(),
      id,
    ),
    stmt(
      env.DB,
      `UPDATE incidents AS i SET summary_id='failure:'||? WHERE run_id=? AND summary_id IS NULL AND ${actionableIncident("i", now.getTime() - reconciliationGraceMs)} AND EXISTS(SELECT 1 FROM outbox WHERE id='failure:'||?)`,
      id,
      id,
      id,
    ),
  ]);
  if (dispatch && env.SENDING_ENABLED === "true") {
    const { dispatchSummary } = await import("./delivery");
    await dispatchSummary(env, `failure:${id}`, now);
  }
}
export async function recoverRuns(env: Env, now: Date): Promise<void> {
  // Set-based recovery avoids a query per abandoned operation after a long outage.
  await env.DB.batch([
    stmt(
      env.DB,
      `INSERT OR IGNORE INTO incidents(run_id,source_key,code,detail,created_at) SELECT id,'stale:'||id,'interrupted_run','Processing run interrupted; inspect durable state before retry',? FROM processing_runs WHERE finished_at IS NULL AND started_at<?`,
      now.getTime(),
      now.getTime() - 600000,
    ),
    stmt(
      env.DB,
      `INSERT OR IGNORE INTO outbox(id,kind,recipient,subject,state,due_at,created_at,unique_key,is_summary)
      SELECT 'failure:'||r.id,'owner',r.recipient,'Interrupted mission processing','pending',?,?,'failure:'||r.id,1 FROM processing_runs r WHERE r.finished_at IS NULL AND r.started_at<? AND r.recipient!=''`,
      now.getTime(),
      now.getTime(),
      now.getTime() - 600000,
    ),
    stmt(
      env.DB,
      `UPDATE incidents AS i SET summary_id='failure:'||run_id WHERE summary_id IS NULL AND ${actionableIncident("i", now.getTime() - reconciliationGraceMs)} AND run_id IN (SELECT id FROM processing_runs WHERE finished_at IS NULL AND started_at<?)`,
      now.getTime() - 600000,
    ),
    stmt(
      env.DB,
      "UPDATE processing_runs SET finished_at=? WHERE finished_at IS NULL AND started_at<?",
      now.getTime(),
      now.getTime() - 600000,
    ),
    stmt(
      env.DB,
      `INSERT OR IGNORE INTO outbox(id,kind,recipient,subject,state,due_at,created_at,unique_key,is_summary)
      SELECT 'failure:late:'||max(i.id),'owner',s.missionary,'Mission delivery needs attention','pending',?,?,'failure:late:'||max(i.id),1 FROM incidents i CROSS JOIN settings s WHERE i.summary_id IS NULL AND ${actionableIncident("i", now.getTime() - reconciliationGraceMs)} AND (i.run_id IS NULL OR EXISTS(SELECT 1 FROM processing_runs r WHERE r.id=i.run_id AND r.finished_at IS NOT NULL)) AND s.missionary!='' HAVING count(*)>0`,
      now.getTime(),
      now.getTime(),
    ),
    stmt(
      env.DB,
      `UPDATE incidents AS i SET summary_id=(SELECT id FROM outbox WHERE id LIKE 'failure:late:%' AND state='pending' ORDER BY CAST(substr(id,14) AS INTEGER) DESC LIMIT 1) WHERE summary_id IS NULL AND ${actionableIncident("i", now.getTime() - reconciliationGraceMs)} AND (run_id IS NULL OR EXISTS(SELECT 1 FROM processing_runs r WHERE r.id=i.run_id AND r.finished_at IS NOT NULL))`,
    ),
  ]);
}
