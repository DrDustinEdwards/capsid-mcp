import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: it
// runs in the live CI job with no npm ci and no build step.
import { canaryReport, checkCanary } from "../scripts/canary-lib.mjs";
// @ts-expect-error same.
import { CANARY_CLIENT, OAUTH_KV } from "../scripts/bindings.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTHORITATIVE } from "../src/counts.ts";

// THE LIVE-GATE CANARY (work queue, from the 2026-08-17 audit).
//
// A client: record vanished from OAUTH_KV that day with no request in the window
// that could account for it. Nothing watched that keyspace, so the only way such a
// loss surfaces is the user-visible symptom: 400 on /authorize, invalid_client on
// /token, whenever the owner next tries to connect. Gate 2b reads one long-lived
// record every run, bounding time-to-detect at the six-hour schedule interval.
//
// THE ASSERTION THAT MATTERS IS NOT "the canary is there". It is that the gate can
// tell WHY it is not there. A check that reports every failure the same way is the
// defect the reaper had, and it is the reason the canary reads KV directly rather
// than driving /authorize: through the Worker, a missing client and a KV outage are
// the same error page.

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

const CLIENT_ID = "canaryTestId123";
const KEY = `client:${CLIENT_ID}`;
const RECORD = JSON.stringify({ clientId: CLIENT_ID, clientName: "canary", redirectUris: ["https://example.com/x"] });

type Reply = { ok: boolean; status: number; text?: () => Promise<string>; json?: () => Promise<unknown> };

// A KV REST API stand-in covering the two endpoints the check uses: the value read
// and the key listing that carries the expiry.
function fakeKvApi(opts: {
  value?: string | null;
  valueStatus?: number;
  expiration?: number;
  throwOnValue?: string;
  listStatus?: number;
  throwOnList?: string;
}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes("/values/")) {
      if (opts.throwOnValue) throw new Error(opts.throwOnValue);
      const status = opts.valueStatus ?? (opts.value == null ? 404 : 200);
      return { ok: status >= 200 && status < 300, status, text: async () => opts.value ?? "" } as Reply;
    }
    // the /keys?prefix= listing
    if (opts.throwOnList) throw new Error(opts.throwOnList);
    if (opts.listStatus && opts.listStatus !== 200) return { ok: false, status: opts.listStatus, json: async () => null } as Reply;
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: [{ name: KEY, ...(opts.expiration ? { expiration: opts.expiration } : {}) }] }),
    } as Reply;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const check = (stub: ReturnType<typeof fakeKvApi>) =>
  checkCanary({ fetchImpl: stub.fetchImpl, base: "https://kv.example/ns", clientId: CLIENT_ID, auth: { Authorization: "Bearer t" } });

test("a present, non-expiring canary passes", async () => {
  const stub = fakeKvApi({ value: RECORD });
  const result = await check(stub);
  assert.equal(result.outcome, "present");
  const report = canaryReport(result, CLIENT_ID, "capsid-app-kv");
  assert.equal(report.passed, true);
  assert.match(report.detail, /non-expiring/);
});

test("a MISSING canary fails, and is named as the 2026-08-17 anomaly recurring", async () => {
  const stub = fakeKvApi({ value: null });
  const result = await check(stub);
  assert.equal(result.outcome, "missing");
  const report = canaryReport(result, CLIENT_ID, "capsid-app-kv");
  assert.equal(report.passed, false);
  assert.match(report.detail, /is GONE from capsid-app-kv/);
  assert.match(report.detail, /vanished-client-record anomaly of 2026-08-17/);
  // It must tell the reader what to do before re-minting, or the evidence is
  // destroyed by the first person trying to fix it.
  assert.match(report.detail, /check whether live grants survived before re-minting/);
});

test("an UNREACHABLE store is NOT reported as data loss", async () => {
  // The distinction the whole gate exists for. A KV blip must not read as a
  // vanished record, or the canary cries wolf and gets ignored, which is worse
  // than not having it.
  for (const stub of [fakeKvApi({ valueStatus: 500, value: RECORD }), fakeKvApi({ throwOnValue: "ECONNRESET" })]) {
    const result = await check(stub);
    assert.equal(result.outcome, "unreachable");
    const report = canaryReport(result, CLIENT_ID, "capsid-app-kv");
    assert.equal(report.passed, false);
    assert.match(report.detail, /NOT evidence the record is gone/);
    assert.doesNotMatch(report.detail, /GONE from/);
  }
});

test("missing and unreachable are genuinely different outcomes", async () => {
  const gone = await check(fakeKvApi({ value: null }));
  const blip = await check(fakeKvApi({ valueStatus: 503, value: RECORD }));
  assert.notEqual(gone.outcome, blip.outcome, "a KV outage and a vanished record are indistinguishable");
});

test("a canary that has acquired a TTL fails BEFORE it can expire", async () => {
  // Re-minting through /register would hand the canary the 90 day
  // clientRegistrationTTL back. A canary that can expire on its own has a second,
  // legitimate reason to be absent, which is the exact ambiguity it removes.
  const stub = fakeKvApi({ value: RECORD, expiration: 1794583009 });
  const result = await check(stub);
  assert.equal(result.outcome, "has-ttl");
  const report = canaryReport(result, CLIENT_ID, "capsid-app-kv");
  assert.equal(report.passed, false);
  assert.match(report.detail, /must not expire/);
  assert.match(report.detail, /2026-11-13/, "the report does not say WHEN it would expire");
});

test("an unreadable key listing is not mistaken for a TTL", async () => {
  // Absence of evidence about the expiry is not evidence of one. Failing here
  // would turn an API hiccup into a false alarm about the alarm.
  //
  // BOTH failure shapes, because they take different paths through the check and a
  // plant proved it: a non-200 listing returns a body the parse yields nothing
  // from, while a THROWN listing lands in the catch. Covering only the first left
  // the catch free to invent an expiry.
  for (const stub of [fakeKvApi({ value: RECORD, listStatus: 500 }), fakeKvApi({ value: RECORD, throwOnList: "ECONNRESET" })]) {
    const result = await check(stub);
    assert.equal(result.outcome, "present", "an unreadable listing was read as an expiry");
    assert.equal(result.expiration, undefined, "an expiry was invented from a failed listing");
  }
});

test("a foreign or truncated value at the right key is not accepted", async () => {
  for (const value of ["", "not json", JSON.stringify({ clientId: "someone-else" })]) {
    const result = await check(fakeKvApi({ value }));
    assert.equal(result.outcome, "corrupt", `${JSON.stringify(value)} was accepted as the canary`);
  }
});

// ---- the wiring ------------------------------------------------------------

test("the canary is pinned, and it is the record that actually exists", () => {
  // Minted 2026-08-17 through the real POST /register path, then re-put with the
  // expiry stripped. The id is pinned in bindings.mjs, which is the one place any
  // Cloudflare identity is written.
  assert.match(CANARY_CLIENT.id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.match(CANARY_CLIENT.name, /do not delete/i, "the record's own name does not warn against deleting it");
  assert.equal(OAUTH_KV.name, "capsid-app-kv");
});

test("gate 2b is wired into the run and counted", () => {
  const gate = read("../scripts/verify-live.mjs");
  assert.match(gate, /await gateCanary\(\);/, "gate 2b is defined but never called");
  // It runs BEFORE the register gate's client is created, so a keyspace-wide loss
  // is reported against a record that predates this run rather than one it just
  // wrote.
  assert.ok(
    gate.indexOf("await gateCanary()") < gate.indexOf("return gateRegister()"),
    "the canary is checked after this run registers its own client"
  );
  // The gate total moved 9 to 10 with this gate. counts.ts is the authority and
  // test/counts.test.ts already compares it to the distinct labels in the script;
  // this asserts the number itself moved, which is the part a reader checks.
  assert.equal(AUTHORITATIVE.capsid.liveGates, 10);
});

test("the credentials the gate needs are supplied to it in CI", () => {
  // Without these the gate SKIPS, and a gate that silently skips in CI is the
  // failure mode this whole item exists to remove.
  const workflow = read("../.github/workflows/ci.yml");
  const step = workflow.slice(workflow.indexOf("- name: verify:live"), workflow.indexOf("- name: Reap this run"));
  assert.match(step, /CLOUDFLARE_API_TOKEN:/, "verify:live cannot read KV, so gate 2b will skip on every CI run");
  assert.match(step, /CLOUDFLARE_ACCOUNT_ID:/);
});
