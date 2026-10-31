import type { Env } from "./types";
import { handleSignup, signupPage } from "./signup";
import { handleUnsubscribe, handleResubscribe } from "./unsubscribe";
import { htmlResponse } from "./util";
import { queueReceipt, recoverReceiptJobs, handleJobs } from "./jobs";
import { handleSnsEvents } from "./events";
import { handleAdmin } from "./pages";
import { handlePublicArchive } from "./public-archive";
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.hostname === env.ADMIN_HOST) return handleAdmin(request, env);
    if (url.hostname !== new URL(env.PUBLIC_URL).hostname)
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/updates" || url.pathname.startsWith("/updates/"))
      return handlePublicArchive(request, env);
    if (url.pathname === "/robots.txt") {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      return new Response(
        request.method === "HEAD" ? null : "User-agent: *\nDisallow: /\n",
        {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        },
      );
    }
    if (url.pathname === "/events/sns")
      return handleSnsEvents(request, env, new Date());
    if (url.pathname === "/") return htmlResponse(signupPage(env));
    if (url.pathname === "/subscribe")
      return handleSignup(request, env, new Date());
    if (url.pathname === "/unsubscribe")
      return handleUnsubscribe(request, env, new Date());
    if (url.pathname === "/resubscribe")
      return handleResubscribe(request, env, new Date());
    if (url.pathname === "/health") return new Response("ok");
    return env.ASSETS.fetch(request);
  },
  async email(message: ForwardableEmailMessage, env: Env) {
    try {
      await queueReceipt(message, env);
    } catch (error) {
      console.error(JSON.stringify({ code: "receipt_failed" }));
      message.setReject(
        error instanceof Error ? error.message : "Receipt failed; retry later",
      );
    }
  },
  async scheduled(controller: ScheduledController, env: Env) {
    await recoverReceiptJobs(env, new Date(controller.scheduledTime));
    // Separate queue invocations keep historical page preparation within its
    // own D1 query allowance instead of spending the delivery job's budget.
    await env.JOBS.sendBatch([
      { body: { type: "scheduled" } },
      { body: { type: "archives" } },
      { body: { type: "summaries" } },
    ]);
  },
  async queue(batch: MessageBatch<unknown>, env: Env) {
    await handleJobs(batch, env);
  },
};
