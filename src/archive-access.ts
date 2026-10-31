import type { Env } from "./types";
import { boundedBytes, escapeHtml } from "./util";

const COOKIE = "__Host-mission_archive";
const LIFETIME = 86400000;
const PURPOSE = "mission-archive";
const SIGNING_CONTEXT = "mission-archive:v1:";
const encoder = new TextEncoder();

export function archiveHeaders(): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

function readerPath(path: string): boolean {
  if (path === "/updates" || path === "/updates/") return true;
  const parts = path.split("/");
  if (
    path.length > 2048 ||
    /[^\x21-\x7e]/.test(path) ||
    parts.length !== 3 ||
    parts[1] !== "updates" ||
    !parts[2] ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\")
  )
    return false;
  try {
    const id = decodeURIComponent(parts[2]);
    return (
      id !== "verify" &&
      id !== "." &&
      id !== ".." &&
      !id.includes("/") &&
      !id.includes("\\") &&
      !Array.from(id).some(
        (c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127,
      )
    );
  } catch {
    return false;
  }
}

function respond(
  request: Request,
  body: string,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: {
      ...archiveHeaders(),
      "Content-Type": "text/html; charset=utf-8",
      ...extra,
    },
  });
}

function gate(
  request: Request,
  env: Env,
  target: string,
  error = "",
  status = 200,
): Response {
  return respond(
    request,
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Archive · Mission newsletter</title>
<link rel="stylesheet" href="/styles.css"></head>
<body class="newsletter-page"><main class="newsletter-main archive-gate" id="main">
<section class="newsletter-card" aria-labelledby="archive-heading"><h1 id="archive-heading">Archive</h1>
<p>Complete the challenge to read past mission updates. No signup is required.</p>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/updates/verify">
<input type="hidden" name="return" value="${escapeHtml(target)}">
<div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY)}" data-action="archive" data-theme="light" data-size="flexible"></div>
<button type="submit">Read updates</button></form><p><a href="/">Back to the newsletter</a></p></section></main>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></body></html>`,
    status,
  );
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("Invalid pass encoding");
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (base64url(bytes) !== value) throw Error("Noncanonical pass encoding");
  return bytes;
}

function signingKey(
  secret: string,
  usage: ("sign" | "verify")[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

async function issuePass(
  env: Env,
  host: string,
  time: number,
): Promise<string> {
  const payload = base64url(
    encoder.encode(
      JSON.stringify({
        purpose: PURPOSE,
        host,
        issuedAt: time,
        expiresAt: time + LIFETIME,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(env.CAPABILITY_SECRET, ["sign"]),
    encoder.encode(SIGNING_CONTEXT + payload),
  );
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

async function validPass(
  request: Request,
  env: Env,
  host: string,
  time: number,
): Promise<boolean> {
  const header = request.headers.get("Cookie") ?? "";
  if (header.length > 8192) return false;
  const cookies = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(COOKIE + "="));
  if (cookies.length !== 1) return false;
  const token = cookies[0].slice(COOKIE.length + 1);
  if (token.length > 2048) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const [payload, signature] = parts;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await signingKey(env.CAPABILITY_SECRET, ["verify"]),
        decode(signature),
        encoder.encode(SIGNING_CONTEXT + payload),
      ))
    )
      return false;
    const pass: unknown = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (!pass || typeof pass !== "object") return false;
    const p = pass as Record<string, unknown>;
    return (
      p.purpose === PURPOSE &&
      p.host === host &&
      typeof p.issuedAt === "number" &&
      Number.isSafeInteger(p.issuedAt) &&
      typeof p.expiresAt === "number" &&
      Number.isSafeInteger(p.expiresAt) &&
      p.expiresAt - p.issuedAt === LIFETIME &&
      p.issuedAt <= time &&
      time < p.expiresAt
    );
  } catch {
    return false;
  }
}

async function verifyChallenge(
  request: Request,
  env: Env,
  host: string,
  time: number,
): Promise<Response> {
  let target = "/updates";
  let token: string;
  try {
    if (
      request.headers
        .get("Content-Type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/x-www-form-urlencoded"
    )
      throw Error("Invalid form");
    const data = new URLSearchParams(
      new TextDecoder().decode(await boundedBytes(request.body, 8192)),
    );
    const returns = data.getAll("return");
    const tokens = data.getAll("cf-turnstile-response");
    if (returns.length > 1 || tokens.length !== 1) throw Error("Invalid form");
    target = returns[0] ?? "/updates";
    token = tokens[0];
    if (!readerPath(target) || !token.trim() || token.length > 2048)
      throw Error("Invalid form");
  } catch {
    return gate(
      request,
      env,
      readerPath(target) ? target : "/updates",
      "Please complete a new challenge and retry.",
      400,
    );
  }
  let result: unknown;
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET,
          response: token,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw Error("Validation unavailable");
    result = await response.json();
  } catch {
    return gate(
      request,
      env,
      target,
      "Validation is temporarily unavailable. Please retry.",
      503,
    );
  }
  if (
    !result ||
    typeof result !== "object" ||
    (result as Record<string, unknown>).success !== true ||
    (result as Record<string, unknown>).hostname !== host ||
    (result as Record<string, unknown>).action !== "archive"
  ) {
    return gate(
      request,
      env,
      target,
      "Challenge expired or failed. Complete a new challenge and retry.",
      400,
    );
  }
  const pass = await issuePass(env, host, time);
  return respond(request, "", 303, {
    Location: target,
    "Set-Cookie": `${COOKIE}=${pass}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`,
  });
}

export async function archiveAccess(
  request: Request,
  env: Env,
  now = new Date(),
): Promise<Response | null> {
  const url = new URL(request.url);
  const host = new URL(env.PUBLIC_URL).hostname;
  if (url.hostname !== host) return respond(request, "Not found", 404);
  if (url.pathname === "/updates/verify") {
    if (request.method !== "POST")
      return respond(request, "Method not allowed", 405, { Allow: "POST" });
    return verifyChallenge(request, env, host, now.getTime());
  }
  if (!readerPath(url.pathname)) return respond(request, "Not found", 404);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return respond(request, "Method not allowed", 405, { Allow: "GET, HEAD" });
  }
  if (await validPass(request, env, host, now.getTime())) return null;
  return gate(request, env, url.pathname);
}
