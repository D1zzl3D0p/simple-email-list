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
