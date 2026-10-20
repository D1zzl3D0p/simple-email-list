import type { Env } from "./types";
import { stmt, rows } from "./db";
import { receiveEmail, type ReceiptDependencies } from "./inbound";
import { runScheduled, dispatchSummary } from "./delivery";
import { queueBroadcastSummary } from "./confirmations";
import { prepareArchivePages } from "./archive";

export type BackgroundJob =
  | { type: "receipt"; id: string }
  | { type: "scheduled" }
  | { type: "archives" }
  | { type: "summaries" };
const MAX_RAW = 1048576;
const LEASE_MS = 300000;
const MAX_ATTEMPTS = 5;

interface ReceiptJob {
  id: string;
  raw_key: string;
  destination: string;
  envelope_from: string;
  raw_size: number;
  attempts: number;
}

export async function queueReceipt(
  message: ForwardableEmailMessage,
  env: Env,
  now = new Date(),
): Promise<string> {
  const destination = message.to.toLowerCase();
  if (
    ![
      env.UPDATE_ADDRESS.toLowerCase(),
      env.MANAGE_ADDRESS.toLowerCase(),
    ].includes(destination)
  )
    throw Error("Unknown destination");
  if (
    !Number.isSafeInteger(message.rawSize) ||
    message.rawSize < 0 ||
    message.rawSize > MAX_RAW
  )
    throw Error("Email exceeds 1 MiB; send a smaller text update");
  const id = crypto.randomUUID();
  const rawKey = `receipts/${id}.eml`;
  // The platform supplies rawSize. FixedLengthStream also enforces the actual
  // byte count without buffering or trusting an unbounded incoming stream.
  const fixed = new FixedLengthStream(message.rawSize);
  const abort = new AbortController();
  const pump = message.raw.pipeTo(fixed.writable, { signal: abort.signal });
  const store = Promise.resolve().then(() =>
    env.ARCHIVE.put(rawKey, fixed.readable, {
      httpMetadata: { contentType: "message/rfc822" },
    }),
  );
  try {
    await Promise.all([pump, store]);
  } catch (error) {
    abort.abort();
    await Promise.allSettled([pump, store]);
    throw error;
  }
  await stmt(
    env.DB,
    "INSERT INTO receipt_jobs(id,raw_key,destination,envelope_from,raw_size,created_at,notified_at) VALUES(?,?,?,?,?,?,?)",
    id,
    rawKey,
    message.to,
    message.from,
    message.rawSize,
    now.getTime(),
    now.getTime(),
  ).run();
  try {
    await env.JOBS.send({ type: "receipt", id } satisfies BackgroundJob);
  } catch {
    // Acceptance depends on the durable object + intent, not a transient queue
    // notification. Cron repairs this signal, including after queue expiration.
    try {
      await stmt(
        env.DB,
        "UPDATE receipt_jobs SET notified_at=0 WHERE id=?",
        id,
      ).run();
    } catch {
      // The original timestamp also becomes eligible for scheduled repair.
      // Nothing after durable commit may turn acceptance into SMTP rejection.
    }
    console.error(JSON.stringify({ code: "receipt_signal_failed", id }));
  }
  return id;
}

export async function processReceiptJob(
  id: string,
  env: Env,
  deps?: ReceiptDependencies,
): Promise<void> {
  const now = deps?.clock() ?? new Date();
  const holder = crypto.randomUUID();
  // Terminations cannot run catch. Enforce the ceiling during claim as well,
  // recording the held state and incident in the same transaction. Never stop
  // an active fifth attempt whose lease is still valid.
  const claimed = await env.DB.batch<ReceiptJob>([
    stmt(
      env.DB,
      "UPDATE receipt_jobs SET state='held',holder=NULL,lease_until=NULL,last_error='Receipt attempt limit reached during recovery' WHERE id=? AND attempts>=? AND (state='pending' OR (state='processing' AND lease_until<=?))",
      id,
      MAX_ATTEMPTS,
      now.getTime(),
    ),
    stmt(
      env.DB,
      "INSERT OR IGNORE INTO incidents(source_key,code,detail,created_at) SELECT ?,'receipt_held',?,? FROM receipt_jobs WHERE id=? AND state='held'",
      `receipt:${id}`,
      `Queued receipt ${id} needs recovery review; no unauthenticated actions were permitted`,
      now.getTime(),
      id,
    ),
    stmt(
      env.DB,
      "UPDATE receipt_jobs SET state='processing',holder=?,lease_until=?,attempts=attempts+1 WHERE id=? AND attempts<? AND (state='pending' OR (state='processing' AND lease_until<=?)) RETURNING id,raw_key,destination,envelope_from,raw_size,attempts",
      holder,
      now.getTime() + LEASE_MS,
      id,
      MAX_ATTEMPTS,
      now.getTime(),
    ),
  ]);
  const job = claimed[2].results[0];
  if (!job) return; // Duplicate notifications cannot bypass the durable lease.
  try {
    const object = await env.ARCHIVE.get(job.raw_key);
    if (!object || object.size !== job.raw_size)
      throw Error("Queued original unavailable; recovery required");
    const message = {
      from: job.envelope_from,
      to: job.destination,
      rawSize: job.raw_size,
      raw: object.body,
      headers: new Headers(),
      setReject(reason: string) {
        throw Error(reason);
      },
    };
    await receiveEmail(message, env, deps);
    const result = await stmt(
      env.DB,
      "UPDATE receipt_jobs SET state='complete',holder=NULL,lease_until=NULL,finished_at=?,last_error=NULL WHERE id=? AND holder=?",
      (deps?.clock() ?? new Date()).getTime(),
      id,
      holder,
    ).run();
    if (result.meta.changes) {
      console.log(JSON.stringify({ code: "receipt_complete", id }));
      // receiveEmail has already durably archived the canonical raw original.
      // Cleanup failure is harmless; its key remains recorded for recovery.
      try {
        await env.ARCHIVE.delete(job.raw_key);
      } catch {
        console.error(JSON.stringify({ code: "receipt_cleanup_failed", id }));
      }
    }
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message.slice(0, 200)
        : "Receipt processing failed";
    if (job.attempts >= MAX_ATTEMPTS) {
      await env.DB.batch([
        stmt(
          env.DB,
          "UPDATE receipt_jobs SET state='held',holder=NULL,lease_until=NULL,last_error=? WHERE id=? AND holder=?",
          detail,
          id,
          holder,
        ),
        stmt(
          env.DB,
          "INSERT OR IGNORE INTO incidents(source_key,code,detail,created_at) SELECT ?,'receipt_held',?,? FROM receipt_jobs WHERE id=? AND state='held'",
          `receipt:${id}`,
          `Queued receipt ${id} needs recovery review; no unauthenticated actions were permitted`,
          now.getTime(),
          id,
        ),
      ]);
      console.error(JSON.stringify({ code: "receipt_held", id }));
      return;
    }
    await stmt(
      env.DB,
      "UPDATE receipt_jobs SET state='pending',holder=NULL,lease_until=NULL,last_error=?,notified_at=0 WHERE id=? AND holder=?",
      detail,
      id,
      holder,
    ).run();
    throw error;
  }
}

export async function recoverReceiptJobs(
  env: Env,
  now = new Date(),
): Promise<number> {
  const pending = await rows<{ id: string }>(
    env.DB,
    "SELECT id FROM receipt_jobs WHERE (state='pending' AND notified_at<=?) OR (state='processing' AND lease_until<=?) ORDER BY created_at,id LIMIT 25",
    now.getTime() - 900000,
    now.getTime(),
  );
  if (!pending.length) return 0;
  await env.JOBS.sendBatch(
    pending.map(({ id }) => ({
      body: { type: "receipt", id } satisfies BackgroundJob,
    })),
  );
  await stmt(
    env.DB,
    "UPDATE receipt_jobs SET notified_at=? WHERE id IN (SELECT value FROM json_each(?))",
    now.getTime(),
    JSON.stringify(pending.map(({ id }) => id)),
  ).run();
  return pending.length;
}

export async function handleJobs(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body as Partial<BackgroundJob> | null;
    if (
      !body ||
      typeof body !== "object" ||
      (body.type !== "scheduled" &&
        body.type !== "archives" &&
        body.type !== "summaries" &&
        !(body.type === "receipt" && typeof body.id === "string"))
    ) {
      console.error(JSON.stringify({ code: "invalid_background_job" }));
      message.ack();
      continue;
    }
    try {
      if (body.type === "receipt") await processReceiptJob(body.id!, env);
      // A delayed notification uses processing time for leases and quota, not
      // an obsolete scheduled timestamp. Existing outbox work remains durable.
      else if (body.type === "archives") await prepareArchivePages(env);
      else if (body.type === "summaries") {
        const now = new Date();
        const id = await queueBroadcastSummary(env, now);
        if (id) await dispatchSummary(env, id, now);
      } else await runScheduled(env, new Date());
      message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}
