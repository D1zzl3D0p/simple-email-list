import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import QRCode from "qrcode";

// Read the same source config used by this deployment, including JSONC comments.
const path = process.argv[2];
if (!path) throw Error("Pass the intended Wrangler configuration file");
const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
if (parsed.error) throw Error("Invalid Wrangler configuration");
const url = new URL(parsed.config.vars.PUBLIC_URL);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  url.pathname !== "/"
)
  throw Error("PUBLIC_URL must be an HTTPS origin");
writeFileSync(
  "public/qr.svg",
  await QRCode.toString(url.origin, { type: "svg", margin: 2 }),
);
console.log(`Built static QR for ${url.origin}`);
