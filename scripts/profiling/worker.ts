// Local profiling entrypoint only. Never deploy this fixture harness.
import { authenticateDkim } from "../../src/inbound-auth";
import { parseMail, parseMailHeaders } from "../../src/mail";

export default {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    const raw = new Uint8Array(await request.arrayBuffer());
    if (path === "/headers") {
      const parsed = await parseMailHeaders(raw);
      return Response.json({ sender: parsed.from?.address });
    }
    if (path === "/auth") {
      const valid = await authenticateDkim(raw, "missionary@example.com", {
        resolver: async () => [[request.headers.get("x-fixture-key")!]],
        now: new Date("2026-10-19T23:00:00Z"),
        destination: "update@in.example.com",
      });
      return Response.json({ valid }, { status: valid ? 200 : 422 });
    }
    if (path === "/parse") {
      const parsed = await parseMail(raw);
      return Response.json({
        length: parsed.text.length,
        fingerprint: parsed.fingerprint,
      });
    }
    return new Response("Unknown workload", { status: 404 });
  },
};
