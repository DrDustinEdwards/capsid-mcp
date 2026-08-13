#!/usr/bin/env node
// Deletes the OAuth client registrations that scripts/verify-live.mjs creates.
//
// WHY THESE EXIST AND WHY THEY MUST KEEP EXISTING. Gate 2 registers a FRESH
// client on every run, and that is load-bearing rather than incidental:
// handleAuthorizeGet short-circuits for a client id already in the approved
// cookie and 302s straight out of the GET without rendering a form. That fast
// path is exactly what hid the 26-day consent outage. A run that reused a client
// id would take the fast path and prove nothing. So the fix for the accumulation
// is NOT to reuse a client; it is to clean up afterwards.
//
// Measured 2026-08-12: 51 keys in the namespace, 44 of them client:*. At the
// six-hourly CI schedule that is roughly 1,460 dead registrations a year.
//
// No wrangler and no node_modules, on purpose. This runs in the live job, which
// deliberately skips npm ci so the gate still works when install is broken, so
// this talks to the KV REST API with global fetch and nothing else.
//
// SAFETY. Two independent conditions must both hold before anything is deleted:
// the key must be under the client: prefix, AND its stored value must carry a
// clientName this file recognises as a probe. grant:, token:,
// capsid:oauth-state: and gh:* are never listed, never read and never touched.
// Deleting is opt-in with --apply; the default is a report.

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
// Pinned, same value and same reasoning as scripts/ci-config.mjs: published in
// capsid/core.md and inert without a token.
const NAMESPACE_ID = "5fac20b95ad541a39f24eb8c5a753b6c";
const APPLY = process.argv.includes("--apply");

// Every client_name this portfolio's probes register under. verify-live.mjs uses
// the first; the second is from a one-off header probe run on 2026-08-12 whose
// registrations are in the same backlog.
const PROBE_NAMES = new Set(["capsid verify-live probe", "header probe"]);

if (!ACCOUNT || !TOKEN) {
  console.error("reap: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required. Refusing to run blind.");
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE_ID}`;
const auth = { Authorization: `Bearer ${TOKEN}` };

async function api(path, init = {}) {
  const resp = await fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} -> ${resp.status} ${body.slice(0, 300)}`);
  }
  return resp;
}

// List only the client: prefix. Nothing else is even enumerated.
const keys = [];
let cursor = "";
do {
  const qs = new URLSearchParams({ prefix: "client:", limit: "1000" });
  if (cursor) qs.set("cursor", cursor);
  const data = await (await api(`/keys?${qs}`)).json();
  keys.push(...data.result.map((k) => k.name));
  cursor = data.result_info?.cursor ?? "";
} while (cursor);

console.log(`reap: ${keys.length} keys under the client: prefix`);

const doomed = [];
const kept = [];
for (const key of keys) {
  let value;
  try {
    value = await (await api(`/values/${encodeURIComponent(key)}`)).json();
  } catch (err) {
    // A key that cannot be read is a key that does not get deleted. Failing
    // toward keeping data is the correct direction for a delete script.
    kept.push(`${key} (unreadable: ${err.message.slice(0, 60)})`);
    continue;
  }
  if (PROBE_NAMES.has(value?.clientName)) doomed.push(key);
  else kept.push(`${key} (${value?.clientName ?? "no clientName"})`);
}

console.log(`reap: ${doomed.length} probe registrations, ${kept.length} real clients kept`);
for (const k of kept) console.log(`  keep ${k}`);

if (doomed.length === 0) {
  console.log("reap: nothing to delete");
  process.exit(0);
}

if (!APPLY) {
  console.log(`reap: DRY RUN. ${doomed.length} would be deleted. Re-run with --apply.`);
  for (const k of doomed) console.log(`  would delete ${k}`);
  process.exit(0);
}

// Bulk delete takes an array of key names.
await api("/bulk", {
  method: "DELETE",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(doomed),
});
console.log(`reap: deleted ${doomed.length} probe client registrations`);
