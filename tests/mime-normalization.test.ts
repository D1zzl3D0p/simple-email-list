import { expect, test } from "vitest";
import PostalMime from "postal-mime";
import { parseMail } from "../src/mail";
import { rawMail } from "./helpers";
const bytes = (value: string) => new TextEncoder().encode(value);

test.each([
  ["canonical 7bit", "Content-Transfer-Encoding: 7bit\r\n", "Plain\r\nbody"],
  ["canonical 8bit", "Content-Transfer-Encoding: 8bit\r\n", "José\r\nbody"],
  ["no encoding", "", "Plain\r\nbody\r\n"],
  ["flowed", "", "A flowed \r\nline"],
  [
    "attachment",
    'Content-Disposition: attachment; filename="a.txt"\r\n',
    "Letter",
  ],
  ["inline disposition", "Content-Disposition: inline\r\n", "Letter"],
  ["duplicate type", "Content-Type: text/html\r\n", "<p>Letter</p>"],
  [
    "duplicate encoding",
    "Content-Transfer-Encoding: 7bit\r\nContent-Transfer-Encoding: base64\r\n",
    "TGV0dGVy",
  ],
  ["folded subject", "X-Test: one\r\n two\r\n", "Letter"],
  ["blank fold", "X-Test: one\r\n \r\n", "Letter"],
  ["7bit high bit", "Content-Transfer-Encoding: 7bit\r\n", "José"],
  ["bare carriage return", "", "one\rtwo\r\r\nthree"],
  ["embedded controls", "", "one\0two\u000bthree"],
  ["empty body", "", ""],
])("normalization matches maintained parser: %s", async (name, extra, body) => {
  let raw = rawMail(body, extra);
  if (name === "flowed")
    raw = raw.replace("charset=utf-8", "charset=utf-8; format=flowed");
  const input = bytes(raw);
  expect((await parseMail(input)).parsed).toEqual({
    ...(await PostalMime.parse(input)),
    attachments: [],
  });
});

test.each(["\n", "\r\n"])(
  "noncanonical headers and charset keep parser semantics: %j",
  async (newline) => {
    for (const header of [
      "Subject: one\nInjected: two",
      "Subject: one\rInjected: two",
      "Subject: one\0two",
      "Content-Type: text/plain;\r\n charset=utf-8",
      "Content-Type: text/plain; charset=windows-1252",
      "Content-Type: text/plain; charset=utf-8\r\nContent-Type: multipart/mixed; boundary=b",
    ]) {
      const input = bytes(`${header}${newline}${newline}Letter`);
      expect((await parseMail(input)).parsed).toEqual({
        ...(await PostalMime.parse(input)),
        attachments: [],
      });
    }
  },
);

test("invalid UTF8 and sliced input preserve maintained parser semantics", async () => {
  const header = bytes(rawMail("", "Content-Transfer-Encoding: 8bit\r\n"));
  const input = new Uint8Array(header.length + 4);
  input.set(header);
  input.set([0xff, 0xc0, 0x80, 0x61], header.length);
  const backing = new Uint8Array(input.length + 20);
  backing.set(input, 7);
  const sliced = backing.subarray(7, 7 + input.length);
  expect((await parseMail(sliced)).parsed).toEqual(
    await PostalMime.parse(sliced),
  );
});

test("fingerprints hash full normalized text before canonical metadata encoding", async () => {
  const parsed = await parseMail(bytes(rawMail()));
  expect(parsed.fingerprint).toBe(
    "09e93725b13d3938f65f4ec30cc10c3bc51ae425596111fdf7c2692c2d702a6e",
  );
});

test("fingerprint ignores delivery headers but preserves every accepted body byte", async () => {
  const prefix = rawMail("");
  const body = "x".repeat(1048576 - bytes(prefix).length - 6) + "tail-A";
  const original = await parseMail(bytes(prefix + body));
  const transit = await parseMail(
    bytes("Received: by relay.example\r\n" + prefix + body),
  );
  const changed = await parseMail(bytes(prefix + body.slice(0, -1) + "B"));
  expect(original.text).toBe(body);
  expect(original.html.endsWith("tail-A</pre>")).toBe(true);
  expect(transit.fingerprint).toBe(original.fingerprint);
  expect(changed.fingerprint).not.toBe(original.fingerprint);
});

test("transfer encodings produce the same normalized logical identity", async () => {
  const original = await parseMail(bytes(rawMail()));
  const encoded = await parseMail(
    bytes(
      rawMail(
        "Hello Jos=C3=A9 https://example.com",
        "Content-Transfer-Encoding: quoted-printable\r\n",
      ),
    ),
  );
  expect(encoded.text).toBe("Hello José https://example.com");
  expect(encoded.fingerprint).toBe(original.fingerprint);
});

test("HTML fallback keeps quoted history, links and safe escaping", async () => {
  const parsed = await parseMail(
    bytes(
      rawMail(
        `<p>Today &amp; tomorrow</p><blockquote><p>Prior week</p><a href="https://example.com/old">Old link</a></blockquote><script>hidden()</script>`,
      ).replace("text/plain", "text/html"),
    ),
  );
  expect(parsed.text).toContain("Today & tomorrow");
  expect(parsed.text).toContain("Prior week");
  expect(parsed.text).toContain("https://example.com/old");
  expect(parsed.text).not.toContain("hidden()");
  expect(parsed.html).toContain("Today &amp; tomorrow");
  expect(parsed.html).not.toContain("<blockquote>");
});

test("binary attachments are discarded and do not affect text identity", async () => {
  const multipart = (content: string) =>
    rawMail(
      `--part\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nLetter\r\n--part\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="photo.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}\r\n--part--\r\n`,
    ).replace(
      "Content-Type: text/plain; charset=utf-8",
      `Content-Type: multipart/mixed; boundary="part"`,
    );
  const first = await parseMail(bytes(multipart("AAECAw==")));
  const second = await parseMail(bytes(multipart("AAECAA==")));
  expect(first.text).toBe("Letter");
  expect(first.parsed.attachments).toHaveLength(0);
  expect(second.fingerprint).toBe(first.fingerprint);
});
