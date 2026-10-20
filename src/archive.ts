import type { Env } from "./types";
import { rows, stmt } from "./db";
import { readBody } from "./body";
import { escapeHtml, sha256 } from "./util";

export const layout = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"><main>${body}</main></html>`;

// Render only in background work. The object stays private and every HTTP read
// must pass admin authorization. Versioned keys allow future format rebuilds.
export async function storeArchivePage(
  env: Env,
  id: string,
  subject: string,
  text: string,
): Promise<string> {
  const key = `pages/v1/${await sha256(id)}.html`;
  await env.ARCHIVE.put(
    key,
    layout(
      subject,
      `<h1>${escapeHtml(subject)}</h1><pre id="archive-body">${escapeHtml(text)}</pre><a href="/raw/${encodeURIComponent(id)}">Download original email</a>`,
    ),
    {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    },
  );
  return key;
}

export async function prepareArchivePages(
  env: Env,
  limit = 25,
): Promise<number> {
  const pending = await rows<{
    id: string;
    subject: string;
    text: string;
    text_key: string | null;
  }>(
    env.DB,
    "SELECT id,subject,text,text_key FROM inbound_messages WHERE archive_key IS NULL ORDER BY received_at,id LIMIT ?",
    limit,
  );
  for (const message of pending) {
    const key = await storeArchivePage(
      env,
      message.id,
      message.subject,
      await readBody(env, message),
    );
    // A failed object write never creates a reference. Concurrent rebuilds are
    // harmless because archived message content is immutable.
    await stmt(
      env.DB,
      "UPDATE inbound_messages SET archive_key=? WHERE id=? AND archive_key IS NULL",
      key,
      message.id,
    ).run();
  }
  return pending.length;
}
