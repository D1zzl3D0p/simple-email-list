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
