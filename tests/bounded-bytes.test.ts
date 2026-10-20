import { expect, test } from "vitest";
import { boundedBytes } from "../src/util";

test("bounded input preserves exact bytes across empty and split UTF-8 chunks", async () => {
  expect(await boundedBytes(null, 10)).toEqual(new Uint8Array());
  const bytes = new TextEncoder().encode("José 🏔️\n\0&<>");
  for (const size of [1, 2, 7, bytes.length]) {
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else {
          const end = Math.min(bytes.length, offset + size);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        }
      },
    });
    expect(await boundedBytes(stream, bytes.length)).toEqual(bytes);
  }
});

test("bounded input cancels oversized streams without returning a truncated body", async () => {
  for (const chunks of [
    [new Uint8Array(9)],
    [new Uint8Array(8), new Uint8Array(1)],
  ]) {
    let cancelled = false;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < chunks.length) controller.enqueue(chunks[offset++]);
        // Deliberately keep the stream open until the size guard cancels it.
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(boundedBytes(stream, 8)).rejects.toThrow("Input too large");
    await Promise.resolve();
    expect(cancelled).toBe(true);
  }
});

test("bounded input propagates upstream failure instead of accepting a partial body", async () => {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        sent = true;
      } else controller.error(Error("input interrupted"));
    },
  });
  await expect(boundedBytes(stream, 8)).rejects.toThrow("input interrupted");
});

test("native byte streams enforce the actual cap without depending on Content-Length", async () => {
  for (const length of [0, 7, 8])
    expect(
      await boundedBytes(new Response(new Uint8Array(length)).body, 8),
    ).toEqual(new Uint8Array(length));
  await expect(
    boundedBytes(new Response(new Uint8Array(9)).body, 8),
  ).rejects.toThrow("Input too large");
  const bytes = new TextEncoder().encode("José 🏔️ &<>");
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
  });
  expect(await boundedBytes(stream, bytes.length)).toEqual(bytes);
});

test("native BYOB buffering preserves split UTF-8 and rejects a partial native stream failure", async () => {
  const bytes = new TextEncoder().encode("José 🏔️ &<>");
  const native = new IdentityTransformStream();
  const writer = native.writable.getWriter();
  const pending = boundedBytes(native.readable, bytes.length);
  for (const byte of bytes) await writer.write(new Uint8Array([byte]));
  await writer.close();
  expect(await pending).toEqual(bytes);

  const interrupted = new IdentityTransformStream();
  const failingWriter = interrupted.writable.getWriter();
  const rejected = expect(
    boundedBytes(interrupted.readable, 8),
  ).rejects.toThrow("native input interrupted");
  await failingWriter.write(new Uint8Array([1, 2, 3]));
  await failingWriter.abort(Error("native input interrupted"));
  await rejected;
});

test("native BYOB overflow cancels its writer instead of accepting a prefix", async () => {
  const native = new IdentityTransformStream();
  const writer = native.writable.getWriter();
  void writer.closed.catch(() => {});
  const rejected = expect(boundedBytes(native.readable, 8)).rejects.toThrow(
    "Input too large",
  );
  await Promise.allSettled([writer.write(new Uint8Array(9)), rejected]);
  await rejected;
  // Native IdentityTransformStream reports cancellation on the next write;
  // writer.closed alone does not settle until the producer acts again.
  await expect(writer.write(new Uint8Array([1]))).rejects.toThrow();
  await writer.abort().catch(() => {});
});
