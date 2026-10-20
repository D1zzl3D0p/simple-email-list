import { receiveEmail } from "./inbound";
import type { Env } from "./types";
import { handleSignup, signupPage } from "./signup";
import { handleUnsubscribe, handleResubscribe } from "./unsubscribe";
import { htmlResponse } from "./util";
import { runScheduled } from "./delivery";
import { handleSnsEvents } from "./events";
import { handleAdmin } from "./pages";
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.hostname === env.ADMIN_HOST) return handleAdmin(request, env);
    if (url.hostname !== new URL(env.PUBLIC_URL).hostname)
      return new Response("Not found", { status: 404 });
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
      await receiveEmail(message, env);
    } catch (error) {
      console.error(JSON.stringify({ code: "receipt_failed" }));
      message.setReject(
        error instanceof Error ? error.message : "Receipt failed; retry later",
      );
    }
  },
  async scheduled(controller: ScheduledController, env: Env) {
    await runScheduled(env, new Date(controller.scheduledTime));
  },
};
