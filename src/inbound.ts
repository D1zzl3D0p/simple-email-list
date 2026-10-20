import { getSettings, stmt, invocationDatabase } from "./db";
import { parseMail, parseMailHeaders } from "./mail";
import { boundedBytes, sha256 } from "./util";
import type { Clock, Env } from "./types";
import { applyCommands, parseCommands } from "./commands";
import { finishRun } from "./incidents";
import { authenticateDkim } from "./inbound-auth";
export interface ReceiptDependencies {
  authenticate: (
    message: ForwardableEmailMessage,
    raw: Uint8Array,
    visibleSender: string,
  ) => Promise<boolean>;
  clock: Clock;
}
// Verify the actual signed message. Authentication-Results is never authority.
const defaultDependencies: ReceiptDependencies = {
  authenticate: async (message, raw, sender) =>
    authenticateDkim(raw, sender, { destination: message.to }),
  clock: () => new Date(),
};
export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: Env,
  deps = defaultDependencies,
): Promise<void> {
  const budget = invocationDatabase(env.DB);
  env = { ...env, DB: budget.db };
  const role =
    message.to.toLowerCase() === env.UPDATE_ADDRESS.toLowerCase()
      ? "broadcast"
      : message.to.toLowerCase() === env.MANAGE_ADDRESS.toLowerCase()
        ? "command"
        : null;
  if (!role) throw Error("Unknown destination");
  if (message.rawSize > 1048576)
    throw Error("Email exceeds 1 MiB; send a smaller text update");
  const raw = await boundedBytes(message.raw, 1048576);
  const header = await parseMailHeaders(raw);
  const sender = header.from?.address?.toLowerCase() ?? "";
  const settings = await getSettings(env.DB);
  const allowed =
    role === "command"
      ? [settings.missionary, settings.owner]
      : (JSON.parse(settings.approved_senders) as string[]);
  if (!sender || !allowed.includes(sender))
    throw Error("Sender is not approved");
  if (!(await deps.authenticate(message, raw, sender)))
    throw Error("Sender authentication unavailable or failed");
  const headers = header.headers;
  if (
    headers.some(
      (h) =>
        (h.key === "auto-submitted" && h.value.toLowerCase() !== "no") ||
        h.key === "list-id" ||
        h.key === "x-auto-response-suppress" ||
        (h.key === "content-type" &&
          /report-type|delivery-status/i.test(h.value)),
    )
  )
    throw Error("Automatic replies and mailing-list input are not accepted");
  const p = await parseMail(raw);
  const rawHash = await sha256(raw);
  const key = `raw/${rawHash}.eml`;
  const id = `${role}:${rawHash}`;
  await env.ARCHIVE.put(key, raw, {
    httpMetadata: { contentType: "message/rfc822" },
  });
  const messageId = p.parsed.messageId?.trim() || null;
  const existing = messageId
    ? await stmt(
        env.DB,
        "SELECT id,fingerprint FROM inbound_messages WHERE role=? AND sender=? AND message_id=? AND state!='held'",
        role,
        sender,
        messageId,
      ).first<{ id: string; fingerprint: string }>()
    : null;
  if (existing?.fingerprint === p.fingerprint) {
    if (role === "command")
      await processPendingCommands(env, deps.clock(), existing.id);
    await finishRun(env, existing.id, deps.clock(), budget.remaining() > 18);
    return;
  }
  let reason = existing
    ? "Message-ID reused with changed content"
    : !p.text
      ? "Missing body"
      : role === "broadcast" && !p.subject
        ? "Missing subject"
        : null;
  const now = deps.clock().getTime();
  // A racing identity insert is re-evaluated within this statement, rather than acknowledged and lost.
  await env.DB.batch([
    stmt(
      env.DB,
      "INSERT OR IGNORE INTO processing_runs(id,recipient,source,started_at) VALUES(?,?,?,?)",
      id,
      sender,
      "email",
      now,
    ),
    stmt(
      env.DB,
      `INSERT OR IGNORE INTO inbound_messages(id,role,raw_key,raw_hash,sender,message_id,fingerprint,subject,text,received_at,state,held_reason,run_id)
      SELECT ?,?,?,?,?,?,?,?,?,?,CASE WHEN ? IS NOT NULL OR EXISTS(SELECT 1 FROM inbound_messages WHERE role=? AND sender=? AND message_id=? AND fingerprint!=?) THEN 'held' ELSE 'pending' END,?,?
      WHERE NOT EXISTS(SELECT 1 FROM inbound_messages WHERE role=? AND sender=? AND message_id=? AND fingerprint=?)`,
      id,
      role,
      key,
      rawHash,
      sender,
      messageId,
      p.fingerprint,
      p.subject,
      p.text,
      now,
      reason,
      role,
      sender,
      messageId,
      p.fingerprint,
      reason,
      id,
      role,
      sender,
      messageId,
      p.fingerprint,
    ),
    stmt(
      env.DB,
      "INSERT OR IGNORE INTO incidents(run_id,source_key,code,detail,created_at) SELECT run_id,'held:'||id,'inbound_held',COALESCE(held_reason,'Message-ID content conflict'),? FROM inbound_messages WHERE id=? AND state='held'",
      now,
      id,
    ),
  ]);
  if (role === "command") await processPendingCommands(env, new Date(now), id);
  await finishRun(env, id, new Date(now), budget.remaining() > 18);
}
export async function processPendingCommands(env: Env, now: Date, id?: string) {
  const pending = await stmt(
    env.DB,
    "SELECT id,sender,text FROM inbound_messages WHERE role='command' AND state='pending' AND (? IS NULL OR id=?) ORDER BY received_at,id LIMIT 1",
    id ?? null,
    id ?? null,
  ).first<{ id: string; sender: string; text: string }>();
  if (!pending) return;
  const settings = await getSettings(env.DB);
  await applyCommands(
    env,
    pending.id,
    {
      email: pending.sender,
      role: pending.sender === settings.missionary ? "missionary" : "owner",
    },
    parseCommands(pending.text),
    now,
  );
}
