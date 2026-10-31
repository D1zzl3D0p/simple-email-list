import { archiveAccess, archiveHeaders } from "./archive-access";
import { readBody } from "./body";
import type { Env } from "./types";
import { escapeHtml } from "./util";

export async function handlePublicArchive(
  request: Request,
  env: Env,
  now = new Date(),
): Promise<Response> {
  const access = await archiveAccess(request, env, now);
  if (access) return access;

  const path = new URL(request.url).pathname;
  const selectedId =
    path === "/updates" || path === "/updates/"
      ? null
      : decodeURIComponent(path.slice("/updates/".length));
  try {
    const { results: updates } = await env.DB.prepare(
      "SELECT id,substr(subject,1,120) AS subject,received_at FROM inbound_messages WHERE role='broadcast' AND state!='held' AND is_test=0 ORDER BY received_at DESC,id DESC",
    ).all<ArchiveEntry>();
    const selectedIndex =
      selectedId === null
        ? 0
        : updates.findIndex((entry) => entry.id === selectedId);
    if (selectedId !== null && selectedIndex === -1)
      return readerResponse(request, "Not found", 404);
    if (!updates.length)
      return readerResponse(
        request,
        document(
          "Archive",
          '<section class="archive-empty"><h1>No updates yet</h1><p>Check back for the next mission update.</p></section>',
        ),
      );

    const selected = updates[selectedIndex];
    const stored = await env.DB.prepare(
      "SELECT subject,text,text_key FROM inbound_messages WHERE id=? AND role='broadcast' AND state!='held' AND is_test=0",
    )
      .bind(selected.id)
      .first<{ subject: string; text: string; text_key: string | null }>();
    if (!stored) return readerResponse(request, "Not found", 404);
    // Resolve the canonical body even for HEAD so a missing object has the same status.
    const text = await readBody(env, stored);
    const list = renderHistory(updates, selected.id);
    const navigation = renderNavigation(updates, selectedIndex);
    const content = `<div class="archive-layout">
<section id="archive-timeline" class="archive-index" aria-label="Timeline"><div class="archive-index-controls" hidden><div class="archive-years" role="group" aria-label="Year"></div><div class="archive-months" role="group" aria-label="Month"></div></div><nav class="archive-history" aria-label="Email dates">${list}</nav></section>
<div class="archive-reader">
<article class="archive-message"><header><h1>${escapeHtml(stored.subject)}</h1><time datetime="${new Date(selected.received_at).toISOString()}">${displayDate.format(selected.received_at)}</time></header>
<div class="archive-body">${renderText(text)}</div></article>
</div></div>`;
    return readerResponse(
      request,
      document(stored.subject, content, navigation),
    );
  } catch {
    return readerResponse(
      request,
      document(
        "Update unavailable",
        '<section class="archive-error"><h1>Update temporarily unavailable</h1><p>Please try again in a moment.</p><a href="/updates">Return to updates</a></section>',
      ),
      503,
    );
  }
}

interface ArchiveEntry {
  id: string;
  subject: string;
  received_at: number;
}

const displayDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Denver",
  year: "numeric",
  month: "long",
  day: "numeric",
});
const displayYear = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Denver",
  year: "numeric",
});

function readerResponse(
  request: Request,
  body: string,
  status = 200,
): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: {
      ...archiveHeaders(),
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function document(title: string, content: string, navigation = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} | Archive</title><link rel="stylesheet" href="/styles.css"><script src="/archive.js" defer></script></head>
<body class="newsletter-page public-archive-page"><main class="archive-shell"><header class="archive-header"><a href="/updates">Archive</a><div class="archive-header-actions">${navigation ? '<button type="button" class="archive-control archive-timeline-toggle" aria-expanded="true" aria-controls="archive-timeline" hidden>Timeline</button>' : ""}${navigation}<a class="archive-signup" href="/">Sign up for updates</a></div></header>${content}<footer class="archive-footer"><a href="https://github.com/D1zzl3D0p/simple-email-list" target="_blank" rel="noopener noreferrer">View on GitHub <span aria-hidden="true">↗</span></a></footer></main></body></html>`;
}

function entryPath(entry: ArchiveEntry): string {
  return "/updates/" + encodeURIComponent(entry.id);
}

function renderHistory(updates: ArchiveEntry[], selectedId: string): string {
  const monthFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    month: "long",
  });
  let year = "";
  let month = "";
  let html = "";
  for (const entry of updates) {
    const nextYear = displayYear.format(entry.received_at);
    const nextMonth = monthFormat.format(entry.received_at);
    if (nextYear !== year) {
      if (year) html += "</ul></section></section>";
      year = nextYear;
      month = "";
      html += `<section class="archive-year" data-year="${year}"><h3>${year}</h3>`;
    }
    if (nextMonth !== month) {
      if (month) html += "</ul></section>";
      month = nextMonth;
      html += `<section class="archive-month-group" data-year="${year}" data-month="${month}"><h4>${month}</h4><ul class="archive-date-list">`;
    }
    html += `<li><a class="archive-date-link" href="${escapeHtml(entryPath(entry))}"${entry.id === selectedId ? ' aria-current="page"' : ""}><time datetime="${new Date(entry.received_at).toISOString()}">${displayDate.format(entry.received_at)}</time><span class="archive-list-subject">${escapeHtml(entry.subject)}</span></a></li>`;
  }
  return html + (year ? "</ul></section></section>" : "");
}

function renderNavigation(updates: ArchiveEntry[], index: number): string {
  function control(
    label: string,
    destination: ArchiveEntry | undefined,
  ): string {
    return destination
      ? `<a class="archive-control" href="${escapeHtml(entryPath(destination))}">${label}</a>`
      : `<span class="archive-control" aria-disabled="true">${label}</span>`;
  }
  return `<nav class="archive-navigation" aria-label="Update navigation">${control("← Older", updates[index + 1])}${control("Newer →", updates[index - 1])}</nav>`;
}

function renderText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => {
      let html = "";
      let start = 0;
      for (const match of paragraph.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
        const raw = match[0];
        // Count once, then scan the suffix once so long prose tails stay linear.
        let balance = 0;
        for (const char of raw) {
          if (char === "(") balance++;
          else if (char === ")") balance--;
        }
        let end = raw.length;
        while (end > 0) {
          const last = raw[end - 1];
          if (".,;:!?".includes(last)) end--;
          else if (last === ")" && balance < 0) {
            balance++;
            end--;
          } else break;
        }
        const url = raw.slice(0, end);
        html += escapeHtml(paragraph.slice(start, match.index));
        try {
          const parsed = new URL(url);
          if (!["http:", "https:"].includes(parsed.protocol))
            throw Error("Unsupported link");
          html +=
            `<a href="${escapeHtml(url)}" rel="nofollow noreferrer">${escapeHtml(url)}</a>` +
            escapeHtml(raw.slice(url.length));
        } catch {
          html += escapeHtml(raw);
        }
        start = match.index + raw.length;
      }
      html += escapeHtml(paragraph.slice(start));
      return "<p>" + html.replaceAll("\n", "<br>") + "</p>";
    })
    .join("\n");
}
