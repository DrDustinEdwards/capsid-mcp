#!/usr/bin/env node
// Derive the per-namespace score-report key for one repo's IMPROVE_SCORE_KEY secret.
//
// WHY THIS EXISTS. The Worker holds ONE secret, IMPROVE_SCORE_SECRET, and derives a
// separate key per namespace from it. Each roster repo holds only its own derived
// key. So a key leaking out of one repo's Actions log authorises score reports for
// that namespace and no other, and rotating one namespace does not touch the rest.
// The alternative, one shared secret in five repos, makes the blast radius of any
// one repo the whole system.
//
// The derivation has to be reproducible outside the Worker to set those secrets up,
// and this is that. It is the same computation src/improve-scorer.ts performs:
// HMAC-SHA256(root, "capsid-improve-score:v1:<namespace>").
//
// USAGE. The root secret comes from the environment, never from an argument: an
// argument lands in the shell history and in the process list.
//
//   IMPROVE_SCORE_SECRET=... node scripts/improve-derive-key.mjs foxing
//
// Then set the printed value as the repo secret IMPROVE_SCORE_KEY on that repo, and
// set the repo VARIABLE IMPROVE_NAMESPACE to the namespace name. Both are read by
// .github/workflows/improve-score.yml.
//
// WHAT IT PRINTS. The derived key and nothing else, so it can be piped:
//
//   IMPROVE_SCORE_SECRET=... node scripts/improve-derive-key.mjs foxing \
//     | gh secret set IMPROVE_SCORE_KEY --repo DrDustinEdwards/foxing
//
// It never prints the root secret. Everything explanatory goes to stderr so stdout
// stays a single value.

import { createHmac } from "node:crypto";

// The roster, restated here rather than imported: this script is a plain .mjs with
// no build step and src/improve-schema.ts is TypeScript. The list is short and the
// check is a courtesy, so a typo in a namespace name is caught before a secret is
// set on the wrong repo rather than at 03:00 when a report fails to verify.
const ROSTER = ["capsid", "dustinedwards", "foxhound", "foxing", "germomics"];

const namespace = process.argv[2];
const root = process.env.IMPROVE_SCORE_SECRET;

function die(message) {
  console.error(`improve-derive-key: ${message}`);
  process.exit(1);
}

if (!namespace) {
  die(`no namespace given. Usage: IMPROVE_SCORE_SECRET=... node scripts/improve-derive-key.mjs <namespace>\n  namespaces: ${ROSTER.join(", ")}`);
}
if (!root) {
  die(
    "IMPROVE_SCORE_SECRET is not set in the environment.\n" +
      "  Read it from the Worker with: npx wrangler secret list   (which shows only that it exists)\n" +
      "  There is no way to read a Worker secret back. If you do not have the value, generate a new one,\n" +
      "  set it with `npx wrangler secret put IMPROVE_SCORE_SECRET`, and re-derive EVERY repo key from it."
  );
}
if (!ROSTER.includes(namespace)) {
  die(`'${namespace}' is not on the improve roster (${ROSTER.join(", ")}). Add it to ROSTER in src/improve-schema.ts first.`);
}

// Must match deriveScoreKey in src/improve-scorer.ts exactly, including the version
// segment. test/improve-derive-key.test.ts asserts the two agree.
const key = createHmac("sha256", root).update(`capsid-improve-score:v1:${namespace}`).digest("hex");

console.error(`improve-derive-key: derived the ${namespace} key. Set it as the repo secret IMPROVE_SCORE_KEY.`);
console.error(`improve-derive-key: also set the repo VARIABLE IMPROVE_NAMESPACE=${namespace}.`);
process.stdout.write(`${key}\n`);
