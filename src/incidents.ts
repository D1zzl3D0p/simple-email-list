import { stmt } from "./db";
import type { Env, IncidentInput } from "./types";
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
      WHERE r.id=? AND r.recipient!='' AND EXISTS(SELECT 1 FROM incidents i WHERE i.run_id=r.id AND i.summary_id IS NULL)`,
      now.getTime(),
      now.getTime(),
      id,
    ),
    stmt(
      env.DB,
      "UPDATE incidents SET summary_id='failure:'||? WHERE run_id=? AND summary_id IS NULL AND EXISTS(SELECT 1 FROM outbox WHERE id='failure:'||?)",
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
      "UPDATE incidents SET summary_id='failure:'||run_id WHERE summary_id IS NULL AND run_id IN (SELECT id FROM processing_runs WHERE finished_at IS NULL AND started_at<?)",
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
      SELECT 'failure:late:'||max(i.id),'owner',s.missionary,'Mission delivery needs attention','pending',?,?,'failure:late:'||max(i.id),1 FROM incidents i CROSS JOIN settings s WHERE i.summary_id IS NULL AND (i.run_id IS NULL OR EXISTS(SELECT 1 FROM processing_runs r WHERE r.id=i.run_id AND r.finished_at IS NOT NULL)) AND s.missionary!='' HAVING count(*)>0`,
      now.getTime(),
      now.getTime(),
    ),
    stmt(
      env.DB,
      `UPDATE incidents SET summary_id=(SELECT id FROM outbox WHERE id LIKE 'failure:late:%' AND state='pending' ORDER BY CAST(substr(id,14) AS INTEGER) DESC LIMIT 1) WHERE summary_id IS NULL AND (run_id IS NULL OR EXISTS(SELECT 1 FROM processing_runs r WHERE r.id=incidents.run_id AND r.finished_at IS NOT NULL))`,
    ),
  ]);
}
