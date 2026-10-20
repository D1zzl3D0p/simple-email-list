import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { dkimVerify } from "mailauth/lib/dkim/verify";
import { addressParser } from "postal-mime";
import { boundedBytes } from "./util";

export type TxtResolver = (
  name: string,
  type: string,
) => Promise<string[][] | string[]>;

type DnsAnswer = { name: string; type: number; TTL: number; data: string };
const dnsCache = new Map<string, { until: number; records: string[] }>();
const dnsName = (name: string) => name.toLowerCase().replace(/\.$/, "");
function validName(name: string) {
  return (
    name.length <= 253 &&
    name.split(".").every((label) => /^[a-z0-9_-]{1,63}$/i.test(label))
  );
}

// Decode DNS presentation-format character strings, including split TXT records.
// This is transport decoding; the maintained DKIM verifier parses the key record.
export function decodeTxt(value: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (/\s/.test(value[i] ?? "") && i < value.length) i++;
    if (i === value.length) break;
    if (value[i++] !== '"') throw Error("Invalid DNS TXT string");
    let chunk = "",
      closed = false;
    while (i < value.length) {
      let c = value[i++];
      if (c === '"') {
        closed = true;
        break;
      }
      if (c === "\\") {
        if (i >= value.length) throw Error("Truncated DNS escape");
        if (/^\d{3}/.test(value.slice(i, i + 3))) {
          const n = Number(value.slice(i, i + 3));
          if (n > 255) throw Error("Invalid DNS octet");
          c = String.fromCharCode(n);
          i += 3;
        } else c = value[i++];
      }
      chunk += c;
    }
    if (!closed) throw Error("Unclosed DNS TXT string");
    chunks.push(chunk);
    if (chunks.length > 16) throw Error("Too many DNS TXT fragments");
  }
  if (!chunks.length) throw Error("Empty DNS TXT response");
  return chunks;
}

export const resolveDkimTxt: TxtResolver = async (query, type) => {
  const name = dnsName(query);
  if (type !== "TXT" || !validName(name)) throw Error("Invalid DKIM DNS query");
  const now = Date.now(),
    cached = dnsCache.get(name);
  if (cached && cached.until > now)
    return cached.records.map((record) => [record]);
  dnsCache.delete(name);
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", name);
  url.searchParams.set("type", "TXT");
  const response = await fetch(url, {
    headers: { accept: "application/dns-json" },
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw Error("DKIM DNS unavailable");
  }
  const data = JSON.parse(
    new TextDecoder().decode(await boundedBytes(response.body, 16384)),
  ) as {
    Status: number;
    TC?: boolean;
    Question: { name: string; type: number }[];
    Answer?: DnsAnswer[];
  };
  if (
    data.Status !== 0 ||
    data.TC ||
    data.Question?.length !== 1 ||
    dnsName(data.Question[0].name) !== name ||
    data.Question[0].type !== 16 ||
    !Array.isArray(data.Answer) ||
    data.Answer.length > 32
  )
    throw Error("Invalid DKIM DNS response");
  const aliases = new Set([name]);
  let current = name;
  for (let depth = 0; depth < 8; depth++) {
    const alias = data.Answer.filter(
      (a) => a.type === 5 && dnsName(a.name) === current,
    );
    if (!alias.length) break;
    if (
      alias.length !== 1 ||
      !validName(dnsName(alias[0].data)) ||
      aliases.has(dnsName(alias[0].data))
    )
      throw Error("Invalid DNS alias chain");
    current = dnsName(alias[0].data);
    aliases.add(current);
    if (depth === 7) throw Error("DNS alias chain too long");
  }
  const answers = data.Answer.filter(
    (a) => a.type === 16 && dnsName(a.name) === current,
  );
  if (!answers.length || answers.length > 8) throw Error("DKIM key missing");
  const records = answers.map((answer) => decodeTxt(answer.data).join(""));
  // Honor short TTLs and revocation; never retain failed lookups or in-flight I/O.
  const ttl = Math.min(
    300,
    ...data.Answer.filter((a) => aliases.has(dnsName(a.name))).map(
      (a) => a.TTL,
    ),
  );
  if (Number.isFinite(ttl) && ttl > 0) {
    for (const [key, entry] of dnsCache)
      if (entry.until <= now) dnsCache.delete(key);
    if (dnsCache.size >= 64) dnsCache.delete(dnsCache.keys().next().value!);
    dnsCache.set(name, { until: now + ttl * 1000, records });
  }
  return records.map((record) => [record]);
};

export async function authenticateDkim(
  raw: Uint8Array,
  sender: string,
  options: { resolver?: TxtResolver; now?: Date; destination?: string } = {},
): Promise<boolean> {
  try {
    if (raw.length > 1048576) return false;
    let end = -1;
    for (let i = 0; i + 3 < Math.min(raw.length, 32768); i++) {
      if (
        raw[i] === 13 &&
        raw[i + 1] === 10 &&
        raw[i + 2] === 13 &&
        raw[i + 3] === 10
      ) {
        end = i;
        break;
      }
    }
    if (end < 0) return false;
    const block = new TextDecoder().decode(raw.subarray(0, end));
    const headerNames: string[] = [];
    for (const line of block.split("\r\n")) {
      if (/^[ \t]/.test(line)) {
        if (!headerNames.length || /[\r\n\x00]/.test(line)) return false;
        continue;
      }
      const match = /^([a-z0-9-]+):[^\r\n\x00]*$/i.exec(line);
      if (!match) return false;
      headerNames.push(match[1].toLowerCase());
    }
    const count = (key: string) =>
      headerNames.filter((name) => name === key).length;
    const protectedHeaders = [
      "from",
      "to",
      "cc",
      "subject",
      "message-id",
      "mime-version",
      "content-type",
      "content-transfer-encoding",
    ];
    if (
      count("from") !== 1 ||
      count("message-id") !== 1 ||
      !/^message-id:[ \t]*<[^<>\s@]+@[^<>\s@]+>[ \t]*$/im.test(
        block.replace(/\r\n[ \t]+/g, " "),
      ) ||
      count("dkim-signature") < 1 ||
      count("dkim-signature") > 8 ||
      protectedHeaders.some((key) => count(key) > 1)
    )
      return false;
    let lookups = 0;
    const result = await dkimVerify(
      // The input is already bounded and fully buffered. The verifier's Buffer
      // adapter slices it into 64 KiB chunks, repeatedly joining/scanning a long
      // unfinished line. Its stream adapter preserves this single bounded chunk.
      Readable.from([Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)]),
      {
        strict: true,
        minBitLength: 1024,
        curTime: options.now ?? new Date(),
        resolver: async (name, type) => {
          if (++lookups > 10) throw Error("DKIM DNS query limit exceeded");
          return (options.resolver ?? resolveDkimTxt)(name, type);
        },
      },
    );
    if (
      result.fromFields !== 1 ||
      result.fromSyntax !== "valid" ||
      result.headerFrom.length !== 1 ||
      result.headerFrom[0].toLowerCase() !== sender.toLowerCase()
    )
      return false;
    const domain = sender.slice(sender.lastIndexOf("@") + 1).toLowerCase();
    return result.results.some((signature) => {
      if (
        signature.status.result !== "pass" ||
        !signature.signatureTimeValid ||
        signature.canonBodyLengthLimited ||
        signature.signingDomain?.toLowerCase() !== domain ||
        !["rsa-sha256", "ed25519-sha256"].includes(signature.algo ?? "")
      )
        return false;
      const signed = new Set(
        signature.signingHeaders?.keys
          .split(":")
          .map((key) => key.trim().toLowerCase()),
      );
      if (protectedHeaders.some((key) => count(key) && !signed.has(key)))
        return false;
      if (options.destination) {
        // Bind the deliberate destination to a signed recipient field, preventing
        // replay of a signed update into the management address. Bcc-only input
        // cannot establish that intent and is rejected.
        const matched = result.headers?.parsed
          .filter(
            (header) =>
              ["to", "cc"].includes(header.key) && signed.has(header.key),
          )
          .some((header) => {
            const value = header.line
              .toString()
              .replace(/^[^:]+:/, "")
              .replace(/\r\n[ \t]+/g, " ");
            return addressParser(value, { flatten: true }).some(
              (address) =>
                "address" in address &&
                address.address?.toLowerCase() ===
                  options.destination?.toLowerCase(),
            );
          });
        if (!matched) return false;
      }
      return true;
    });
  } catch {
    // Header assertions, DNS failures and cryptographic errors all fail closed.
    return false;
  }
}
