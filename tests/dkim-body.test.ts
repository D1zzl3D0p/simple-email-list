import { expect, test } from "vitest";
import { Buffer } from "node:buffer";
import { RelaxedHash } from "mailauth/lib/dkim/body/relaxed";
import { createHash } from "node:crypto";

function canonical(body: Buffer) {
  const lines = body
    .toString("latin1")
    .replace(/\r?\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/ +$/, ""));
  while (lines.at(-1) === "") lines.pop();
  return Buffer.from(lines.length ? lines.join("\r\n") + "\r\n" : "", "latin1");
}

test("relaxed body hashing preserves RFC whitespace and chunk boundary semantics", () => {
  const cases = [
    "",
    "\r\n\r\n",
    "one",
    "one ",
    "one  \t",
    " one  two\tthree \r\n\r\n",
    "\n\r\ncontent\n\n",
    "a\rb\r\nc\r",
    "\t\r\n\t\r\n",
    "a  b \n c\t d\n",
    "  abc\r\n  def\r\n",
    "\r\n\r\nend\t\r\n",
  ];
  let seed = 12345;
  for (let n = 0; n < 30; n++) {
    let value = "";
    for (let i = 0; i < 30; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      value += "abc \t\r\n\x00\x80\xff"[seed % 10];
    }
    cases.push(value);
  }
  for (const value of cases) {
    const input = Buffer.from(value, "latin1");
    const expected = canonical(input);
    for (const limit of [
      undefined,
      0,
      1,
      5,
      expected.length,
      expected.length + 1,
    ]) {
      const digest = createHash("sha256")
        .update(limit === undefined ? expected : expected.subarray(0, limit))
        .digest("base64");
      for (let split = 0; split <= input.length; split++) {
        const hash = new RelaxedHash("sha256", limit);
        hash.update(input.subarray(0, split));
        hash.update(input.subarray(split));
        expect(
          hash.digest("base64"),
          JSON.stringify({ value, limit, split }),
        ).toBe(digest);
        expect(hash.canonicalizedLength).toBe(expected.length);
      }
    }
  }
});
