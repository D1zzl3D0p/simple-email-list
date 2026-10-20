import type { Env } from "./types";

export interface StoredBody {
  text: string;
  text_key?: string | null;
}

// Historic and small messages remain inline. Large normalized bodies are private,
// immutable objects written before their database reference is committed.
export async function readBodyContent(
  env: Env,
  body: StoredBody,
): Promise<string | ReadableStream<Uint8Array>> {
  if (!body.text_key) return body.text;
  if (!/^text\/[a-f0-9]{64}\.txt$/.test(body.text_key))
    throw Error("Invalid private message body reference");
  const object = await env.ARCHIVE.get(body.text_key);
  if (!object) throw Error("Private message body unavailable; retry later");
  return object.body;
}

export async function readBody(env: Env, body: StoredBody): Promise<string> {
  const content = await readBodyContent(env, body);
  return typeof content === "string" ? content : new Response(content).text();
}
