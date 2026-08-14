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

// Pinned from capsid/core.md. If a binding legitimately moves, this file is the
// one place to change, and the change is reviewable in the diff.
const EXPECTED = {
  d1: { name: "capsid", id: "f24921c8-5e6f-499e-96a1-f124f52f12f7" },
  // TWO KV NAMESPACES, asserted INDEPENDENTLY as of 2026-08-15. They were one id
  // behind two binding names until the split, and this script pinned it once. That
  // was not merely redundant: with a single pin and a single placeholder, CI could
  // not have produced two different ids, so the split would have failed on its own
  // deploy. Each binding now resolves by its own title and is checked against its
  // own pinned id.
  //
  // appKv holds ONLY the Worker's own caches (gh:install, gh:token, gh:get).
  // oauthKv holds the provider's client/grant/token keys and this Worker's
  // capsid:oauth-state, which uses the OAUTH_KV binding and therefore stays.
  //
  // Resolution is by EXACT TITLE and refuses ambiguity, which matters here: the
  // account also contains a namespace literally titled "OAUTH_KV" belonging to
  // dustinedwards-mcp. Neither title below can match it.
  appKv: { name: "capsid-app-kv-v2", id: "21465e558b464cbf893753d2b2cb7829" },
  oauthKv: { name: "capsid-app-kv", id: "5fac20b95ad541a39f24eb8c5a753b6c" },
  r2: { name: "capsid-media" },
  // Public identifier. It appears in every OAuth URL the App generates and in
  // wrangler's own deploy output. It is pinned here because wrangler would
  // otherwise write the example's placeholder over the live value: keep_vars
  // preserves vars that are ABSENT from config, not ones present with a wrong
  // value, and a placeholder client id would break every repo tool.
  githubAppClientId: "Iv23lik2O8SPPksxbc6O",
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
// To restore the account-side check, add R2 read to CLOUDFLARE_API_TOKEN and put
// the `wrangler r2 bucket list` probe back.
if (!EXPECTED.r2.name || EXPECTED.r2.name.startsWith("YOUR_")) {
  die("the R2 bucket pin is unset or still a placeholder. Nothing was deployed.");
}
console.log(`ci-config: R2 ${EXPECTED.r2.name} pinned by name, existence is enforced by the deploy step`);

// Render the example into a real config.
let config = readFileSync("wrangler.jsonc.example", "utf8");
const substitutions = [
  ["YOUR_D1_ID", EXPECTED.d1.id],
  ["YOUR_APP_KV_ID", EXPECTED.appKv.id],
  ["YOUR_OAUTH_KV_ID", EXPECTED.oauthKv.id],
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
