import { env } from "cloudflare:test";
import type { Env } from "../src/types";
export const now = new Date("2026-10-19T16:00:00Z");
export function testEnv(extra: Partial<Env> = {}): Env {
  return {
    ...env,
    CAPABILITY_SECRET: "fixture-secret-with-at-least-32-bytes",
    TURNSTILE_SECRET: "test",
    AWS_ACCESS_KEY_ID: "fixture",
    AWS_SECRET_ACCESS_KEY: "fixture",
    ...extra,
  };
}
export async function configure() {
  await env.DB.prepare(
    "UPDATE settings SET missionary='missionary@example.com',owner='owner@example.com',approved_senders='[\"missionary@example.com\"]',album_url='https://photos.google.com/fixture' WHERE id=1",
  ).run();
}
export function mail(
  raw = "",
  to: string = env.UPDATE_ADDRESS,
): ForwardableEmailMessage {
  const bytes = new TextEncoder().encode(raw);
  return {
    from: "missionary@example.com",
    to,
    headers: new Headers(),
    raw: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    rawSize: bytes.length,
    setReject(reason: string) {
      throw new Error(reason);
    },
    forward: async () => ({ messageId: "fixture" }),
    reply: async () => ({ messageId: "fixture" }),
  };
}
export function rawMail(
  body = "Hello José https://example.com",
  headers = "",
  subject = "Week one",
) {
  return `From: Missionary <missionary@example.com>\r\nTo: update@in.mission.example.com\r\nMessage-ID: <one@example.com>\r\nSubject: ${subject}\r\n${headers}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
}
