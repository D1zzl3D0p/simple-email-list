// SES tag values allow only ASCII letters, digits, underscores and hyphens.
export function deliveryTag(id: string): string {
  const tag =
    "d_" +
    btoa(String.fromCharCode(...new TextEncoder().encode(id)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  if (tag.length > 256)
    throw Error("Delivery correlation exceeds SES tag limit");
  return tag;
}
export function decodeDeliveryTag(tag: string): string | null {
  try {
    if (!/^d_[A-Za-z0-9_-]{1,254}$/.test(tag)) return null;
    const bytes = Uint8Array.from(
      atob(tag.slice(2).replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
    const id = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    return deliveryTag(id) === tag ? id : null;
  } catch {
    return null;
  }
}
