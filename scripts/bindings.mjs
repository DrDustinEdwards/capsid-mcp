// The pinned Cloudflare binding identities, in ONE place (quality audit 5.1).
//
// The OAuth KV namespace id was written out twice: in scripts/ci-config.mjs, which
// asserts the deploy is bound to the right keyspace, and in
// scripts/reap-probe-clients.mjs, which deletes from that keyspace after every live
// gate run. Updating only the first would leave CI deploying against the new namespace
// while the reaper issued DELETEs against the old one, reporting success forever (KV
// DELETE is idempotent) while probe registrations piled up in the live namespace.
//
// SIDE-EFFECT FREE. ci-config.mjs cannot be the home for these: it refuses to run
// outside CI with process.exit and writes wrangler.jsonc at module scope, so importing
// it would run it. This file declares and exports and does nothing else.
//
// NO node_modules IMPORTS. reap-probe-clients.mjs runs in the live job, which skips npm
// ci on purpose so the gate still works when install is broken.
//
// These values are published in capsid/core.md and are inert without an API token: an
// assertion, not a credential.

// THE COMPATIBILITY DATE, same string as wrangler.jsonc.example's compatibility_date
// (test/cloudflare-platform.test.ts asserts they agree). 2026-09-06 per the platform
// arc; nodejs_compat is default-on from 2026-08-04, so the explicit flag in the example
// is redundant but kept.
export const COMPATIBILITY_DATE = "2026-09-06";

// THE PER-INVOCATION CPU CEILING, same number as wrangler.jsonc.example's limits.cpu_ms
// (test/cloudflare-platform.test.ts asserts they agree). A runaway invocation is killed
// by the platform at this line, which is the one hard stop budget alerts cannot provide.
//
// Resized 2026-09-07. Measured max cpuTimeMs for the backup trigger is still 1390
// (Workers Observability, 2026-09-01..09-07, n=10), and 1390 * 1.5 = 2085, so the old
// 2100 met its own rule while running out: the backup dumps `document_versions`, which
// has never been pruned and went 25.5MB to 53.9MB in the 23 days to 2026-09-07. First
// 90-day prune lands about 2026-10-04, by which point the table projects to ~87MB and
// the dump to ~2240ms. 2240 * 1.5, rounded. Full derivation in wrangler.jsonc.example.
export const LIMITS = { cpu_ms: 3500 };

export const D1 = { name: "capsid", id: "f24921c8-5e6f-499e-96a1-f124f52f12f7" };

// TWO KV NAMESPACES, asserted INDEPENDENTLY since the 2026-08-15 split. They were one id
// behind two binding names, and ci-config pinned it once; with a single pin and a single
// placeholder CI could not have produced two different ids, so the split would have
// failed on its own deploy.
//
// APP_KV holds ONLY the Worker's own state: the gh:install, gh:token and gh:get caches,
// the backup lease, and the dcr:rate counters. OAUTH_KV holds the provider's
// client/grant/token keys plus capsid:oauth-state.
//
// Resolution elsewhere is by EXACT TITLE and refuses ambiguity: the account also
// contains a namespace literally titled "OAUTH_KV" belonging to dustinedwards-mcp.
export const APP_KV = { name: "capsid-app-kv-v2", id: "21465e558b464cbf893753d2b2cb7829" };
export const OAUTH_KV = { name: "capsid-app-kv", id: "5fac20b95ad541a39f24eb8c5a753b6c" };

export const R2 = { name: "capsid-media" };

// A SECOND R2 BUCKET, holding the improve loop's hidden holdout suites.
//
// Separate from capsid-media rather than a prefix inside it, and the separation is the
// security property: attempt-generating code holds MEDIA and would be physically able to
// read a prefix in it whatever a source scan said. A distinct binding can be withheld
// structurally, which is what src/env.ts's AttemptEnv does. src/improve-scorer.ts is the
// only module in src/ permitted to name it, and test/improve-holdout.test.ts fails the
// build if a second one appears.
//
// CI reads the holdout tests directly from this bucket with its OWN read-only R2 token,
// held as a repo secret. That token is never in the Worker's environment; the Worker
// reads only the manifest.
export const HOLDOUT_R2 = { name: "capsid-improve-holdout" };

// Public identifier. It appears in every OAuth URL the App generates and in wrangler's
// own deploy output. Pinned because wrangler would otherwise write the example's
// placeholder over the live value: keep_vars preserves vars that are ABSENT from config,
// not ones present with a wrong value, and a placeholder client id would break every
// repo tool.
export const GITHUB_APP_CLIENT_ID = "Iv23lik2O8SPPksxbc6O";

// THE LIVE-GATE CANARY, a real OAuth client record that exists only to be read.
//
// On 2026-08-17 a client: record disappeared from OAUTH_KV with no request in the window
// that could account for it; five hypotheses were ruled out and no cause was found.
// Nothing watched that keyspace, so the only way such a loss surfaces is the
// user-visible symptom: 400 on /authorize, invalid_client on /token, whenever the owner
// next connects. Reading this key on every live-gate run bounds time-to-detect at six
// hours.
//
// IT HAS NO EXPIRY. Every /register client carries the 90 day clientRegistrationTTL, and
// a canary that can expire on its own has a SECOND legitimate reason to be absent, which
// is the ambiguity it exists to remove. The TTL policy exists to bound ACCUMULATION from
// open unauthenticated DCR; this is one record, minted once on 2026-08-17, and the gate
// asserts it stays non-expiring.
//
// Minted through the real POST /register path so the record shape is whatever the
// provider library writes, then rewritten byte-identically with the expiry removed:
//   wrangler kv key get "client:<id>" --namespace-id <OAUTH_KV> --remote --text > canary.json
//   wrangler kv key put "client:<id>" --namespace-id <OAUTH_KV> --remote --path canary.json
//
// The reaper cannot touch it: that script deletes only the id recorded in
// PROBE_CLIENT_FILE by gate 2 of the same run, and never lists the namespace.
export const CANARY_CLIENT = {
  id: "eZK0jwhRDvjSc_SN",
  name: "capsid live-gate canary (do not delete; asserted by verify-live gate 2b)",
};

