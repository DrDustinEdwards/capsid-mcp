// A wrangler.jsonc good enough for `wrangler deploy --dry-run`, built OFFLINE.
//
// bundle_size_bytes came back null on every capsid score, because the scorer's build job
// runs `wrangler deploy --dry-run --outdir` and this repo gitignores the real
// wrangler.jsonc under the public-repo hygiene rule. The job holds no credential and
// cannot run scripts/ci-config.mjs, which resolves every binding by name against the
// account API, so the metric was structurally unmeasurable. Ruled 2026-09-08.
//
// THIS IS NOT ci-config.mjs. That script makes a DEPLOY safe: it resolves each binding
// by name and refuses if the resolved id disagrees with the pinned one. This one is for
// a DRY RUN, which bundles and exits without talking to the account. Nothing is
// resolved, nothing is verified, and the pinned ids are substituted for the example's
// placeholders.
//
// IT MUST NEVER BE USED TO DEPLOY. It writes to its own filename and the deploy path
// does not read it.

import { readFileSync, writeFileSync } from "node:fs";
import { APP_KV, D1, GITHUB_APP_CLIENT_ID, HOLDOUT_R2, OAUTH_KV, R2 } from "./bindings.mjs";

const OUT = "wrangler.jsonc";

const example = readFileSync("wrangler.jsonc.example", "utf8");

// The placeholders wrangler.jsonc.example carries, and the pinned value each stands for.
// Every substitution is asserted below, so a renamed placeholder is a loud failure
// rather than a config that still says YOUR_D1_ID.
const SUBSTITUTIONS = [
  ["YOUR_D1_ID", D1.id],
  ["YOUR_APP_KV_ID", APP_KV.id],
  ["YOUR_OAUTH_KV_ID", OAUTH_KV.id],
  ["YOUR_R2_BUCKET", R2.name],
  ["YOUR_HOLDOUT_R2_BUCKET", HOLDOUT_R2.name],
  ["YOUR_GITHUB_APP_CLIENT_ID", GITHUB_APP_CLIENT_ID],
];

let config = example;
for (const [placeholder, value] of SUBSTITUTIONS) {
  if (!config.includes(placeholder)) {
    console.error(
      `dry-run-config: wrangler.jsonc.example no longer contains the placeholder ${placeholder}. ` +
        `Either it was renamed or the binding was removed; fix this script rather than shipping a config with a hole in it.`
    );
    process.exit(1);
  }
  config = config.split(placeholder).join(value);
}

// Nothing that still looks like a placeholder may survive. A dry run tolerates a wrong
// id, so an unnoticed leftover would be invisible here and visible only as a bundle that
// never got measured.
const leftover = config.match(/YOUR_[A-Z0-9_]+/g);
if (leftover) {
  console.error(`dry-run-config: unsubstituted placeholders remain: ${[...new Set(leftover)].join(", ")}`);
  process.exit(1);
}

writeFileSync(OUT, config);
console.log(`dry-run-config: wrote ${OUT} from wrangler.jsonc.example with ${SUBSTITUTIONS.length} pinned values, no network, no secrets`);
