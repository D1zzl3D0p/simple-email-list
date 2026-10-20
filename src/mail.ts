import PostalMime from "postal-mime";
import { convert } from "html-to-text";
import { getSettings, stmt } from "./db";
import { escapeHtml, sha256 } from "./util";
import type { Env } from "./types";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

// Read only the bounded header block before sender authorization and DKIM.
// Untrusted MIME bodies must not consume parser/rendering CPU before that gate.
export async function parseMailHeaders(raw: Uint8Array) {
  for (let i = 0; i + 3 < Math.min(raw.length, 32768); i++) {
    if (
      raw[i] === 13 &&
      raw[i + 1] === 10 &&
      raw[i + 2] === 13 &&
      raw[i + 3] === 10
    )
      return PostalMime.parse(raw.subarray(0, i + 4));
  }
  throw Error("Email requires CRLF headers within 32 KiB");
}

type ParsedHeaders = Awaited<ReturnType<typeof parseMailHeaders>>;

async function parseMime(raw: Uint8Array, headers?: ParsedHeaders) {
  // Only a canonical, unencoded UTF-8 single text part can skip PostalMime's
  // per-line body processing. PostalMime still parses every header. Unusual
  // headers, MIME parameters and body bytes take the complete maintained path.
  // This bounds optimization work, not accepted message/header size.
  const headerLimit = Math.min(raw.length, 32 * 1024);
  let bodyStart = -1;
  for (let i = 0; i + 3 < headerLimit; i++) {
    if (
      raw[i] === 13 &&
      raw[i + 1] === 10 &&
      raw[i + 2] === 13 &&
      raw[i + 3] === 10
    ) {
      bodyStart = i + 4;
      break;
    }
  }
  if (bodyStart < 0) return PostalMime.parse(raw);

  let headerText: string;
  try {
    headerText = strictUtf8.decode(raw.subarray(0, bodyStart - 4));
  } catch {
    return PostalMime.parse(raw);
  }
  const lines = headerText.split("\r\n");
  if (
    !/^[\x20-\x7e\t\r\n]*$/.test(headerText) ||
    lines.some(
      (line, index) =>
        !line ||
        /[\r\n]/.test(line) ||
        (/^[ \t]/.test(line)
          ? index === 0 || !/[^ \t]/.test(line)
          : !/^[!\x23-\x39\x3b-\x7e]+:/.test(line)),
    )
  ) {
    return PostalMime.parse(raw);
  }

  const parsed =
    headers ?? (await PostalMime.parse(raw.subarray(0, bodyStart)));
  const contentTypes = parsed.headers.filter((h) => h.key === "content-type");
  const encodings = parsed.headers.filter(
    (h) => h.key === "content-transfer-encoding",
  );
  if (
    contentTypes.length !== 1 ||
    !/^text\/plain; charset=utf-8$/i.test(contentTypes[0].value) ||
    encodings.length > 1 ||
    encodings.some((h) => !/^(?:7bit|8bit)$/i.test(h.value)) ||
    parsed.headers.some(
      (h) =>
        h.key.startsWith("content-") &&
        h.key !== "content-type" &&
        h.key !== "content-transfer-encoding",
    )
  ) {
    return PostalMime.parse(raw);
  }

  let body: string;
  try {
    body = strictUtf8.decode(raw.subarray(bodyStart));
  } catch {
    return PostalMime.parse(raw);
  }
  if (
    /\r(?!\n)/.test(body) ||
    (encodings[0]?.value.toLowerCase() === "8bit"
      ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)
      : /[^\x09\x0a\x0d\x20-\x7e]/.test(body))
  ) {
    return PostalMime.parse(raw);
  }
  if (body) {
    // PostalMime normalizes CRLF and supplies LF when the last line has none.
    parsed.text =
      body.replace(/\r\n/g, "\n") + (body.endsWith("\n") ? "" : "\n");
  }
  return parsed;
}

export async function parseMail(raw: Uint8Array, headers?: ParsedHeaders) {
  const parsed = await parseMime(raw, headers);
  // Updates and commands consume text only; decoded attachments are discarded.
  parsed.attachments = [];
  const text = (
    parsed.text ??
    convert(parsed.html ?? "", {
      wordwrap: false,
      limits: { maxInputLength: 1048576 },
      selectors: [
        { selector: "script", format: "skip" },
        { selector: "style", format: "skip" },
        { selector: "img", format: "skip" },
      ],
    })
  )
    .replace(/\r\n/g, "\n")
    .trim();
  const subject = (parsed.subject ?? "").normalize("NFC").trim();
  // Hash the complete text directly. Encoding its JSON-escaped copy adds another
  // full-body allocation and scan, while the metadata only needs its identity.
  const textHash = await sha256(text);
  return {
    parsed,
    text,
    subject,
    fingerprint: await sha256(
      JSON.stringify({ subject, textHash, attachments: [] }),
    ),
    // Receipt persists text only. Render HTML on demand for callers that use it.
    get html() {
      return `<pre>${escapeHtml(text)}</pre>`;
    },
  };
}
export async function prepareNextMessage(env: Env, now: Date): Promise<void> {
  const inbound = await env.DB.prepare(
    "SELECT id FROM inbound_messages WHERE state='pending' AND role='broadcast' ORDER BY received_at,id LIMIT 1",
  ).first<{ id: string }>();
  if (!inbound) return;
  const settings = await getSettings(env.DB);
  const id = inbound.id;
  // The INSERT SELECT and state transition share one D1 transaction. No per-member SQL.
  await env.DB.batch([
    stmt(
      env.DB,
      "INSERT OR IGNORE INTO broadcasts(id,inbound_id,subject,text,text_key,album_url,created_at,completion_reported) SELECT id,id,subject,text,text_key,?,?,0 FROM inbound_messages WHERE id=? AND state='pending'",
      settings.album_url,
      now.getTime(),
      id,
    ),
    stmt(
      env.DB,
      "INSERT OR IGNORE INTO outbox(id,kind,recipient,broadcast_id,subscriber_id,generation,state,due_at,created_at) SELECT ?||':'||s.id,'newsletter',s.email,?,s.id,s.generation,'pending',?,? FROM subscribers s WHERE s.status='active' AND NOT EXISTS(SELECT 1 FROM suppressions x WHERE x.email=s.email) AND EXISTS(SELECT 1 FROM inbound_messages WHERE id=? AND state='pending')",
      id,
      id,
      now.getTime(),
      now.getTime(),
      id,
    ),
    stmt(
      env.DB,
      "UPDATE inbound_messages SET state='prepared' WHERE id=? AND state='pending'",
      id,
    ),
  ]);
}
