import { stmt } from "./db";
import type { Env } from "./types";

// One bounded, independently budgeted background job; old broadcasts are exempt.
export async function queueBroadcastSummary(
  env: Env,
  now: Date,
): Promise<string | null> {
  const candidate = await env.DB.prepare(
    `SELECT b.id FROM broadcasts b
    WHERE b.completion_reported=0 AND NOT EXISTS (
      SELECT 1 FROM outbox o WHERE o.broadcast_id=b.id AND o.kind='newsletter'
      AND o.state IN ('pending','retry_wait','sending'))
    ORDER BY b.created_at,b.id LIMIT 1`,
  ).first<{ id: string }>();
  if (!candidate) return null;
  const id = `broadcast-summary:${candidate.id}`;
  await env.DB.batch([
    stmt(
      env.DB,
      `INSERT OR IGNORE INTO outbox(id,kind,recipient,subject,text,state,due_at,created_at,unique_key,is_summary)
      SELECT ?,'owner',i.sender,'Newsletter results: '||substr(b.subject,1,120),
        'Processing finished for: '||b.subject||char(10)||
        'Recipients: '||count(o.id)||char(10)||
        'Accepted by Amazon: '||coalesce(sum(o.state IN ('accepted','delivered')),0)||char(10)||
        'Failed: '||coalesce(sum(o.state='failed'),0)||char(10)||
        'Uncertain / needs review: '||coalesce(sum(o.state='review_required'),0)||char(10)||
        'Cancelled: '||coalesce(sum(o.state='cancelled'),0)||char(10)||char(10)||
        'Accepted means Amazon accepted the submission; it does not guarantee inbox placement or reading. Uncertain deliveries are not automatically resent. Later provider updates are available through status and the dashboard.',
        'pending',?,?,?,1
      FROM broadcasts b JOIN inbound_messages i ON i.id=b.inbound_id
      LEFT JOIN outbox o ON o.broadcast_id=b.id AND o.kind='newsletter'
      WHERE b.id=? AND b.completion_reported=0 GROUP BY b.id
      HAVING coalesce(sum(o.state IN ('pending','retry_wait','sending')),0)=0`,
      id,
      now.getTime(),
      now.getTime(),
      id,
      candidate.id,
    ),
    stmt(
      env.DB,
      "UPDATE broadcasts SET completion_reported=1 WHERE id=? AND EXISTS(SELECT 1 FROM outbox WHERE unique_key=?)",
      candidate.id,
      id,
    ),
  ]);
  return id;
}
