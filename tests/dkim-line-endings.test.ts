import { expect, test } from "vitest";
import { Buffer } from "node:buffer";
import { MessageParser } from "mailauth/lib/dkim/message-parser";

function reference(chunks: Buffer[]) {
  let previous: number | undefined;
  return Buffer.concat(
    chunks.map((chunk) => {
      const bytes: number[] = [];
      for (const byte of chunk) {
        if (byte === 10 && previous !== 13) bytes.push(13);
        bytes.push(byte);
        previous = byte;
      }
      return Buffer.from(bytes);
    }),
  );
}

test("DKIM line ending normalization preserves binary bytes and chunk boundaries", () => {
  const inputs = [
    Buffer.from("\r\n\n\r\n\nend\r"),
    Buffer.from("one\r\ntwo\r\n"),
    Buffer.from("one\ntwo\n"),
    Buffer.from("no newline"),
    Buffer.alloc(0),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  ];
  for (const input of inputs) {
    for (let cut = 0; cut <= input.length; cut++) {
      const parser = new MessageParser();
      const chunks = [
        input.subarray(0, cut),
        Buffer.alloc(0),
        input.subarray(cut),
      ];
      const actual = Buffer.concat(
        chunks.flatMap((chunk) => [...parser.ensureLinebreaks(chunk)]),
      );
      expect(actual).toEqual(reference(chunks));
    }
  }
});
