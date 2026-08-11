#!/usr/bin/env node
// verify-live: exercises capsid's OAuth consent surface against a deployed
// worker. Read-only. Stops at the GitHub 302 and never drives GitHub.
//
// Usage: node scripts/verify-live.mjs [origin]
//        npm run verify:live
//
// Why this exists: on 2026-08-09 the consent flow was found broken for 26 days.
// A "form-action 'self'" CSP landed as a side change in 423bbd6 and silently
// blocked the form submission's redirect to github.com. Nothing detected it,
// because tsc and node --test never touch a live surface.
//
// Two hard requirements, both learned by measurement that day. Violating either
// makes this gate pass against a fully broken server:
//
//   1. FRESH CLIENT EVERY RUN. handleAuthorizeGet short-circuits for a client id
//      already in the capsid_approved cookie and 302s straight out of the GET,
//      never rendering a form. That fast path is exactly what hid the bug: grant
//      WiEb7bF_80YyO88H kept refreshing normally the whole time. So this
//      registers a new client per run and asserts the consent FORM renders. A
//      302 at gate 3 means the fast path was hit and the run is VOID, not green.
//
//   2. POLL, NEVER SINGLE-FETCH, on header assertions. The first post-deploy
//      read returned the previous CSP and would have produced a false pass.
//      Cloudflare propagation is not instant. Gate 4 polls to an expected value.

const ORIGIN = (process.argv[2] ?? "https://capsid.dustin-edwards.workers.dev").replace(/\/$/, "");
const POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(gate, passed, detail) {
  results.push({ gate, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${gate}\n      ${detail}`);
}

// Gate 1: liveness, and deploy provenance. /health returns the git sha stamped
// at deploy time, so this also reports WHICH commit is live. An expected sha can
// be passed to assert it, which is what makes "the deployed worker is this
// commit" checkable instead of inferred from a clean working tree.
async function gateHealth() {
  const expected = process.env.EXPECT_SHA;
  let data = null;
  let attempt = 0;
  for (attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    const resp = await fetch(`${ORIGIN}/health`, { headers: { "Cache-Control": "no-cache" } });
    data = await resp.json().catch(() => null);
    // Keep polling through EVERY not-yet-converged state, including a response
    // that is not JSON at all: immediately after a deploy the previous version
    // is still serving, and before this commit that version answered /health
    // with the plain text "ok". An earlier draft of this loop broke out on a
    // null parse, which defeated the polling it exists for and failed the gate
    // against a deploy that was in fact correct.
    const converged = resp.status === 200 && data?.status === "ok" && (!expected || data.sha === expected);
    if (converged) break;
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  const live = data?.status === "ok";
  const shaOk = !expected || data?.sha === expected;
  const passed = live && shaOk;
  const detail = `status=${data?.status ?? "?"} sha=${(data?.sha ?? "?").slice(0, 8)} dirty=${data?.dirty} polls=${attempt}` +
    (expected ? ` expected=${expected.slice(0, 8)}${shaOk ? " MATCH" : " MISMATCH"}` : "");
  record("1 health + provenance", passed, detail);
  if (data?.dirty) console.log("      NOTE: deployed from a dirty tree; the bytes are not exactly that commit.");
}

// Gate 2: dynamic client registration. Returns a client id never seen before,
// which is what keeps gate 3 off the approved-client fast path.
async function gateRegister() {
  const resp = await fetch(`${ORIGIN}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "capsid verify-live probe",
      redirect_uris: ["https://example.com/verify-live-callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  const data = await resp.json().catch(() => ({}));
  const clientId = data.client_id;
  const passed = resp.ok && typeof clientId === "string" && clientId.length > 0;
  record("2 register (fresh client)", passed, `status=${resp.status} client_id=${clientId ?? "(none)"}`);
  return passed ? clientId : null;
}

function authorizeUrl(clientId) {
  const u = new URL(`${ORIGIN}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", "https://example.com/verify-live-callback");
  u.searchParams.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", "verify-live");
  u.searchParams.set("resource", `${ORIGIN}/mcp`);
  return u.href;
}

// Gate 3: the consent FORM renders. A 302 here means the fast path was taken and
// the whole run is void, so that is reported as VOID rather than a plain fail.
async function gateConsentForm(clientId) {
  const resp = await fetch(authorizeUrl(clientId), { redirect: "manual" });
  if (resp.status >= 300 && resp.status < 400) {
    record("3 consent form renders", false, `VOID: got ${resp.status} redirect, not a form. The fast path was hit, so this run proves nothing. Check that the client id is genuinely new.`);
    return null;
  }
  const html = await resp.text();
  const hasForm = /<form[^>]+method=["']post["'][^>]*action=["']\/authorize["']/i.test(html);
  const csrf = html.match(/name=["']csrf["'][^>]*value=["']([^"']+)["']/i)?.[1];
  const req = html.match(/name=["']req["'][^>]*value=["']([^"']+)["']/i)?.[1];
  const cookie = resp.headers.get("set-cookie") ?? "";
  const csrfCookie = cookie.match(/capsid_csrf=([^;]+)/)?.[1];
  const passed = resp.status === 200 && hasForm && Boolean(csrf) && Boolean(req) && Boolean(csrfCookie);
  record("3 consent form renders", passed, `status=${resp.status} form=${hasForm} csrf_field=${Boolean(csrf)} req_field=${Boolean(req)} csrf_cookie=${Boolean(csrfCookie)}`);
  return passed ? { csrf, req, csrfCookie } : null;
}

// Gate 4: the consent CSP cannot block the form's redirect chain. Polls, because
// a single fetch can read the pre-deploy header and pass falsely.
async function gateCsp(clientId) {
  let csp = null;
  let attempt = 0;
  for (attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    const resp = await fetch(authorizeUrl(clientId), { redirect: "manual" });
    csp = resp.headers.get("content-security-policy");
    if (!csp || !/form-action/i.test(csp)) break;
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  // The consent form's redirect chain terminates at a dynamically registered
  // client redirect_uri, so no static form-action allowlist can be correct.
  // Absent is the ruled state (e7a0dff). Present is a fail regardless of value.
  const passed = !csp || !/form-action/i.test(csp);
  record("4 consent CSP permits the chain", passed, passed ? `polls=${attempt} csp=${csp ?? "(none)"}` : `polls=${attempt} form-action present after ${POLL_ATTEMPTS} polls: ${csp}`);
}

// Gate 4b: Cache-Control is fail-closed on the OAuth surfaces.
async function gateCacheControl(clientId) {
  const surfaces = [
    ["/authorize consent", authorizeUrl(clientId)],
    [".well-known", `${ORIGIN}/.well-known/oauth-authorization-server`],
  ];
  const rows = [];
  let allNoStore = false;
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    rows.length = 0;
    for (const [label, url] of surfaces) {
      const resp = await fetch(url, { redirect: "manual" });
      rows.push([label, resp.headers.get("cache-control")]);
    }
    allNoStore = rows.every(([, cc]) => cc && /no-store/i.test(cc));
    if (allNoStore) break;
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  record("4b cache-control no-store", allNoStore, rows.map(([l, cc]) => `${l}=${cc ?? "(none)"}`).join(" "));
}

// Gate 5: approving the form redirects to GitHub's authorize endpoint. This is
// where the run stops. It never follows the 302 and never touches GitHub.
async function gateGithubRedirect(clientId, form) {
  const body = new URLSearchParams({ csrf: form.csrf, req: form.req });
  const resp = await fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `capsid_csrf=${form.csrfCookie}` },
    body,
    redirect: "manual",
  });
  const location = resp.headers.get("location") ?? "";
  const passed = resp.status === 302 && location.startsWith("https://github.com/login/oauth/authorize");
  const shown = location ? new URL(location).origin + new URL(location).pathname : "(none)";
  record("5 approve redirects to GitHub", passed, `status=${resp.status} location=${shown} (not followed)`);
}

const clientId = await (async () => {
  await gateHealth();
  return gateRegister();
})();

if (clientId) {
  const form = await gateConsentForm(clientId);
  await gateCsp(clientId);
  await gateCacheControl(clientId);
  if (form) await gateGithubRedirect(clientId, form);
  else record("5 approve redirects to GitHub", false, "skipped: gate 3 did not yield a usable form");
} else {
  record("3 consent form renders", false, "skipped: no client id from gate 2");
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} gates passed against ${ORIGIN}`);
if (failed.length) {
  console.log(`FAILED GATES: ${failed.map((f) => f.gate).join(", ")}`);
  process.exit(1);
}
