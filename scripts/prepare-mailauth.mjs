import { readFileSync, writeFileSync } from "node:fs";

// mailauth supplies RFC parsing/canonicalization/key policy. Workers' Node crypto
// accepts the digest name (sha256), but rejects the OpenSSL alias rsa-sha256.
// Change only that API argument, after mailauth has validated the DKIM algorithm.
const base = new URL("../node_modules/mailauth/", import.meta.url);
if (
  JSON.parse(readFileSync(new URL("package.json", base), "utf8")).version !==
  "8.0.1"
)
  throw Error(
    "Review the mailauth Workers compatibility patch for this version",
  );
const original =
  "signatureHeader.signAlgo === 'rsa' ? signatureHeader.algorithm : null";
const patched =
  "signatureHeader.signAlgo === 'rsa' ? signatureHeader.hashAlgo : null";
for (const format of ["esm", "cjs"]) {
  const path = new URL(`dist/${format}/dkim/dkim-verifier.js`, base);
  const source = readFileSync(path, "utf8");
  if (source.split(original).length === 2 && !source.includes(patched))
    writeFileSync(path, source.replace(original, patched));
  else if (source.includes(original) || source.split(patched).length !== 2)
    throw Error("Unexpected mailauth verifier source; refusing to patch");
}

// RelaxedHash only reacts to LF, HTAB, and repeated SP. Search these events with
// the native regexp engine, preserving the maintained per-line repair/hash code.
// A repeated-SP match points at its second byte, as the original scan does.
const bodyScanOriginal =
  "            for (let pos = 0; pos < chunk.length; pos++) {";
const bodyScanPatched = `            for (const event of chunk.toString('latin1').matchAll(/\\n|\\t| {2}/g)) {
                const pos = event.index + (event[0] === '  ' ? 1 : 0);`;
for (const format of ["esm", "cjs"]) {
  const path = new URL(`dist/${format}/dkim/body/relaxed.js`, base);
  const source = readFileSync(path, "utf8");
  if (
    source.split(bodyScanOriginal).length === 2 &&
    !source.includes(bodyScanPatched)
  )
    writeFileSync(path, source.replace(bodyScanOriginal, bodyScanPatched));
  else if (
    source.includes(bodyScanOriginal) ||
    source.split(bodyScanPatched).length !== 2
  )
    throw Error("Unexpected mailauth body scanner; refusing to patch");
}

// CPU profiles show this per-byte JS scan dominates large canonical messages.
// Search for LF in a one-code-unit-per-byte string; retain bare-LF repair and
// previous-chunk CR handling. Canonicalization/signature policy stays in mailauth.
const scanOriginal = `        for (let i = 0; i < input.length; i++) {
            let c = input[i];
            if (c === 0x0a && this.lastByte !== 0x0d) {`;
const scanPrevious = `        for (let i = input.indexOf(0x0a); i !== -1; i = input.indexOf(0x0a, i + 1)) {
            if ((i === 0 ? this.lastByte : input[i - 1]) !== 0x0d) {`;
const scanIntermediate = `        for (let i = Uint8Array.prototype.indexOf.call(input, 0x0a); i !== -1; i = Uint8Array.prototype.indexOf.call(input, 0x0a, i + 1)) {
            if ((i === 0 ? this.lastByte : input[i - 1]) !== 0x0d) {`;
const scanPatched = `        const linebreaks = input.toString('latin1');
        for (let i = linebreaks.indexOf('\\n'); i !== -1; i = linebreaks.indexOf('\\n', i + 1)) {
            if ((i === 0 ? this.lastByte : input[i - 1]) !== 0x0d) {`;
const tailOriginal = `            this.lastByte = c;
        }
        if (pos === 0) {`;
const tailPatched = `        }
        if (input.length) this.lastByte = input[input.length - 1];
        if (pos === 0) {`;
for (const format of ["esm", "cjs"]) {
  const path = new URL(`dist/${format}/dkim/message-parser.js`, base);
  let source = readFileSync(path, "utf8");
  for (const previous of [scanPrevious, scanIntermediate]) {
    if (
      source.split(previous).length === 2 &&
      source.split(tailPatched).length === 2
    ) {
      source = source.replace(previous, scanPatched);
      writeFileSync(path, source);
    }
  }
  if (
    source.split(scanOriginal).length === 2 &&
    source.split(tailOriginal).length === 2 &&
    !source.includes(scanPatched)
  ) {
    writeFileSync(
      path,
      source
        .replace(scanOriginal, scanPatched)
        .replace(tailOriginal, tailPatched),
    );
  } else if (
    source.includes(scanOriginal) ||
    source.includes(tailOriginal) ||
    source.split(scanPatched).length !== 2 ||
    source.split(tailPatched).length !== 2
  )
    throw Error("Unexpected mailauth line-ending scanner; refusing to patch");
}
