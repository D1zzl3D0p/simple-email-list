export const escapeHtml = (s: string) =>
  // Literal replacements avoid a JS callback/allocation per special character.
  // Ampersand must be first so literal entities are escaped exactly once.
  s.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
export async function boundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  let native: ReadableStreamBYOBReader | undefined;
  try {
    native = stream.getReader({ mode: "byob" });
  } catch {
    /* JS streams may not support BYOB. */
  }
  if (native) {
    try {
      // readAtLeast returns fewer bytes only at EOF. Read one byte beyond the
      // cap so a truncated prefix can never be accepted as the complete body.
      const { value } = await native.readAtLeast(
        limit + 1,
        new Uint8Array(limit + 1),
      );
      if (value && value.byteLength > limit) {
        await native.cancel();
        throw Error("Input too large; maximum 1 MiB for email");
      }
      return value ?? new Uint8Array();
    } finally {
      native.releaseLock();
    }
  }
  const reader = stream.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw Error("Input too large; maximum 1 MiB for email");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export async function sha256(data: Uint8Array | string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    typeof data === "string" ? new TextEncoder().encode(data) : data,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function htmlResponse(
  body: string | ReadableStream<Uint8Array>,
  status = 200,
) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
