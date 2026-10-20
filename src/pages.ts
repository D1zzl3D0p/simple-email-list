import type { Env, Snapshot } from "./types";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { getSettings, rows, stmt } from "./db";
import { buildSnapshot, formatSnapshot } from "./report";
import { escapeHtml, htmlResponse } from "./util";
const layout = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"><main>${body}</main></html>`;
export function renderDashboard(s: Snapshot): string {
  return `<h1>Mission status</h1><pre>${escapeHtml(formatSnapshot(s))}</pre><p>Accepted means SES accepted the request. Delivered means the receiving server accepted the email.</p>`;
}
export async function handleAdmin(
  request: Request,
  env: Env,
  now = new Date(),
  key?: JWTVerifyGetKey,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== env.ADMIN_HOST)
    return new Response("Not found", { status: 404 });
  if (request.method !== "GET")
    return new Response("Read only", { status: 405 });
  try {
    if (!env.ACCESS_ISSUER || !env.ACCESS_AUD)
      throw Error("Access unconfigured");
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token) throw Error("No JWT");
    const verified = await jwtVerify(
      token,
      key ??
        createRemoteJWKSet(new URL("/cdn-cgi/access/certs", env.ACCESS_ISSUER)),
      {
        issuer: env.ACCESS_ISSUER,
        audience: env.ACCESS_AUD,
        algorithms: ["RS256"],
        currentDate: now,
        requiredClaims: ["exp", "email"],
      },
    );
    const settings = await getSettings(env.DB);
    if (
      ![settings.missionary, settings.owner].includes(
        String(verified.payload.email).toLowerCase(),
      )
    )
      throw Error("Unapproved identity");
  } catch {
    return new Response("Access denied", {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }
  const match = /^\/(archive|raw)\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const message = await stmt(
      env.DB,
      "SELECT subject,text,raw_key FROM inbound_messages WHERE id=?",
      decodeURIComponent(match[2]),
    ).first<{ subject: string; text: string; raw_key: string }>();
    if (!message) return new Response("Not found", { status: 404 });
    if (match[1] === "raw") {
      const object = await env.ARCHIVE.get(message.raw_key);
      if (!object) return new Response("Original unavailable", { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="original.eml"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return htmlResponse(
      layout(
        message.subject,
        `<h1>${escapeHtml(message.subject)}</h1><pre>${escapeHtml(message.text)}</pre><a href="/raw/${encodeURIComponent(match[2])}">Download original email</a>`,
      ),
    );
  }
  if (url.pathname === "/styles.css") return env.ASSETS.fetch(request);
  if (url.pathname !== "/") return new Response("Not found", { status: 404 });
  const [snapshot, inbox, incidents] = await Promise.all([
    buildSnapshot(env, now),
    rows<{ id: string; subject: string; state: string; held_reason: string }>(
      env.DB,
      "SELECT id,subject,state,held_reason FROM inbound_messages ORDER BY received_at DESC LIMIT 100",
    ),
    rows<{ code: string; detail: string; affected: number }>(
      env.DB,
      "SELECT code,detail,affected FROM incidents ORDER BY id DESC LIMIT 50",
    ),
  ]);
  return htmlResponse(
    layout(
      "Mission dashboard",
      renderDashboard(snapshot) +
        `<h2>Archive & held mail</h2><ul>${inbox.map((i) => `<li><a href="/archive/${encodeURIComponent(i.id)}">${escapeHtml(i.subject || "(no subject)")}</a> · ${escapeHtml(i.state)} ${escapeHtml(i.held_reason ?? "")}</li>`).join("")}</ul><h2>Recent incidents</h2><ul>${incidents.map((i) => `<li>${escapeHtml(i.code)} · ${i.affected} · ${escapeHtml(i.detail)}</li>`).join("")}</ul>`,
    ),
  );
}
