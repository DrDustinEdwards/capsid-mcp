// The pinned Cloudflare binding identities, in ONE place (quality audit 5.1).
//
// WHY THIS FILE EXISTS. The OAuth KV namespace id was written out twice: once in
// scripts/ci-config.mjs, which asserts the deploy is bound to the right keyspace,
// and once in scripts/reap-probe-clients.mjs, which deletes from that keyspace
// after every live gate run. Rotating the namespace meant remembering both.
// Updating only the first would leave CI deploying against the new namespace
// while the reaper kept issuing DELETEs against the old one: a cleanup pointed at
// a keyspace nobody is writing to, which reports success forever (KV DELETE is
// idempotent) while probe registrations pile up in the namespace that is live.
// Silent in both directions, which is the shape this repo keeps ruling against.
//
// SIDE-EFFECT FREE, DELIBERATELY. ci-config.mjs cannot be the home for these:
// it refuses to run outside CI with process.exit and writes wrangler.jsonc at
// module scope, so importing it would run it. This file declares and exports,
// and does nothing else, so both callers can read it and neither inherits the
// other's behaviour.
//
// NO node_modules IMPORTS, ALSO DELIBERATELY. reap-probe-clients.mjs runs in the
// live job, which skips npm ci on purpose so the gate still works when install is
// broken. Anything this file imports would break that.
//
// These values are published in capsid/core.md and are inert without an API
// token: they are an assertion, not a credential.

export const D1 = { name: "capsid", id: "f24921c8-5e6f-499e-96a1-f124f52f12f7" };

// TWO KV NAMESPACES, asserted INDEPENDENTLY since the 2026-08-15 split. They were
// one id behind two binding names, and ci-config pinned it once; with a single pin
// and a single placeholder CI could not have produced two different ids, so the
// split would have failed on its own deploy.
//
// APP_KV holds ONLY the Worker's own state: the gh:install, gh:token and gh:get
// caches, the backup lease, and the dcr:rate counters.
// OAUTH_KV holds the provider's client/grant/token keys plus capsid:oauth-state.
//
// Resolution elsewhere is by EXACT TITLE and refuses ambiguity, which matters:
// the account also contains a namespace literally titled "OAUTH_KV" belonging to
// dustinedwards-mcp. Neither title below can match it.
export const APP_KV = { name: "capsid-app-kv-v2", id: "21465e558b464cbf893753d2b2cb7829" };
export const OAUTH_KV = { name: "capsid-app-kv", id: "5fac20b95ad541a39f24eb8c5a753b6c" };

export const R2 = { name: "capsid-media" };

// Public identifier. It appears in every OAuth URL the App generates and in
// wrangler's own deploy output. Pinned because wrangler would otherwise write the
// example's placeholder over the live value: keep_vars preserves vars that are
// ABSENT from config, not ones present with a wrong value, and a placeholder
// client id would break every repo tool.
export const GITHUB_APP_CLIENT_ID = "Iv23lik2O8SPPksxbc6O";
