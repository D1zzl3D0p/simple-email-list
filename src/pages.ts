import type { Env, Snapshot } from "./types";
import {
  createRemoteJWKSet,
  jwtVerify,
  jwksCache,
  type JWKSCacheInput,
  type JWTVerifyGetKey,
} from "jose";
import { stmt } from "./db";
import {
  snapshotStatement,
  completeSnapshot,
  formatSnapshot,
  type StoredSnapshot,
} from "./report";
import { escapeHtml, htmlResponse } from "./util";
import { readBodyContent } from "./body";
import { layout } from "./archive";
// Only completed public-key JSON/timestamps cross requests. The request owns
// its resolver and any pending fetch, while JOSE controls expiry and rotation.
const accessKeyData = new Map<string, JWKSCacheInput>();
function accessKeys(issuer: string) {
  const url = new URL("/cdn-cgi/access/certs", issuer);
  let data = accessKeyData.get(url.href);
  if (!data) {
    data = {};
    if (accessKeyData.size >= 16)
      accessKeyData.delete(accessKeyData.keys().next().value!);
    accessKeyData.set(url.href, data);
  }
  return createRemoteJWKSet(url, { [jwksCache]: data });
}
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
      key ?? accessKeys(env.ACCESS_ISSUER),
      {
        issuer: env.ACCESS_ISSUER,
        audience: env.ACCESS_AUD,
        algorithms: ["RS256"],
        currentDate: now,
        requiredClaims: ["exp", "email"],
      },
    );
    const settings = await stmt(
      env.DB,
      "SELECT missionary,owner FROM settings WHERE id=1",
    ).first<{ missionary: string; owner: string }>();
    if (!settings) throw Error("Settings missing");
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
  const incidentMatch = /^\/incidents\/(\d+)$/.exec(url.pathname);
  if (incidentMatch) return incidentResponse(incidentMatch[1], env);
  const match = /^\/(archive|raw)\/([^/]+)$/.exec(url.pathname);
  if (match) return archiveResponse(match, env);
  if (url.pathname === "/styles.css") return env.ASSETS.fetch(request);
  if (url.pathname !== "/") return new Response("Not found", { status: 404 });
  return dashboardResponse(url, env, now);
}

async function incidentResponse(id: string, env: Env): Promise<Response> {
  const incident = await stmt(
    env.DB,
    "SELECT code,detail,affected FROM incidents WHERE id=?",
    id,
  ).first<{ code: string; detail: string; affected: number }>();
  if (!incident) return new Response("Not found", { status: 404 });
  return htmlResponse(
    layout(
      "Incident details",
      `<h1>${escapeHtml(incident.code)}</h1><p>${incident.affected} affected</p><pre>${escapeHtml(incident.detail)}</pre><a href="/">Mission dashboard</a>`,
    ),
  );
}

async function archiveResponse(
  match: RegExpExecArray,
  env: Env,
): Promise<Response> {
  const id = decodeURIComponent(match[2]);
  const message = await stmt(
    env.DB,
    "SELECT raw_key,archive_key FROM inbound_messages WHERE id=?",
    id,
  ).first<{
    raw_key: string;
    archive_key: string | null;
  }>();
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
  if (message.archive_key) {
    if (!/^pages\/v1\/[a-f0-9]{64}\.html$/.test(message.archive_key))
      throw Error("Invalid private archive page reference");
    const page = await env.ARCHIVE.get(message.archive_key);
    if (!page)
      return new Response("Archive page unavailable; retry later", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    return htmlResponse(page.body);
  }
  const content = await stmt(
    env.DB,
    "SELECT subject,text,text_key FROM inbound_messages WHERE id=?",
    id,
  ).first<{ subject: string; text: string; text_key: string | null }>();
  if (!content) return new Response("Not found", { status: 404 });
  const body = await readBodyContent(env, content);
  // Native text insertion escapes the complete body without invoking a JS
  // replacement callback for every special character in a large message.
  return new HTMLRewriter()
    .on("pre#archive-body", {
      element(element) {
        element.setInnerContent(body, { html: false });
      },
    })
    .transform(
      htmlResponse(
        layout(
          content.subject,
          `<h1>${escapeHtml(content.subject)}</h1><pre id="archive-body"></pre><a href="/raw/${encodeURIComponent(id)}">Download original email</a>`,
        ),
      ),
    );
}

async function dashboardResponse(
  url: URL,
  env: Env,
  now: Date,
): Promise<Response> {
  const page = (name: string) => {
    const value = url.searchParams.get(name) ?? "0";
    return /^\d{1,9}$/.test(value) ? Number(value) : null;
  };
  const inboxPage = page("inboxPage"),
    incidentPage = page("incidentPage");
  if (inboxPage === null || incidentPage === null)
    return new Response("Invalid page", { status: 400 });
  const navigation = (
    name: "inboxPage" | "incidentPage",
    current: number,
    more: boolean,
  ) => {
    const link = (target: number) => {
      const params = new URLSearchParams();
      if (inboxPage) params.set("inboxPage", String(inboxPage));
      if (incidentPage) params.set("incidentPage", String(incidentPage));
      if (target) params.set(name, String(target));
      else params.delete(name);
      return escapeHtml("/" + (params.size ? "?" + params : ""));
    };
    return `<nav>${current ? `<a href="${link(current - 1)}">Newer entries</a> ` : ""}${more ? `<a href="${link(current + 1)}">Older entries</a>` : ""}</nav>`;
  };
  // One D1 response carries the live snapshot and both bounded lists. Each
  // query still runs against current data; no status or authorization is cached.
  const result = await env.DB.batch([
    snapshotStatement(env, now),
    stmt(
      env.DB,
      // Bound the list payload before it crosses D1; full subjects remain in
      // the authenticated archive. SQLite substr counts Unicode code points.
      "SELECT id,CASE WHEN length(subject)>120 THEN substr(subject,1,120)||'…' ELSE subject END AS subject,state,held_reason FROM inbound_messages ORDER BY received_at DESC,id DESC LIMIT 21 OFFSET ?",
      inboxPage * 20,
    ),
    stmt(
      env.DB,
      "SELECT id,code,CASE WHEN length(detail)>120 THEN substr(detail,1,120)||'…' ELSE detail END AS detail,affected FROM incidents ORDER BY id DESC LIMIT 11 OFFSET ?",
      incidentPage * 10,
    ),
  ]);
  const snapshot = completeSnapshot(
    env,
    now,
    (result[0].results[0] as StoredSnapshot | undefined) ?? null,
  );
  const inbox = result[1].results as {
    id: string;
    subject: string;
    state: string;
    held_reason: string;
  }[];
  const incidents = result[2].results as {
    id: number;
    code: string;
    detail: string;
    affected: number;
  }[];
  return htmlResponse(
    layout(
      "Mission dashboard",
      renderDashboard(snapshot) +
        `<h2>Archive & held mail</h2><ul>${inbox
          .slice(0, 20)
          .map(
            (i) =>
              `<li><a href="/archive/${encodeURIComponent(i.id)}">${escapeHtml(i.subject || "(no subject)")}</a> · ${escapeHtml(i.state)} ${escapeHtml(i.held_reason ?? "")}</li>`,
          )
          .join(
            "",
          )}</ul>${navigation("inboxPage", inboxPage, inbox.length > 20)}<h2>Recent incidents</h2><ul>${incidents
          .slice(0, 10)
          .map(
            (i) =>
              `<li><a href="/incidents/${i.id}">${escapeHtml(i.code)}</a> · ${i.affected} · ${escapeHtml(i.detail)}</li>`,
          )
          .join(
            "",
          )}</ul>${navigation("incidentPage", incidentPage, incidents.length > 10)}`,
    ),
  );
}
