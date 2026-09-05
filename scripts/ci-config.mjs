#!/usr/bin/env node
// Reconstructs wrangler.jsonc on a CI runner. Never run locally: it writes the
// gitignored config file, and a developer machine already has the real one.
//
// WHY THIS EXISTS. wrangler.jsonc is gitignored under the public-repo hygiene
// rule, so a checkout carries only wrangler.jsonc.example with placeholder ids.
// Without this step CI cannot deploy at all. Committing the real config was
// considered and ruled against: the copies committed in foxhound, germomics,
// txasm and bsw are the deviation, not the norm, and capsid is a public repo.
//
// RESOLVE BY NAME, VERIFY BY ID, FAIL CLOSED ON DISAGREEMENT.
//
// Resolving purely by name is a documented trap in this portfolio, twice over:
// the database named "foxhound-staging" IS production, and a "foxhound-production"
// database exists and is EMPTY. A rename, a duplicate, or a second account
// would silently rebind this Worker to the wrong data and the deploy would look
// perfectly green. So every binding is resolved by name AND checked against the
// id pinned below. Disagreement is a hard failure, not a warning.
//
// The pinned ids are published in capsid/core.md and are inert without an API
// token, so committing them here leaks nothing that is not already public. They
// are an assertion, not a credential.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { APP_KV, D1, GITHUB_APP_CLIENT_ID, HOLDOUT_R2, OAUTH_KV, R2 } from "./bindings.mjs";

// Pinned in scripts/bindings.mjs, which is the ONE place a binding id is written
// (quality audit 5.1). It is imported rather than repeated here because
// scripts/reap-probe-clients.mjs needs the same OAuth KV id, and two copies meant
// a rotation could update the deploy assertion and leave the live job's cleanup
// deleting from the old keyspace.
const EXPECTED = {
  d1: D1,
  appKv: APP_KV,
  oauthKv: OAUTH_KV,
  r2: R2,
  holdoutR2: HOLDOUT_R2,
  githubAppClientId: GITHUB_APP_CLIENT_ID,
};

// Refuse to run outside CI. This script WRITES wrangler.jsonc, and on a
// developer machine that file is the real, gitignored config: running this by
// hand would overwrite it. GitHub Actions sets CI=true. The escape hatch is
// explicit and named so it cannot be triggered by accident.
if (process.env.CI !== "true" && process.env.CI_CONFIG_ALLOW_LOCAL !== "i-know-this-overwrites-wrangler-jsonc") {
  console.error(
    "ci-config: refusing to run outside CI. This overwrites wrangler.jsonc, which on this machine is your real config.\n" +
      "If you genuinely mean to, set CI_CONFIG_ALLOW_LOCAL=i-know-this-overwrites-wrangler-jsonc."
  );
  process.exit(1);
}

function wrangler(args) {
  try {
    return execFileSync("npx", ["--no-install", "wrangler", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
  } catch (err) {
    die(`wrangler ${args.join(" ")} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

function die(message) {
  console.error(`ci-config: ${message}`);
  process.exit(1);
}

// wrangler prints human preamble before JSON on some commands, so take the
// first well-formed JSON array in the output rather than trusting the whole
// stream to parse.
function parseJsonArray(text, label) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) die(`could not find a JSON array in the ${label} listing. Output was:\n${text}`);
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) die(`${label} listing did not parse to an array`);
    return parsed;
  } catch (err) {
    die(`could not parse the ${label} listing: ${err.message}`);
  }
}

function resolveUnique(list, label, matches) {
  const hits = list.filter(matches);
  if (hits.length === 0) die(`no ${label} matched. Nothing was deployed.`);
  if (hits.length > 1) {
    die(`${hits.length} ${label} entries matched, which is ambiguous. Nothing was deployed.`);
  }
  return hits[0];
}

function assertId(label, actual, expected) {
  if (actual !== expected) {
    die(
      `${label} RESOLVED TO THE WRONG ID.\n` +
        `  expected: ${expected}\n` +
        `  resolved: ${actual}\n` +
        `A name now points at a different resource. This is the failure mode the pin exists to catch: ` +
        `deploying would have bound this Worker to the wrong data. Nothing was deployed.`
    );
  }
  console.log(`ci-config: ${label} ok, name resolved to the pinned id ${expected}`);
}

// D1
const d1List = parseJsonArray(wrangler(["d1", "list", "--json"]), "D1");
const d1 = resolveUnique(d1List, `D1 database named "${EXPECTED.d1.name}"`, (d) => d.name === EXPECTED.d1.name);
assertId("D1 capsid", d1.uuid ?? d1.id, EXPECTED.d1.id);

// KV
const kvList = parseJsonArray(wrangler(["kv", "namespace", "list"]), "KV");
const appKv = resolveUnique(kvList, `KV namespace titled "${EXPECTED.appKv.name}"`, (n) => n.title === EXPECTED.appKv.name);
assertId(`KV ${EXPECTED.appKv.name} (APP_KV)`, appKv.id, EXPECTED.appKv.id);
const oauthKv = resolveUnique(kvList, `KV namespace titled "${EXPECTED.oauthKv.name}"`, (n) => n.title === EXPECTED.oauthKv.name);
assertId(`KV ${EXPECTED.oauthKv.name} (OAUTH_KV)`, oauthKv.id, EXPECTED.oauthKv.id);
// The split is the point: if these two ever resolve to the same id again, the
// Worker's caches are back in the provider's keyspace and nothing else would say so.
if (appKv.id === oauthKv.id) {
  die(`APP_KV and OAUTH_KV resolved to the SAME namespace id (${appKv.id}). The 2026-08-15 split has been undone. Nothing was deployed.`);
}

// R2 is asserted against the COMMITTED CONFIG, not against the account, and the
// reason is worth stating rather than leaving as an apparent gap.
//
// Unlike D1 and KV, an R2 binding carries no id: it names a bucket and that name
// is a literal in wrangler.jsonc.example. So there is nothing to resolve and
// nothing to pin an id against, and "resolve by name, verify by id" has no R2
// form. The account-side existence check that used to sit here needed R2 read on
// the API token, which the deploy token does not carry: it failed in CI on
// 2026-08-13 with Authentication error 10000 AFTER D1 and KV had both resolved
// and matched their pins.
//
// What remains is a real assertion, just a config-side one: the example must
// still name the bucket this script expects. That catches the example being
// edited to point somewhere else, which is the drift that would actually hurt.
// A bucket that is missing from the account is caught by `wrangler deploy`
// itself, loudly, in the very next step.
//
// MEASURED 2026-09-05, and it corrects the sentence above. The token now carries
// Workers R2 Storage **EDIT**, added that day because `wrangler deploy` FAILED
// three times with this same Authentication error 10000 the moment a SECOND R2
// binding (HOLDOUT) was declared. Two findings worth keeping:
//
//   1. READ IS NOT ENOUGH. R2 Read was added first, on the reasoning that the
//      failing call (`GET /accounts/<id>/r2/buckets/<name>`) is a lookup. The
//      deploy failed again, byte-identical. Cloudflare's own Workers-builds token
//      spec lists `Workers R2 Storage (edit)`, and the "Edit Cloudflare Workers"
//      template ships Edit for exactly this reason. Inferring the verb from the
//      URL path was diagnosing from first principles, which capsid/conventions.md
//      warns produces confident wrong instructions for the owner to follow.
//   2. WRANGLER ONLY CHECKS BINDINGS THAT ARE NEW relative to the deployed
//      version. MEDIA had been bound for months and no deploy had ever needed R2
//      permission; adding HOLDOUT is what surfaced the gap. So this failure mode
//      waits for the next new R2 binding rather than for the next deploy.
//
// HOLDOUT READ ACCESS IS BY ONE SHARED TOKEN, ruled 2026-09-05. `capsid-holdout-read`
// is read-only and set in all five roster repos as IMPROVE_HOLDOUT_R2_ACCESS_KEY_ID
// and IMPROVE_HOLDOUT_R2_SECRET_ACCESS_KEY. It is NOT scoped per namespace prefix, so
// the credential does not decide which suite a job can read. What does:
//
//   - the manifest total, checked by src/improve-scorer.ts against the namespace the
//     report is SIGNED as, so a mistyped IMPROVE_NAMESPACE fails closed at the Worker
//     instead of scoring against another namespace's tests;
//   - step scoping in improve-score.yml, where the three R2 secrets are `env:` on the
//     pull step alone and no attempt code runs in that step.
//
// State it precisely: these guard different things and the manifest never provided
// what prefix scoping did. The accepted risk is BLAST RADIUS. One leaked token exposes
// all five suites where a scoped one exposed one. Unchanged, and load-bearing: the
// separate bucket, AttemptEnv = Omit<Env, "HOLDOUT">, and the source scan in
// test/improve-holdout.test.ts that lets only src/improve-scorer.ts name the binding.
// This token is a REPO secret and must never become a Worker binding or a var here.
//
// The bucket must also EXIST first: creating it was necessary and not sufficient.
// With Edit in place the account-side `wrangler r2 bucket list` probe could now be
// restored here, which would have caught this at the config step with a named
// reason instead of inside wrangler. Not done: it is a separate change and this
// script's job is to fail closed on a binding pin, which it did.
for (const [label, pin] of [
  ["MEDIA", EXPECTED.r2],
  ["HOLDOUT", EXPECTED.holdoutR2],
]) {
  if (!pin.name || pin.name.startsWith("YOUR_")) {
    die(`the R2 ${label} bucket pin is unset or still a placeholder. Nothing was deployed.`);
  }
  console.log(`ci-config: R2 ${label} ${pin.name} pinned by name, existence is enforced by the deploy step`);
}

// THE TWO BUCKETS MUST BE DIFFERENT BUCKETS. Pointing HOLDOUT at capsid-media
// would satisfy every other check here and silently undo the isolation: attempt
// code holds MEDIA, so a shared bucket means attempt code can reach the hidden
// suite. Same shape as the APP_KV/OAUTH_KV assertion above, and there for the same
// reason: the split is the property, so the split is what gets asserted.
if (EXPECTED.r2.name === EXPECTED.holdoutR2.name) {
  die(
    `MEDIA and HOLDOUT are pinned to the SAME bucket (${EXPECTED.r2.name}). ` +
      `Attempt code holds MEDIA, so this would give it read access to the hidden holdout suite. Nothing was deployed.`
  );
}

// Render the example into a real config.
let config = readFileSync("wrangler.jsonc.example", "utf8");
const substitutions = [
  ["YOUR_D1_ID", EXPECTED.d1.id],
  ["YOUR_APP_KV_ID", EXPECTED.appKv.id],
  ["YOUR_OAUTH_KV_ID", EXPECTED.oauthKv.id],
  ["YOUR_HOLDOUT_R2_BUCKET", EXPECTED.holdoutR2.name],
  ["YOUR_R2_BUCKET", EXPECTED.r2.name],
  ["YOUR_GITHUB_APP_CLIENT_ID", EXPECTED.githubAppClientId],
];
for (const [placeholder, value] of substitutions) {
  if (!config.includes(placeholder)) {
    die(`wrangler.jsonc.example no longer contains the placeholder ${placeholder}. The example and this script have drifted; fix both together.`);
  }
  config = config.split(placeholder).join(value);
}

// The catch-all. Any placeholder that survives means a binding this script does
// not know about was added to the example, and deploying would send a literal
// "YOUR_..." string to Cloudflare. Refuse instead.
const leftover = config.match(/YOUR_[A-Z0-9_]+/g);
if (leftover) {
  die(`unsubstituted placeholders remain: ${[...new Set(leftover)].join(", ")}. The example gained a binding this script does not handle. Nothing was deployed.`);
}

writeFileSync("wrangler.jsonc", config, "utf8");
console.log("ci-config: wrote wrangler.jsonc with every binding resolved by name and verified by id");
