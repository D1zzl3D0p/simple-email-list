import { stmt } from "./db";
import { boundedBytes, escapeHtml, htmlResponse, sha256 } from "./util";
import type { Env } from "./types";
export function normalizeAddress(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length > 254 || /[\r\n]/.test(input)) return null;
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (
    !local ||
    local.length > 64 ||
    !domain ||
    !domain.includes(".") ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  )
    return null;
  if (
    !domain
      .split(".")
      .every(
        (l) => l.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l),
      )
  )
    return null;
  return email;
}
export function signupPage(env: Env, email = "", error = "") {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mission updates</title><link rel="stylesheet" href="/styles.css"><main><p class="eyebrow">Friends & family</p><h1>Stay close to the journey.</h1><p>Receive occasional mission updates by email. Unsubscribe whenever you like.</p>${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}<form method="post" action="/subscribe"><label for="email">Your email</label><input id="email" name="email" type="email" maxlength="254" value="${escapeHtml(email)}" required autocomplete="email"><label class="honey" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label><div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY)}" data-action="subscribe"></div><button>Subscribe to updates</button></form><p class="fine">By subscribing, you agree to receive these personal updates. No account needed.</p></main><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><script src="/signup.js" defer></script></html>`;
}
export async function handleSignup(
  request: Request,
  env: Env,
  now: Date,
): Promise<Response> {
  if (request.method !== "POST") return htmlResponse(signupPage(env));
  let typed = "";
  try {
    if (
      !request.headers
        .get("content-type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      return htmlResponse(
        signupPage(env, "", "Please retry using the signup form."),
        400,
      );
    const bytes = await boundedBytes(request.body, 8192);
    const data = new URLSearchParams(new TextDecoder().decode(bytes));
    typed = (data.get("email") ?? "").slice(0, 254);
    const address = normalizeAddress(data.get("email") ?? "");
    const token = data.get("cf-turnstile-response");
    if (!address || !token || token.length > 2048 || data.get("website"))
      return htmlResponse(
        signupPage(
          env,
          typed,
          "Check your email and complete the challenge, then retry.",
        ),
        400,
      );
    let result: { success?: boolean; hostname?: string; action?: string };
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
      if (!response.ok) throw Error("validation outage");
      result = await response.json();
    } catch {
      console.error(JSON.stringify({ code: "signup_validation_unavailable" }));
      try {
        await stmt(
          env.DB,
          "INSERT INTO rate_counters(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
          `diagnostic:validation:${now.toISOString().slice(0, 10)}`,
          now.getTime() + 7 * 86400000,
        ).run();
      } catch {
        console.error(
          JSON.stringify({ code: "signup_diagnostic_persistence_failed" }),
        );
      }
      return htmlResponse(
        signupPage(
          env,
          typed,
          "Validation is temporarily unavailable. Please retry.",
        ),
        503,
      );
    }
    if (
      !result.success ||
      result.hostname !== new URL(env.PUBLIC_URL).hostname ||
      result.action !== "subscribe"
    )
      return htmlResponse(
        signupPage(
          env,
          typed,
          "Challenge expired or failed. Complete a new challenge and retry.",
        ),
        400,
      );
    const network = await sha256(
      env.CAPABILITY_SECRET +
        ":" +
        (request.headers.get("cf-connecting-ip") ?? "unknown") +
        ":" +
        Math.floor(now.getTime() / 86400000),
    );
    await env.DB.batch([
      stmt(
        env.DB,
        `INSERT INTO subscribers(id,email,status,generation,created_at,updated_at,source,consent_version) VALUES(?,?,'active',1,?,?,'public','2026-10-v1')
      ON CONFLICT(email) DO UPDATE SET status='active',generation=subscribers.generation+CASE WHEN subscribers.status='unsubscribed' THEN 1 ELSE 0 END,version=subscribers.version+1,updated_at=excluded.updated_at,source='public',consent_version=excluded.consent_version`,
        crypto.randomUUID(),
        address,
        now.getTime(),
        now.getTime(),
      ),
      stmt(
        env.DB,
        "INSERT INTO rate_counters(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
        network,
        now.getTime() + 172800000,
      ),
    ]);
    return htmlResponse(
      '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><main><h1>You’re on the list.</h1><p>Thanks for following along. Future updates will arrive by email.</p></main></html>',
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Input too large"))
      return htmlResponse(
        signupPage(env, typed, "Form is too large. Please retry."),
        400,
      );
    console.error(JSON.stringify({ code: "signup_persistence_failed" }));
    return htmlResponse(
      signupPage(env, typed, "We could not save your signup. Please retry."),
      503,
    );
  }
}
