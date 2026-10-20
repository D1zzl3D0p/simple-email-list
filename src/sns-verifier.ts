import { importX509 } from "jose";
import { boundedBytes } from "./util";

// Only immutable key material survives requests: no response streams or pending I/O.
// Bound both cache lifetime and cardinality even when trusted SNS rotates certificates.
const certificates = new Map<
  string,
  {
    expires: number;
    sha256: CryptoKey;
    sha1?: CryptoKey;
  }
>();
const MAX_CERTIFICATES = 16;
const CACHE_MS = 3600000;

export async function verifySnsSignature(
  envelope: Record<string, string>,
  certificateUrl: URL,
): Promise<void> {
  const fields =
    envelope.Type === "Notification"
      ? [
          "Message",
          "MessageId",
          ...("Subject" in envelope ? ["Subject"] : []),
          "Timestamp",
          "TopicArn",
          "Type",
        ]
      : [
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ];
  if (fields.some((field) => typeof envelope[field] !== "string"))
    throw Error("Invalid signed fields");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      envelope.Signature,
    ) ||
    !envelope.Signature ||
    envelope.Signature.length > 2048
  )
    throw Error("Invalid signature encoding");
  const now = Date.now();
  for (const [url, cached] of certificates)
    if (cached.expires <= now) certificates.delete(url);
  const url = certificateUrl.href;
  let entry = certificates.get(url);
  if (!entry) {
    // Caller pins the exact regional SNS HTTPS origin and certificate path before
    // entering here. HTTPS authenticates that origin; redirects must never run.
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw Error("Certificate could not be retrieved");
    }
    const pem = new TextDecoder().decode(
      await boundedBytes(response.body, 32768),
    );
    // Maintained JOSE X.509 parser extracts SPKI; WebCrypto performs RSA imports
    // and verification natively, avoiding Node HTTP/stream/crypto adapters.
    const sha256 = await importX509(pem, "RS256", { extractable: true });
    entry = { expires: now + CACHE_MS, sha256 };
    if (certificates.size >= MAX_CERTIFICATES)
      certificates.delete(certificates.keys().next().value!);
    certificates.set(url, entry);
  }
  let key = entry.sha256;
  if (envelope.SignatureVersion === "1") {
    // SNS still signs legacy version 1 with SHA-1. Keep its CryptoKey distinct
    // because a WebCrypto RSA key is bound to its hash at import time.
    entry.sha1 ??= await crypto.subtle.importKey(
      "spki",
      await crypto.subtle.exportKey("spki", entry.sha256),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" },
      false,
      ["verify"],
    );
    key = entry.sha1;
  }
  const signature = Uint8Array.from(atob(envelope.Signature), (c) =>
    c.charCodeAt(0),
  );
  const signed = new TextEncoder().encode(
    fields.map((field) => `${field}\n${envelope[field]}\n`).join(""),
  );
  if (
    !(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed))
  )
    throw Error("The message signature is invalid");
}
