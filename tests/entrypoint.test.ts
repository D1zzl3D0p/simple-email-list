import { expect, test, vi } from "vitest";
import worker from "../src/index";
import { testEnv } from "./helpers";

test("QR requests serve the prebuilt asset without generating it in the Worker", async () => {
  const fetch = vi.fn(
    async () =>
      new Response("prebuilt-qr", {
        headers: { "content-type": "image/svg+xml" },
      }),
  );
  const env = testEnv({
    ASSETS: { fetch } as unknown as ReturnType<typeof testEnv>["ASSETS"],
  });
  const request = new Request(env.PUBLIC_URL + "/qr.svg");
  const response = await worker.fetch(request, env);
  expect(await response.text()).toBe("prebuilt-qr");
  expect(fetch).toHaveBeenCalledWith(request);
});

test("archive gate is served on the configured public host without invoking static assets", async () => {
  const env = testEnv({
    ASSETS: {
      fetch() {
        throw Error("Archive request escaped to static assets");
      },
    } as unknown as ReturnType<typeof testEnv>["ASSETS"],
  });
  const response = await worker.fetch(
    new Request(env.PUBLIC_URL + "/updates"),
    env,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('action="/updates/verify"');
});
