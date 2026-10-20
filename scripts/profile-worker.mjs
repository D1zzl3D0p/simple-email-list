import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { builtinModules } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createPublicKey } from "node:crypto";
import { dkimSign } from "mailauth/lib/dkim/sign";
import path from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

const label = process.argv[2] ?? "capture";
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw Error("Use a simple capture label");
const output = path.resolve(".local/profiles", label);
await mkdir(output, { recursive: true });
const { outputFiles } = await build({
  entryPoints: ["scripts/profiling/worker.ts"],
  bundle: true,
  write: false,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire("/worker.js");',
  },
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: "inline",
  external: ["node:*", ...builtinModules],
  alias: Object.fromEntries(
    builtinModules
      .filter((n) => !n.startsWith("node:"))
      .map((n) => [n, `node:${n}`]),
  ),
});
const sourceMap = new TraceMap(
  JSON.parse(
    Buffer.from(
      outputFiles[0].text.match(
        /sourceMappingURL=data:application\/json;base64,([^\s]+)/,
      )[1],
      "base64",
    ).toString(),
  ),
);
await writeFile(path.join(output, "worker.mjs"), outputFiles[0].text);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "profile",
        modules: true,
        script: outputFiles[0].text,
        compatibilityDate: "2026-10-19",
        compatibilityFlags: ["nodejs_compat"],
      },
    ],
    inspectorPort: 9230,
  }),
);
let socket;
try {
  await mf.ready;
  const targets = await (await fetch("http://127.0.0.1:9230/json/list")).json();
  const target = targets.find(
    (t) => t.id?.includes("user:profile") || t.title?.includes("user:profile"),
  );
  if (!target) throw Error("Profile worker inspector not found");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      message.error
        ? entry.reject(Error(JSON.stringify(message.error)))
        : entry.resolve(message.result);
    }
  });
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, { resolve, reject });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  await cdp("Profiler.enable");
  await cdp("Profiler.setSamplingInterval", { interval: 100 });
  const privateKey = await readFile("tests/fixtures/sns-test-key.pem", "utf8");
  const rr =
    "v=DKIM1; k=rsa; p=" +
    createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .toString("base64");
  const summary = [];
  for (const size of [5000, 50000, 1040000]) {
    const body =
      process.env.PROFILE_SHAPE === "long-line"
        ? "x".repeat(size) + "\r\n"
        : "A weekly update with a link https://example.com and ordinary words.\r\n"
            .repeat(Math.ceil(size / 67))
            .slice(0, size) + "\r\n";
    const unsigned = [
      "From: missionary@example.com",
      "To: update@in.example.com",
      "Subject: Profile fixture",
      "Message-ID: <profile@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      body,
    ].join("\r\n");
    const signed = await dkimSign(unsigned, {
      signTime: new Date("2026-10-19T23:00:00Z"),
      signatureData: [
        { signingDomain: "example.com", selector: "fixture", privateKey },
      ],
    });
    if (signed.errors.length) throw Error("Fixture signing failed");
    const raw = new TextEncoder().encode(signed.signatures + unsigned);
    for (const workload of ["headers", "auth", "parse"]) {
      const run = async () => {
        const result = await mf.dispatchFetch(`http://fixture/${workload}`, {
          method: "POST",
          headers: { "x-fixture-key": rr },
          body: raw,
        });
        if (!result.ok)
          throw Error(`${workload}: ${result.status} ${await result.text()}`);
        await result.arrayBuffer();
      };
      for (let i = 0; i < 5; i++) await run();
      await cdp("Profiler.start");
      const count = 60;
      const start = performance.now();
      for (let i = 0; i < count; i++) await run();
      const wallMs = performance.now() - start;
      const { profile } = await cdp("Profiler.stop");
      await writeFile(
        path.join(output, `${workload}-${size}.cpuprofile`),
        JSON.stringify(profile),
      );
      if (!profile.samples || profile.samples.length < 2)
        throw Error("CPU profile is empty; check the target isolate");
      const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
      const self = new Map();
      let sampledUs = 0;
      for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
        const frame = nodes.get(profile.samples[i]).callFrame;
        if (["(idle)", "(program)", "(root)"].includes(frame.functionName))
          continue;
        const us = profile.timeDeltas[i];
        sampledUs += us;
        const original = frame.url.includes("script-0")
          ? originalPositionFor(sourceMap, {
              line: frame.lineNumber + 1,
              column: frame.columnNumber,
            })
          : null;
        const location = original?.source
          ? `${original.source}:${original.line}`
          : `${frame.url}:${frame.lineNumber + 1}`;
        const key = `${frame.functionName || "(anonymous)"} ${location}`;
        self.set(key, (self.get(key) ?? 0) + us);
      }
      const row = {
        workload,
        rawBytes: raw.length,
        iterations: count,
        sampledActiveMsPerIteration: sampledUs / 1000 / count,
        wallMsPerIteration: wallMs / count,
        hottestSelfFrames: [...self]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([frame, us]) => ({ frame, sampledMs: us / 1000 })),
      };
      summary.push(row);
      console.log(JSON.stringify(row));
    }
  }
  await writeFile(
    path.join(output, "summary.json"),
    JSON.stringify(
      {
        note: "Local workerd sampling estimates, warm isolated functions; not Cloudflare billed CPU or complete invocation cost.",
        summary,
      },
      null,
      2,
    ),
  );
} finally {
  socket?.close();
  await mf.dispose();
}
