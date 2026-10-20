import type { Env, AdminIdentity } from "./types";
import type { Subscriber } from "./types";
import { getSettings, rows, stmt } from "./db";
import { normalizeAddress } from "./signup";
import { buildSnapshot, formatSnapshot } from "./report";
export interface CommandLineResult {
  line: number;
  command?:
    "add" | "remove" | "dump" | "full" | "status" | "pause" | "resume" | "help";
  address?: string;
  error?: string;
}
export function parseCommands(text: string): CommandLineResult[] {
  const output: CommandLineResult[] = [];
  const input = text.split(/\r?\n/);
  for (let index = 0; index < input.length; index++) {
    const raw = input[index];
    const headerBlock =
      /^\s*From:\s*\S/i.test(raw) &&
      input
        .slice(index + 1, index + 8)
        .filter((line) => /^\s*(Sent|Date|To|Subject):/i.test(line)).length >=
        2;
    if (
      headerBlock ||
      /^\s*Sent from my i(?:Phone|Pad)\s*$/i.test(raw) ||
      /^\s*>|^On .+wrote:\s*$|^-{2}\s*$|^-{2,}\s*Original Message|^\s*[-_]{5,}\s*$|^Begin forwarded message:/i.test(
        raw,
      )
    )
      break;
    let line = raw.trim();
    if (!line) continue;
    if (
      line.startsWith("`") &&
      line.endsWith("`") &&
      !line.slice(1, -1).includes("`")
    )
      line = line.slice(1, -1).trim();
    const match = /^(add|remove)\s+(\S+)(?:\s+<mailto:([^<>\s]+)>)?$/i.exec(
      line,
    );
    const number = output.length + 1;
    if (match) {
      const address = normalizeAddress(match[2]);
      const matchingLink = !match[3] || normalizeAddress(match[3]) === address;
      output.push(
        address && matchingLink
          ? {
              line: number,
              command: match[1].toLowerCase() as "add" | "remove",
              address,
            }
          : {
              line: number,
              error: "Malformed email address; correct and retry this line",
            },
      );
    } else if (/^dump(?:\s+emails)?$/i.test(line))
      output.push({ line: number, command: "dump" });
    else if (/^(full|status|pause|resume|help)$/i.test(line))
      output.push({
        line: number,
        command: line.toLowerCase() as CommandLineResult["command"],
      });
    else
      output.push({
        line: number,
        error: "Unknown or malformed command; send help for syntax",
      });
    if (output.length > 100)
      return [
        {
          line: 1,
          error:
            "More than 100 command lines; no changes applied. Split and retry.",
        },
      ];
  }
  return output.length
    ? output
    : [{ line: 1, error: "No commands found; send help for syntax" }];
}
export async function applyCommands(
  env: Env,
  id: string,
  sender: AdminIdentity,
  lines: CommandLineResult[],
  now: Date,
): Promise<void> {
  for (let retry = 0; retry < 3; retry++) {
    const settings = await getSettings(env.DB);
    if (![settings.owner, settings.missionary].includes(sender.email))
      throw Error("Requester is not authorized");
    if (
      await stmt(
        env.DB,
        "SELECT inbound_id FROM command_results WHERE inbound_id=?",
        id,
      ).first()
    )
      return;
    const addresses = [
      ...new Set(lines.flatMap((l) => (l.address ? [l.address] : []))),
    ];
    const wantsFull = lines.some((l) => l.command === "full");
    const wantsDump = lines.some((l) => l.command === "dump");
    const members = await rows<Subscriber>(
      env.DB,
      `SELECT id,email,status,generation,version FROM subscribers WHERE email IN (SELECT value FROM json_each(?)) ${wantsDump ? "OR 1=1" : wantsFull ? "OR status='active'" : ""} ORDER BY email LIMIT 5001`,
      JSON.stringify(addresses),
    );
    const map = new Map(members.map((m) => [m.email, { ...m }]));
    const expected = addresses.map((email) => ({
      email,
      version: map.get(email)?.version ?? -1,
    }));
    const snapshot = lines.some((l) => l.command === "status")
      ? await buildSnapshot(env, now)
      : null;
    let paused = settings.paused;
    const results: string[] = [];
    const outputs: string[] = [];
    for (const line of lines) {
      if (line.error) {
        results.push(`${line.line}. Failed: ${line.error}`);
        continue;
      }
      const command = line.command!;
      if (command === "add" || command === "remove") {
        const email = line.address!;
        let member = map.get(email);
        if (!member) {
          member = {
            id: crypto.randomUUID(),
            email,
            status: command === "add" ? "active" : "unsubscribed",
            generation: 1,
            version: 0,
          };
          map.set(email, member);
        } else {
          if (command === "add" && member.status === "unsubscribed")
            member.generation++;
          member.status = command === "add" ? "active" : "unsubscribed";
          member.version++;
        }
        results.push(
          `${line.line}. ${command === "add" ? "Added" : "Removed"} ${email}`,
        );
      } else if (command === "pause" || command === "resume") {
        paused = command === "pause" ? 1 : 0;
        results.push(
          `${line.line}. ${command === "pause" ? "Paused" : "Resumed"} newsletters`,
        );
      } else {
        results.push(`${line.line}. Requested ${command}`);
        if (command === "full")
          outputs.push(
            members.length >= 5001
              ? `Full list is large; view https://${env.ADMIN_HOST}/`
              : Array.from(map.values())
                  .filter((m) => m.status === "active")
                  .map((m) => m.email)
                  .sort()
                  .join("\n") || "No active subscribers",
          );
        if (command === "dump")
          outputs.push(
            members.length >= 5001
              ? "Email list is too large to return by email (over 5000 saved addresses); ask the recovery admin for a database export."
              : Array.from(map.values())
                  .sort((a, b) => a.email.localeCompare(b.email))
                  .map((m) => `${m.email} (${m.status})`)
                  .join("\n") || "No saved subscribers",
          );
        if (command === "status" && snapshot)
          outputs.push(formatSnapshot({ ...snapshot, paused }));
        if (command === "help")
          outputs.push(
            `One command per line; optional matching backticks.\nadd address@example.com\nremove address@example.com\nfull\ndump emails\nstatus\npause\nresume\nhelp\n\nfull lists active subscribers; dump emails lists all saved addresses with subscription status.\n\nManage: ${env.MANAGE_ADDRESS}\nBroadcast: ${env.UPDATE_ADDRESS}\nOnly approved authenticated mail to the update address broadcasts. Success returns a confirmation. Provider restrictions require recovery review.`,
          );
      }
    }
    const failed = lines.some((l) => l.error);
    const changed = lines.some((l) =>
      ["add", "remove", "pause", "resume"].includes(l.command ?? ""),
    );
    const payload = [
      ...outputs,
      ...(failed || changed ? [results.join("\n")] : []),
    ].join("\n\n");
    const mutations = addresses.map((email) => map.get(email)!);
    const t = now.getTime();
    try {
      const statements = [
        stmt(
          env.DB,
          `INSERT INTO command_guards(id,ok) SELECT ?,CASE WHEN (SELECT version FROM settings WHERE id=1)=? AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE COALESCE((SELECT version FROM subscribers s WHERE s.email=json_extract(j.value,'$.email')),-1)!=json_extract(j.value,'$.version')) THEN 1 ELSE 0 END`,
          id,
          settings.version,
          JSON.stringify(expected),
        ),
        stmt(
          env.DB,
          "INSERT INTO command_results(inbound_id,results,created_at) VALUES(?,?,?)",
          id,
          JSON.stringify(results),
          t,
        ),
        stmt(
          env.DB,
          `INSERT INTO subscribers(id,email,status,generation,version,created_at,updated_at,source,consent_version) SELECT json_extract(value,'$.id'),json_extract(value,'$.email'),json_extract(value,'$.status'),json_extract(value,'$.generation'),json_extract(value,'$.version'),?,?,'command','2026-10-v1' FROM json_each(?) WHERE 1 ON CONFLICT(email) DO UPDATE SET status=excluded.status,generation=excluded.generation,version=excluded.version,updated_at=excluded.updated_at,source='command'`,
          t,
          t,
          JSON.stringify(mutations),
        ),
        stmt(
          env.DB,
          "UPDATE settings SET paused=?,version=version+1 WHERE id=1",
          paused,
        ),
        stmt(
          env.DB,
          "UPDATE outbox SET state='cancelled' WHERE kind='newsletter' AND state IN ('pending','retry_wait') AND EXISTS(SELECT 1 FROM subscribers s WHERE s.id=outbox.subscriber_id AND (s.status='unsubscribed' OR s.generation!=outbox.generation))",
        ),
        stmt(
          env.DB,
          "UPDATE inbound_messages SET state='processed' WHERE id=? AND role='command'",
          id,
        ),
        stmt(env.DB, "DELETE FROM command_guards WHERE id=?", id),
      ];
      if (payload)
        statements.push(
          stmt(
            env.DB,
            "INSERT INTO outbox(id,kind,recipient,subject,text,state,due_at,created_at,unique_key,is_summary) VALUES(?,'owner',?,'Mission list management',?,'pending',?,?,?,?)",
            `command:${id}`,
            sender.email,
            payload,
            t,
            t,
            `command:${id}`,
            failed ? 1 : 0,
          ),
        );
      await env.DB.batch(statements);
      return;
    } catch (error) {
      if (
        await stmt(
          env.DB,
          "SELECT inbound_id FROM command_results WHERE inbound_id=?",
          id,
        ).first()
      )
        return;
      if (
        !(error instanceof Error) ||
        !error.message.includes("CHECK constraint failed")
      )
        throw error;
      if (retry === 2)
        throw Error(
          "Concurrent list changes; management request retained for retry",
        );
    }
  }
}
