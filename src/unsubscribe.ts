import { stmt } from "./db";
import { escapeHtml, htmlResponse } from "./util";
import type { Env } from "./types";
const encode = (data: Uint8Array) =>
  btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
async function key(env: Env) {
  if (env.CAPABILITY_SECRET.length < 32)
    throw Error("Capability secret must be at least 32 characters");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.CAPABILITY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function capability(
  env: Env,
  purpose: "leave" | "undo",
  id: string,
  generation: number,
): Promise<string> {
  const payload = encode(
    new TextEncoder().encode(JSON.stringify([purpose, id, generation])),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(env),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
async function verify(
  env: Env,
  token: string,
  purpose: string,
): Promise<{ id: string; generation: number } | null> {
  try {
    if (token.length > 1024) return null;
    const [p, s, ...extra] = token.split(".");
    if (
      extra.length ||
      !p ||
      !s ||
      !(await crypto.subtle.verify(
        "HMAC",
        await key(env),
        decode(s),
        new TextEncoder().encode(p),
      ))
    )
      return null;
    const [scope, id, generation] = JSON.parse(
      new TextDecoder().decode(decode(p)),
    );
    return scope === purpose &&
      typeof id === "string" &&
      Number.isSafeInteger(generation) &&
      generation > 0
      ? { id, generation }
      : null;
  } catch {
    return null;
  }
}
export function unsubscribeUrl(settings: { publicUrl: string }, token: string) {
  return `${settings.publicUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
}
export async function handleUnsubscribe(
  request: Request,
  env: Env,
  now: Date,
): Promise<Response> {
  if (!["GET", "POST"].includes(request.method))
    return new Response("Method not allowed", { status: 405 });
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const c = await verify(env, token, "leave");
  if (!c)
    return htmlResponse(
      "Invalid unsubscribe link. Use a link from your latest update.",
      400,
    );
  if (request.method === "GET")
    return htmlResponse(
      `<main><h1>Leave mission updates?</h1><form method="post"><button>Unsubscribe</button></form></main>`,
    );
  await env.DB.batch([
    stmt(
      env.DB,
      "UPDATE subscribers SET status='unsubscribed',version=version+1,updated_at=? WHERE id=? AND generation=? AND status='active'",
      now.getTime(),
      c.id,
      c.generation,
    ),
    stmt(
      env.DB,
      "UPDATE outbox SET state='cancelled' WHERE subscriber_id=? AND generation=? AND state IN ('pending','retry_wait') AND EXISTS(SELECT 1 FROM subscribers WHERE id=? AND generation=? AND status='unsubscribed')",
      c.id,
      c.generation,
      c.id,
      c.generation,
    ),
  ]);
  const undo = await capability(env, "undo", c.id, c.generation);
  return htmlResponse(
    `<main><h1>Unsubscribe request saved.</h1><p>This link only applies to its original subscription.</p><form method="post" action="/resubscribe?token=${encodeURIComponent(undo)}"><button>Undo unsubscribe / subscribe again</button></form><a href="${escapeHtml(env.PUBLIC_URL)}">Public signup page</a></main>`,
  );
}
export async function handleResubscribe(
  request: Request,
  env: Env,
  now: Date,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Use the confirmation button", { status: 405 });
  const c = await verify(
    env,
    new URL(request.url).searchParams.get("token") ?? "",
    "undo",
  );
  if (!c) return htmlResponse("Invalid undo link", 400);
  await stmt(
    env.DB,
    "UPDATE subscribers SET status='active',generation=generation+1,version=version+1,updated_at=?,source='undo' WHERE id=? AND generation=? AND status='unsubscribed'",
    now.getTime(),
    c.id,
    c.generation,
  ).run();
  return htmlResponse(
    "<main><h1>Resubscription request saved.</h1><p>You can also subscribe through the public signup page. Provider delivery restrictions still apply.</p></main>",
  );
}
export function newsletterContent(
  text: string,
  album: string,
  publicUrl: string,
  leave: string,
) {
  const body = `${text}\n\nPhotos: ${album}\nShare / subscribe: ${publicUrl}\n\nPersonal unsubscribe: ${leave}`;
  return {
    text: body,
    html: `<div style="white-space:pre-wrap">${escapeHtml(text)}</div><p><a href="${escapeHtml(album)}">Google Photos album</a></p><p><a href="${escapeHtml(publicUrl)}">Share / subscribe</a></p><hr style="margin-top:32px"><p><a href="${escapeHtml(leave)}">Personal unsubscribe</a></p>`,
  };
}
