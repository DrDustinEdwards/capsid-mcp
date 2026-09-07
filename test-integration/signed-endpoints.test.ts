import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// THE THREE HMAC SINKS, END TO END, AGAINST A REAL D1 AND A REAL KV.
//
// /improve/score, /improve/holdout-credential and /backup/credential are the only
// unauthenticated-by-OAuth write paths in this Worker. Everything about them lives
// in the seam this layer exists to cover: the key is DERIVED from a root secret,
// the replay cache is an `INSERT ... ON CONFLICT DO NOTHING RETURNING` against a
// real PRIMARY KEY, and the run lookup is a real SELECT. The unit suite proves
// which statements are issued; only this proves SQLite accepts them and that the
// conflict actually conflicts.
//
// The keys below are derived HERE the way the Worker derives them, from the same
// root the config binds, so a signature that verifies does so for the right reason
// rather than because both sides are stubs.

const ROOT = "integration-root-secret-not-a-real-one";
const NAMESPACE = "capsid";

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The two derivations, spelled the way src/improve-scorer.ts spells them. If either
// context string changes, these tests go red, which is the point: a key derivation
// is a contract with five repos and cannot be edited quietly.
const scoreKey = (namespace: string) => hmacHex(ROOT, `capsid-improve-score:v1:${namespace}`);
const backupKey = () => hmacHex(ROOT, "capsid-backup-credential:v1");

async function post(path: string, key: string, body: unknown, overrides: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const signature = await hmacHex(key, `${ts}.${text}`);
  return SELF.fetch(`https://capsid.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Improve-Namespace": NAMESPACE,
      "X-Improve-Timestamp": ts,
      "X-Improve-Signature": signature,
      ...overrides,
    },
    body: text,
  });
}

// /backup/credential reads X-Backup-Timestamp and X-Backup-Signature, not the
// X-Improve-* pair. Two endpoints, two header contracts, and the difference is
// load-bearing rather than incidental: it is what stops a captured improve request
// being replayed at the backup mint.
async function backupPost(key: string, body: unknown) {
  const text = JSON.stringify(body);
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const signature = await hmacHex(key, `${ts}.${text}`);
  return SELF.fetch("https://capsid.test/backup/credential", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Backup-Timestamp": ts,
      "X-Backup-Signature": signature,
    },
    body: text,
  });
}

const report = (jti: string, over: Record<string, unknown> = {}) => ({
  namespace: NAMESPACE,
  run_id: "shakedown",
  attempt_id: "integration",
  head_sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  jti,
  anchors: { build_passes: 1 },
  secondary: { test_pass_rate: 1, lint_count: 0, bundle_size_bytes: 1000 },
  holdout: { total: 30, passed: 30 },
  ci_minutes: 1,
  ...over,
});

describe("/improve/score", () => {
  it("refuses an unsigned post before it looks anything up", async () => {
    const response = await SELF.fetch("https://capsid.test/improve/score", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Improve-Namespace": NAMESPACE },
      body: JSON.stringify(report("unsigned")),
    });
    // 400, not 401: a missing timestamp header is a malformed request rather than
    // a rejected credential, and the distinction is worth pinning because the two
    // failures need different responses from whoever is looking at CI.
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/timestamp header/);
  });

  it("refuses a WRONG signature with 401, which is the credential answer", async () => {
    const text = JSON.stringify(report(crypto.randomUUID()));
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const response = await SELF.fetch("https://capsid.test/improve/score", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Improve-Namespace": NAMESPACE,
        "X-Improve-Timestamp": ts,
        "X-Improve-Signature": "0".repeat(64),
      },
      body: text,
    });
    expect(response.status).toBe(401);
  });

  it("refuses a signature made with another namespace's key", async () => {
    // The per-namespace derivation is what makes a leaked key from one repo useless
    // against another. Signing with foxing's key and claiming to be capsid must not
    // verify.
    const response = await post("/improve/score", await scoreKey("foxing"), report("wrong-key"));
    expect(response.status).toBe(401);
  });

  it("verifies the signature and THEN refuses the unknown run, which is the shakedown contract", async () => {
    // 409 on run_id "shakedown" is the answer CI treats as success: it proves the
    // signature verified (a bad one is 401 before the lookup) and that the run
    // lookup ran against a real database.
    const response = await post("/improve/score", await scoreKey(NAMESPACE), report(crypto.randomUUID()));
    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/unknown run/);
  });

  it("PLANT: a captured, still-in-window report cannot be replayed", async () => {
    // The replay cache is migrations/0004_improve_jti.sql: an INSERT ... ON CONFLICT
    // DO NOTHING RETURNING against a PRIMARY KEY. Nothing in the unit suite can tell
    // whether SQLite honours that conflict; this can, because the table is real.
    const jti = crypto.randomUUID();
    const key = await scoreKey(NAMESPACE);
    const body = report(jti);
    const text = JSON.stringify(body);
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const signature = await hmacHex(key, `${ts}.${text}`);
    const send = () =>
      SELF.fetch("https://capsid.test/improve/score", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Improve-Namespace": NAMESPACE,
          "X-Improve-Timestamp": ts,
          "X-Improve-Signature": signature,
        },
        body: text,
      });

    const first = await send();
    expect(first.status).toBe(409);
    expect(await first.text()).toMatch(/unknown run/);

    // Byte-identical replay of a signature that is still inside its window.
    const second = await send();
    const secondText = await second.text();
    expect(second.status).not.toBe(200);
    expect(secondText).toMatch(/replay|already|jti/i);

    // And the claim really is in the table, rather than the refusal coming from
    // somewhere else that happens to say the same thing.
    const claimed = await env.DB.prepare("SELECT COUNT(*) AS n FROM improve_jti WHERE jti = ?1").bind(jti).first<{ n: number }>();
    expect(claimed?.n).toBe(1);
  });

  it("refuses a timestamp outside the signature window", async () => {
    const key = await scoreKey(NAMESPACE);
    const text = JSON.stringify(report(crypto.randomUUID()));
    const stale = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString().replace(/\.\d+Z$/, "Z");
    const signature = await hmacHex(key, `${stale}.${text}`);
    const response = await SELF.fetch("https://capsid.test/improve/score", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Improve-Namespace": NAMESPACE,
        "X-Improve-Timestamp": stale,
        "X-Improve-Signature": signature,
      },
      body: text,
    });
    expect(response.status).toBe(401);
  });
});

describe("the two credential endpoints", () => {
  it("/improve/holdout-credential verifies the per-namespace key and fails on configuration, not on auth", async () => {
    const response = await post("/improve/holdout-credential", await scoreKey(NAMESPACE), {
      namespace: NAMESPACE,
      jti: crypto.randomUUID(),
    });
    // No R2 temp-credential secrets are bound in this environment, so the mint
    // cannot succeed. What matters is WHICH failure: a 401 would mean the key
    // derivation is wrong, and a 500 naming the missing configuration means the
    // signature verified and the request reached the minting step.
    expect(response.status).not.toBe(401);
    expect(await response.text()).toMatch(/not configured|R2_TEMP_CRED/);
  });

  it("/improve/holdout-credential refuses a request signed with the BACKUP key", async () => {
    // The two derivations are separate on purpose: the holdout parent must not be
    // able to read backups and vice versa. A key that works on one endpoint must
    // not work on the other, and that is a property only an end-to-end call shows.
    const response = await post("/improve/holdout-credential", await backupKey(), {
      namespace: NAMESPACE,
      jti: crypto.randomUUID(),
    });
    expect(response.status).toBe(401);
  });

  it("/backup/credential refuses a request signed with a SCORE key", async () => {
    const response = await backupPost(await scoreKey(NAMESPACE), { jti: crypto.randomUUID() });
    expect(response.status).toBe(401);
  });

  it("/backup/credential accepts its own key and fails on configuration", async () => {
    const response = await backupPost(await backupKey(), { jti: crypto.randomUUID() });
    expect(response.status).not.toBe(401);
    expect(await response.text()).toMatch(/not configured|R2_TEMP_CRED/);
  });

  it("/backup/credential reads its OWN header names, which are not the improve ones", async () => {
    // These are the "HMAC twins" the bloat proposal names: two mint paths with
    // separate parse, verify and header contracts. Whether they should be merged is
    // a separate question; while there are two, a test has to know that sending
    // X-Improve-Timestamp here is a 400 rather than a 401, or a future merge will
    // look like it changed nothing.
    const wrongHeaders = await post("/backup/credential", await backupKey(), { jti: crypto.randomUUID() });
    expect(wrongHeaders.status).toBe(400);
    expect(await wrongHeaders.text()).toMatch(/timestamp header/);
  });
});
