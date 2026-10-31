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
const githubUrl = "https://github.com/D1zzl3D0p/simple-email-list";

function newsletterPage(content: string, success = false, signupOpen = true) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Sign up for Mission Newsletter. Personal letters and updates from my mission, delivered by email.">
  <title>${success ? "You’re on the list · " : ""}Mission Newsletter</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="newsletter-page">
  <div class="newsletter-shell">
    <main class="newsletter-main" id="main">
      <div class="newsletter-intro">
        <h1 id="newsletter-heading">Mission Newsletter</h1>
      </div>
      <section class="newsletter-card" aria-labelledby="${success ? "signup-heading" : "newsletter-heading"}">
        ${content}
      </section>
      <p class="newsletter-archive-link"><a href="/updates">Archive</a></p>
    </main>
    <footer class="newsletter-footer">
      <a href="${githubUrl}" target="_blank" rel="noopener noreferrer"><svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.73 1.16 1.73 1.16 1 .1.77 2.05 3.27 1.41.1-.73.39-1.23.71-1.51-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.09 1.15a10.75 10.75 0 0 1 5.62 0c2.14-1.45 3.09-1.15 3.09-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.28-5.14 5.56.4.35.76 1.03.76 2.08v3.12c0 .3.2.65.78.54A11.25 11.25 0 0 0 12 .75Z"/></svg>View on GitHub<span aria-hidden="true">↗</span></a>
    </footer>
  </div>
  ${success || !signupOpen ? "" : '<script src="/signup.js"></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'}
</body>
</html>`;
}

export function signupPage(env: Env, email = "", error = "") {
  if (
    env.STAGE === "production" &&
    (env.SENDING_ENABLED !== "true" || env.SIGNUP_ENABLED !== "true")
  ) {
    return newsletterPage(
      "<p>Signup opens soon. Please check back.</p>",
      false,
      false,
    );
  }
  return newsletterPage(`
    ${error ? `<p role="alert" id="signup-error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/subscribe">
      <label for="email">Email address</label>
      <input id="email" name="email" type="email" maxlength="254" value="${escapeHtml(email)}" placeholder="you@example.com" required autocomplete="email" autocapitalize="none" spellcheck="false"${error ? ' aria-describedby="signup-error"' : ""}>
      <label class="honey" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
      <div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY)}" data-action="subscribe" data-theme="light" data-size="flexible"></div>
      <button type="submit">Sign up</button>
      <p class="newsletter-consent">Unsubscribe anytime.</p>
    </form>`);
}
export async function handleSignup(
  request: Request,
  env: Env,
  now: Date,
): Promise<Response> {
  if (
    env.STAGE === "production" &&
    (env.SENDING_ENABLED !== "true" || env.SIGNUP_ENABLED !== "true")
  ) {
    const response = htmlResponse(signupPage(env), 503);
    response.headers.set("Retry-After", "3600");
    return response;
  }
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
    const saved = await env.DB.batch([
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
        `INSERT OR IGNORE INTO outbox(id,kind,recipient,subscriber_id,generation,subject,text,state,due_at,created_at,unique_key,is_welcome)
        SELECT 'welcome:'||s.id||':'||s.generation,'newsletter',s.email,s.id,s.generation,
          'Welcome to '||substr(settings.display_name,1,120),
          'You’re subscribed to '||settings.display_name||'.'||char(10)||char(10)||'Your signup is complete. Future newsletters will arrive at this address. If you did not mean to subscribe, use the unsubscribe link below.',
          'pending',?,?,'welcome:'||s.id||':'||s.generation,1
        FROM subscribers s CROSS JOIN settings WHERE settings.id=1 AND s.email=? AND s.status='active'
        AND NOT EXISTS(SELECT 1 FROM suppressions x WHERE x.email=s.email)`,
        now.getTime(),
        now.getTime(),
        address,
      ),
      stmt(
        env.DB,
        "INSERT INTO rate_counters(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
        network,
        now.getTime() + 172800000,
      ),
    ]);
    if (saved[1].meta.changes && env.SENDING_ENABLED === "true") {
      try {
        await env.JOBS.send({ type: "scheduled" });
      } catch {
        // Membership and mail are committed. Regular cron will drain the outbox.
        console.error(JSON.stringify({ code: "welcome_signal_failed" }));
      }
    }
    return htmlResponse(
      newsletterPage(
        `<h2 id="signup-heading">You’re on the list.</h2><p class="newsletter-card-description">You’re subscribed as <strong>${escapeHtml(address)}</strong>. ${saved[1].meta.changes ? "Look out for a welcome email shortly." : "Future newsletters will arrive at this address."}</p><a class="newsletter-back" href="/">Back to the newsletter <span aria-hidden="true">↗</span></a>`,
        true,
      ),
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
